package com.holographic.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BlurMaskFilter
import android.graphics.Color
import android.graphics.Paint
import android.os.SystemClock
import android.util.Log
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.framework.image.ByteBufferExtractor
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.imagesegmenter.ImageSegmenter
import com.google.mediapipe.tasks.vision.imagesegmenter.ImageSegmenterResult
import org.webrtc.*
import java.nio.ByteBuffer

/**
 * WebRTC VideoProcessor — MediaPipe 实时人像分割
 */
class SegmentationProcessor(private val context: Context) : VideoProcessor {

    companion object {
        private const val TAG = "SegmentationProcessor"
        private const val MODEL = "selfie_segmenter.tflite"
        private const val PROCESS_WIDTH = 640
        private const val PROCESS_HEIGHT = 360
        private const val MIN_PROCESS_INTERVAL_MS = 100L
        private const val MASK_BLUR_RADIUS = 4f
    }

    private var maskBitmap: Bitmap? = null
    private var blurredMaskBitmap: Bitmap? = null
    private val maskBlurPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        maskFilter = BlurMaskFilter(MASK_BLUR_RADIUS, BlurMaskFilter.Blur.NORMAL)
    }

    private var sink: VideoSink? = null
    private var segmenter: ImageSegmenter? = null
    private var enabled = false
    private var lastProcessTimeMs = 0L

    init {
        initSegmenter()
    }

    private fun initSegmenter() {
        try {
            val options = ImageSegmenter.ImageSegmenterOptions.builder()
                .setBaseOptions(
                    BaseOptions.builder()
                        .setModelAssetPath(MODEL)
                        .setDelegate(Delegate.GPU)
                        .build()
                )
                .setRunningMode(RunningMode.VIDEO)
                .setOutputCategoryMask(true)
                .setOutputConfidenceMasks(false)
                .build()
            segmenter = ImageSegmenter.createFromOptions(context, options)
            Log.i(TAG, "MediaPipe ImageSegmenter 就绪 (VIDEO + GPU)")
        } catch (e: Exception) {
            Log.w(TAG, "GPU/VIDEO 初始化失败，回退 CPU: ${e.message}")
            try {
                val fallback = ImageSegmenter.ImageSegmenterOptions.builder()
                    .setBaseOptions(
                        BaseOptions.builder()
                            .setModelAssetPath(MODEL)
                            .setDelegate(Delegate.CPU)
                            .build()
                    )
                    .setRunningMode(RunningMode.VIDEO)
                    .setOutputCategoryMask(true)
                    .setOutputConfidenceMasks(false)
                    .build()
                segmenter = ImageSegmenter.createFromOptions(context, fallback)
                Log.i(TAG, "MediaPipe ImageSegmenter 就绪 (VIDEO + CPU)")
            } catch (e2: Exception) {
                Log.e(TAG, "MediaPipe 初始化失败: ${e2.message}")
            }
        }
    }

    fun setEnabled(value: Boolean) {
        enabled = value
    }

    override fun setSink(sink: VideoSink?) {
        this.sink = sink
    }

    override fun onCapturerStarted(success: Boolean) {}
    override fun onCapturerStopped() {}

    override fun onFrameCaptured(frame: VideoFrame) {
        val targetSink = sink
        if (targetSink == null) return

        if (!enabled || segmenter == null) {
            targetSink.onFrame(frame)
            return
        }

        val now = System.currentTimeMillis()
        if (now - lastProcessTimeMs < MIN_PROCESS_INTERVAL_MS) {
            targetSink.onFrame(frame)
            return
        }
        lastProcessTimeMs = now

        try {
            val processed = processFrame(frame)
            targetSink.onFrame(processed)
            processed.release()
        } catch (e: Exception) {
            Log.w(TAG, "分割失败: ${e.message}")
            targetSink.onFrame(frame)
        }
    }

    private fun processFrame(frame: VideoFrame): VideoFrame {
        val i420 = frame.buffer.toI420() ?: return frame
        val w = i420.width
        val h = i420.height

        val fullBitmap = yuvToBitmap(i420)
        i420.release()

        val scaled = Bitmap.createScaledBitmap(fullBitmap, PROCESS_WIDTH, PROCESS_HEIGHT, true)
        val mpImage = BitmapImageBuilder(scaled).build()
        val result = segmenter!!.segmentForVideo(mpImage, SystemClock.uptimeMillis())
        mpImage.close()

        applyCategoryMask(fullBitmap, result, w, h)
        scaled.recycle()

        val outI420 = JavaI420Buffer.allocate(w, h)
        bitmapToYuv(fullBitmap, outI420)
        fullBitmap.recycle()

        return VideoFrame(outI420, frame.rotation, frame.timestampNs)
    }

    private fun applyCategoryMask(
        bitmap: Bitmap,
        result: ImageSegmenterResult,
        w: Int,
        h: Int
    ) {
        if (!result.categoryMask().isPresent) return
        val maskImage = result.categoryMask().get()
        val buffer = ByteBufferExtractor.extract(maskImage).duplicate()
        val mw = maskImage.width
        val mh = maskImage.height
        val blurredMask = buildBlurredMask(buffer, mw, mh) ?: return

        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

        for (y in 0 until h) {
            for (x in 0 until w) {
                val mx = (x * mw / w).coerceIn(0, mw - 1)
                val my = (y * mh / h).coerceIn(0, mh - 1)
                val maskAlpha = blurredMask.getPixel(mx, my) and 0xFF
                val i = y * w + x
                pixels[i] = blendPersonWithGreen(pixels[i], maskAlpha)
            }
        }
        bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
    }

    /** 由 category mask 生成模糊后的 alpha 蒙版，边缘平滑过渡 */
    private fun buildBlurredMask(buffer: ByteBuffer, mw: Int, mh: Int): Bitmap? {
        if (maskBitmap == null || maskBitmap!!.width != mw || maskBitmap!!.height != mh) {
            maskBitmap?.recycle()
            blurredMaskBitmap?.recycle()
            maskBitmap = Bitmap.createBitmap(mw, mh, Bitmap.Config.ARGB_8888)
            blurredMaskBitmap = null
        }

        val rawMask = maskBitmap!!
        val maskPixels = IntArray(mw * mh)
        for (i in 0 until mw * mh) {
            val category = buffer.get(i).toInt() and 0xFF
            maskPixels[i] = if (category == 0) Color.TRANSPARENT else Color.WHITE
        }
        rawMask.setPixels(maskPixels, 0, mw, 0, 0, mw, mh)

        blurredMaskBitmap?.recycle()
        blurredMaskBitmap = rawMask.extractAlpha(maskBlurPaint, intArrayOf(0, 0, 0, 0))
        return blurredMaskBitmap
    }

    private fun blendPersonWithGreen(personColor: Int, maskAlpha: Int): Int {
        if (maskAlpha <= 0) return Color.GREEN
        if (maskAlpha >= 255) return personColor

        val t = maskAlpha / 255f
        val inv = 1f - t
        val r = (Color.red(personColor) * t + Color.red(Color.GREEN) * inv).toInt()
        val g = (Color.green(personColor) * t + Color.green(Color.GREEN) * inv).toInt()
        val b = (Color.blue(personColor) * t + Color.blue(Color.GREEN) * inv).toInt()
        return Color.rgb(r, g, b)
    }

    private fun yuvToBitmap(i420: VideoFrame.I420Buffer): Bitmap {
        val w = i420.width
        val h = i420.height
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val pixels = IntArray(w * h)

        val yBuf = i420.dataY
        val uBuf = i420.dataU
        val vBuf = i420.dataV

        for (row in 0 until h) {
            for (col in 0 until w) {
                val y = (yBuf.get(row * i420.strideY + col).toInt() and 0xFF) - 16
                val u = (uBuf.get((row / 2) * i420.strideU + col / 2).toInt() and 0xFF) - 128
                val v = (vBuf.get((row / 2) * i420.strideV + col / 2).toInt() and 0xFF) - 128
                val r = ((298 * y + 409 * v + 128) shr 8).coerceIn(0, 255)
                val g = ((298 * y - 100 * u - 208 * v + 128) shr 8).coerceIn(0, 255)
                val b = ((298 * y + 516 * u + 128) shr 8).coerceIn(0, 255)
                pixels[row * w + col] = Color.rgb(r, g, b)
            }
        }
        bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
        return bitmap
    }

    private fun bitmapToYuv(bitmap: Bitmap, i420: JavaI420Buffer) {
        val w = bitmap.width
        val h = bitmap.height
        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

        for (row in 0 until h) {
            for (col in 0 until w) {
                val p = pixels[row * w + col]
                val r = (p shr 16) and 0xFF
                val g = (p shr 8) and 0xFF
                val b = p and 0xFF
                val a = (p ushr 24) and 0xFF

                val y = if (a < 128) 16 else ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16
                i420.dataY.put(row * i420.strideY + col, y.coerceIn(0, 255).toByte())

                if (row % 2 == 0 && col % 2 == 0) {
                    val u = if (a < 128) 44 else ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128
                    val v = if (a < 128) 21 else ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128
                    i420.dataU.put((row / 2) * i420.strideU + col / 2, u.coerceIn(0, 255).toByte())
                    i420.dataV.put((row / 2) * i420.strideV + col / 2, v.coerceIn(0, 255).toByte())
                }
            }
        }
    }

    fun release() {
        segmenter?.close()
        segmenter = null
        maskBitmap?.recycle()
        maskBitmap = null
        blurredMaskBitmap?.recycle()
        blurredMaskBitmap = null
    }
}
