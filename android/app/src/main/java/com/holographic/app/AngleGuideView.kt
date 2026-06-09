package com.holographic.app

import android.content.Context
import android.graphics.*
import android.util.AttributeSet
import android.view.View
import kotlin.math.abs

/**
 * 角度指引罗盘 UI
 * 显示管理员发送的目标角度与当前传感器偏差
 */
class AngleGuideView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    private var targetYaw = 0f
    private var targetPitch = 0f
    private var currentYaw = 0f
    private var currentPitch = 0f
    private var message: String? = null

    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 4f
        color = Color.parseColor("#374151")
    }
    private val arrowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#3B82F6")
        strokeWidth = 6f
        strokeCap = Paint.Cap.ROUND
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 36f
    }

    fun updateGuide(yaw: Float, pitch: Float, msg: String?) {
        targetYaw = yaw
        targetPitch = pitch
        message = msg
        invalidate()
    }

    fun updateSensor(yaw: Float, pitch: Float) {
        currentYaw = yaw
        currentPitch = pitch
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val cy = height / 2f
        val radius = minOf(cx, cy) - 20f

        canvas.drawCircle(cx, cy, radius, ringPaint)

        val deltaYaw = targetYaw - currentYaw
        val angle = Math.toRadians(deltaYaw.toDouble()).toFloat()
        val arrowLen = radius * 0.7f
        canvas.drawLine(
            cx, cy,
            cx + arrowLen * kotlin.math.sin(angle),
            cy - arrowLen * kotlin.math.cos(angle),
            arrowPaint
        )

        message?.let { canvas.drawText(it, 20f, height - 40f, textPaint) }

        val aligned = abs(deltaYaw) < 5 && abs(targetPitch - currentPitch) < 5
        if (aligned) {
            textPaint.color = Color.parseColor("#10B981")
            canvas.drawText("✓ 角度已对齐", cx - 80f, cy + radius + 40f, textPaint)
            textPaint.color = Color.WHITE
        }
    }
}
