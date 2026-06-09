package com.holographic.app

import android.Manifest
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.holographic.app.databinding.ActivityMainBinding
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.webrtc.EglBase

class MainActivity : AppCompatActivity(), SensorEventListener {

    private lateinit var binding: ActivityMainBinding
    private var signalingClient: SignalingClient? = null
    private var webrtcManager: WebRTCManager? = null
    private var eglBase: EglBase? = null
    private var localDeviceId: String? = null
    private var isPublishing = false
    private var segmentationEnabled = false
    private var sensorManager: SensorManager? = null
    private var rotationSensor: Sensor? = null
    private var lastSensorReport = 0L

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        if (grants.values.all { it }) {
            Toast.makeText(this, "权限已授予", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(this, "需要摄像头和麦克风权限", Toast.LENGTH_LONG).show()
        }
    }

    private val qrLauncher = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { joinRoom(it.trim()) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        eglBase = EglBase.create()
        sensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
        rotationSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)

        setupUi()
        requestPermissionsIfNeeded()
    }

    private fun setupUi() {
        binding.btnScanJoin.setOnClickListener { scanQrCode() }
        binding.btnStartCast.setOnClickListener { togglePublishing() }
        binding.switchSegmentation.setOnCheckedChangeListener { _, checked ->
            segmentationEnabled = checked
        }
        binding.btnJoinManual.setOnClickListener {
            val roomId = binding.etRoomId.text.toString().trim()
            if (roomId.isNotEmpty()) joinRoom(roomId)
            else Toast.makeText(this, "请输入房间号", Toast.LENGTH_SHORT).show()
        }
    }

    private fun requestPermissionsIfNeeded() {
        if (!PermissionsHelper.allGranted(this)) {
            permissionLauncher.launch(PermissionsHelper.REQUIRED)
        }
    }

    private fun scanQrCode() {
        qrLauncher.launch(ScanOptions().apply {
            setPrompt("扫描房间二维码")
            setBeepEnabled(false)
        })
    }

    private fun joinRoom(roomId: String) {
        if (!PermissionsHelper.allGranted(this)) {
            requestPermissionsIfNeeded()
            return
        }

        Thread {
            try {
                val client = SignalingClient(SignalingConfig.SERVER_URL)
                if (!client.connect()) {
                    runOnUiThread {
                        Toast.makeText(this, "无法连接信令服务器", Toast.LENGTH_LONG).show()
                    }
                    return@Thread
                }

                client.setLatencyCallback { ms ->
                    runOnUiThread { binding.tvLatency.text = "${ms}ms" }
                }
                client.startPing()

                client.onMessage { msg -> runOnUiThread { handleSignalingMessage(msg) } }

                client.send("join", mapOf(
                    "roomId" to roomId,
                    "device" to mapOf(
                        "name" to android.os.Build.MODEL,
                        "type" to "mobile",
                        "role" to "user",
                        "streamTypes" to listOf("camera"),
                        "hasAlpha" to segmentationEnabled
                    )
                ))

                signalingClient = client

                runOnUiThread {
                    binding.tvRoomId.text = "房间: $roomId"
                    binding.statusBar.visibility = View.VISIBLE
                    binding.joinPanel.visibility = View.GONE
                    binding.controlBar.visibility = View.VISIBLE
                }
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "连接失败: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private fun togglePublishing() {
        if (localDeviceId == null) {
            Toast.makeText(this, "请先加入房间", Toast.LENGTH_SHORT).show()
            return
        }

        if (isPublishing) {
            webrtcManager?.stopPublishing()
            isPublishing = false
            binding.btnStartCast.text = "开始投屏"
            sensorManager?.unregisterListener(this)
        } else {
            val egl = eglBase ?: return
            webrtcManager = WebRTCManager(
                context = this,
                signaling = signalingClient!!,
                localRenderer = binding.localPreview,
                remoteRenderer = binding.remotePreview,
                localDeviceId = localDeviceId!!,
                eglBase = egl
            )
            webrtcManager!!.startPublishing(segmentationEnabled)
            isPublishing = true
            binding.btnStartCast.text = "停止投屏"
            binding.remotePreview.visibility = View.VISIBLE
            rotationSensor?.let { sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_UI) }
        }
    }

    private fun handleSignalingMessage(msg: SignalingClient.SignalingMessage) {
        when (msg.type) {
            "joined" -> {
                val device = msg.payload?.getAsJsonObject("device")
                localDeviceId = device?.get("id")?.asString
                val roomId = msg.payload?.get("roomId")?.asString
                binding.tvRoomId.text = "房间: $roomId"
                binding.tvLatency.text = "已连接"
            }
            "angle_guide" -> {
                val payload = msg.payload ?: return
                binding.angleGuideOverlay.visibility = View.VISIBLE
                binding.angleGuideOverlay.updateGuide(
                    payload.get("targetYaw")?.asFloat ?: 0f,
                    payload.get("targetPitch")?.asFloat ?: 0f,
                    payload.get("message")?.asString
                )
            }
            "offer", "answer", "ice", "peer_joined", "subscribe" -> {
                webrtcManager?.handleSignalingMessage(msg)
            }
            "error" -> {
                Toast.makeText(this, msg.payload?.get("message")?.asString ?: "错误", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event?.sensor?.type != Sensor.TYPE_ROTATION_VECTOR) return
        val now = System.currentTimeMillis()
        if (now - lastSensorReport < 500) return
        lastSensorReport = now

        val rotationMatrix = FloatArray(9)
        val orientation = FloatArray(3)
        SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values)
        SensorManager.getOrientation(rotationMatrix, orientation)

        val yaw = Math.toDegrees(orientation[0].toDouble()).toFloat()
        val pitch = Math.toDegrees(orientation[1].toDouble()).toFloat()
        val roll = Math.toDegrees(orientation[2].toDouble()).toFloat()

        binding.angleGuideOverlay.updateSensor(yaw, pitch)

        signalingClient?.send("sensor_report", mapOf(
            "sensor" to mapOf("yaw" to yaw, "pitch" to pitch, "roll" to roll)
        ))
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    override fun onDestroy() {
        super.onDestroy()
        sensorManager?.unregisterListener(this)
        webrtcManager?.release()
        signalingClient?.disconnect()
        eglBase?.release()
    }
}
