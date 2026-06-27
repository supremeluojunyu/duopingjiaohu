package com.holographic.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
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
import java.util.concurrent.atomic.AtomicBoolean

/**
 * WebRTC VideoProcessor — MediaPipe 人像分割 + 绿幕合成
 * 使用 IMAGE 模式（每帧独立），segmenter 可在后台线程预初始化。
 */
class SegmentationProcessor(private val context: Context) : VideoProcessor {

    companion object {
        private const val TAG = "SegmentationProcessor"
        private const val MODEL = "selfie_segmenter.tflite"
        private const val PROCESS_WIDTH = 320
        private const val PROCESS_HEIGHT = 180
        private const val MIN_PROCESS_INTERVAL_MS = 300L
        private const val MIN_PERSON_RATIO = 0.05f
        private const val MASK_BLUR_RADIUS = 4f
    }

    private var maskBitmap: Bitmap? = null
    private var blurredMaskBitmap: Bitmap? = null
    private var compositedBitmap: Bitmap? = null
    private var scaledMaskBitmap: Bitmap? = null

    private val maskBlurPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        maskFilter = BlurMaskFilter(MASK_BLUR_RADIUS, BlurMaskFilter.Blur.NORMAL)
    }
    private val maskXferPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN)
    }

    private var sink: VideoSink? = null
    private var segmenter: ImageSegmenter? = null
    private var enabled = false
    private var lastProcessTimeMs = 0L
    private val initFailed = AtomicBoolean(false)
    private val segmenterLock = Any()

    fun setEnabled(value: Boolean) {
        enabled = value
    }

    /** 在挂载 VideoProcessor 之前于后台线程调用，避免首帧在 capturer 线程初始化导致闪退 */
    fun prepareSegmenter(): Boolean {
        if (segmenter != null) return true
        if (initFailed.get()) return false
        synchronized(segmenterLock) {
            if (segmenter != null) return true
            if (initFailed.get()) return false
            return try {
                val options = ImageSegmenter.ImageSegmenterOptions.builder()
                    .setBaseOptions(
                        BaseOptions.builder()
                            .setModelAssetPath(MODEL)
                            .setDelegate(Delegate.CPU)
                            .build()
                    )
                    .setRunningMode(RunningMode.IMAGE)
                    .setOutputCategoryMask(true)
                    .setOutputConfidenceMasks(false)
                    .build()
                segmenter = ImageSegmenter.createFromOptions(context, options)
                Log.i(TAG, "MediaPipe ImageSegmenter 预初始化成功 (IMAGE 模式)")
                true
            } catch (e: OutOfMemoryError) {
                Log.e(TAG, "MediaPipe 初始化 OOM: ${e.message}")
                initFailed.set(true)
                false
            } catch (e: Exception) {
                Log.e(TAG, "MediaPipe 初始化失败: ${e.message}")
                initFailed.set(true)
                false
            }
        }
    }

    override fun setSink(sink: VideoSink?) {
        this.sink = sink
    }

    override fun onCapturerStarted(success: Boolean) {
        if (!success) Log.e(TAG, "摄像头采集启动失败")
    }

    override fun onCapturerStopped() {}

    override fun onFrameCaptured(frame: VideoFrame) {
        val targetSink = sink
        if (targetSink == null) {
            frame.release()
            return
        }

        if (!enabled || initFailed.get() || segmenter == null) {
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
            frame.release()
            targetSink.onFrame(processed)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "分割 OOM，已禁用抠图: ${e.message}")
            initFailed.set(true)
            releaseSegmenter()
            targetSink.onFrame(frame)
        } catch (e: Exception) {
            Log.w(TAG, "分割失败，透传原帧: ${e.message}")
            targetSink.onFrame(frame)
        } catch (e: Throwable) {
            Log.e(TAG, "分割致命错误，已禁用抠图: ${e.message}")
            initFailed.set(true)
            releaseSegmenter()
            targetSink.onFrame(frame)
        }
    }

    private fun processFrame(frame: VideoFrame): VideoFrame {
        val i420 = frame.buffer.toI420() ?: throw IllegalStateException("无法转换 I420")
        val w = i420.width
        val h = i420.height

        val fullBitmap = yuvToBitmap(i420)
        i420.release()

        val scaled = Bitmap.createScaledBitmap(fullBitmap, PROCESS_WIDTH, PROCESS_HEIGHT, true)
        val mpImage = BitmapImageBuilder(scaled).build()
        val result: ImageSegmenterResult
        synchronized(segmenterLock) {
            result = segmenter!!.segment(mpImage)
        }
        mpImage.close()
        scaled.recycle()

        if (!applyGreenBackground(fullBitmap, result, w, h)) {
            Log.d(TAG, "保留原始画面")
        }

        val outI420 = JavaI420Buffer.allocate(w, h)
        bitmapToYuv(fullBitmap, outI420)
        fullBitmap.recycle()

        return VideoFrame(outI420, frame.rotation, frame.timestampNs)
    }

    /** 绿幕合成，不使用 saveLayer（避免部分 GPU OOM 闪退） */
    private fun applyGreenBackground(
        bitmap: Bitmap,
        result: ImageSegmenterResult,
        w: Int,
        h: Int
    ): Boolean {
        if (!result.categoryMask().isPresent) return false
        val maskImage = result.categoryMask().get()
        val buffer = ByteBufferExtractor.extract(maskImage).duplicate()
        val mw = maskImage.width
        val mh = maskImage.height

        if (!hasEnoughPerson(buffer, mw, mh)) return false

        val maskBitmap = buildBlurredMask(buffer, mw, mh) ?: return false
        val output = ensureCompositedBitmap(w, h)
        val scaledMask = ensureScaledMask(w, h, maskBitmap)

        val canvas = Canvas(output)
        canvas.drawColor(Color.GREEN)
        canvas.drawBitmap(bitmap, 0f, 0f, null)
        canvas.drawBitmap(scaledMask, 0f, 0f, maskXferPaint)

        Canvas(bitmap).drawBitmap(output, 0f, 0f, null)
        return true
    }

    private fun hasEnoughPerson(buffer: ByteBuffer, mw: Int, mh: Int): Boolean {
        var personCount = 0
        var sampled = 0
        val total = mw * mh
        buffer.rewind()
        var i = 0
        while (i < total) {
            if ((buffer.get(i).toInt() and 0xFF) != 0) personCount++
            sampled++
            i += 4
        }
        val ratio = if (sampled > 0) personCount.toFloat() / sampled else 0f
        if (ratio <= MIN_PERSON_RATIO) {
            Log.w(TAG, "人像占比 ${"%.1f".format(ratio * 100)}%，跳过抠图")
            return false
        }
        return true
    }

    private fun ensureCompositedBitmap(w: Int, h: Int): Bitmap {
        if (compositedBitmap == null || compositedBitmap!!.width != w || compositedBitmap!!.height != h) {
            compositedBitmap?.recycle()
            compositedBitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        }
        return compositedBitmap!!
    }

    private fun ensureScaledMask(w: Int, h: Int, source: Bitmap): Bitmap {
        if (scaledMaskBitmap == null || scaledMaskBitmap!!.width != w || scaledMaskBitmap!!.height != h) {
            scaledMaskBitmap?.recycle()
            scaledMaskBitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        }
        val canvas = Canvas(scaledMaskBitmap!!)
        canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
        canvas.drawBitmap(source, null, Rect(0, 0, w, h), null)
        return scaledMaskBitmap!!
    }

    private fun buildBlurredMask(buffer: ByteBuffer, mw: Int, mh: Int): Bitmap? {
        if (maskBitmap == null || maskBitmap!!.width != mw || maskBitmap!!.height != mh) {
            maskBitmap?.recycle()
            blurredMaskBitmap?.recycle()
            maskBitmap = Bitmap.createBitmap(mw, mh, Bitmap.Config.ARGB_8888)
            blurredMaskBitmap = null
        }

        val rawMask = maskBitmap!!
        val maskPixels = IntArray(mw * mh)
        buffer.rewind()
        for (i in 0 until mw * mh) {
            val category = buffer.get(i).toInt() and 0xFF
            maskPixels[i] = if (category == 0) Color.TRANSPARENT else Color.WHITE
        }
        rawMask.setPixels(maskPixels, 0, mw, 0, 0, mw, mh)

        blurredMaskBitmap?.recycle()
        blurredMaskBitmap = rawMask.extractAlpha(maskBlurPaint, intArrayOf(0, 0, 0, 0))
        return blurredMaskBitmap
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

                val y = ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16
                i420.dataY.put(row * i420.strideY + col, y.coerceIn(0, 255).toByte())

                if (row % 2 == 0 && col % 2 == 0) {
                    val u = ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128
                    val v = ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128
                    i420.dataU.put((row / 2) * i420.strideU + col / 2, u.coerceIn(0, 255).toByte())
                    i420.dataV.put((row / 2) * i420.strideV + col / 2, v.coerceIn(0, 255).toByte())
                }
            }
        }
    }

    private fun releaseSegmenter() {
        synchronized(segmenterLock) {
            try {
                segmenter?.close()
            } catch (e: Exception) {
                Log.w(TAG, "关闭 segmenter 失败: ${e.message}")
            }
            segmenter = null
        }
    }

    fun release() {
        releaseSegmenter()
        maskBitmap?.recycle()
        maskBitmap = null
        blurredMaskBitmap?.recycle()
        blurredMaskBitmap = null
        compositedBitmap?.recycle()
        compositedBitmap = null
        scaledMaskBitmap?.recycle()
        scaledMaskBitmap = null
        initFailed.set(false)
    }
}
