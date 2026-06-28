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
import androidx.appcompat.app.AlertDialog
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.holographic.app.databinding.ActivityMainBinding
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.webrtc.EglBase
import java.util.concurrent.CopyOnWriteArraySet

class MainActivity : AppCompatActivity(), SensorEventListener {

    private lateinit var binding: ActivityMainBinding
    private var signalingClient: SignalingClient? = null
    private var webrtcManager: WebRTCManager? = null
    private var eglBase: EglBase? = null
    private var localDeviceId: String? = null
    private var isPublishing = false
    private var segmentationEnabled = false
    private val knownDeviceIds = CopyOnWriteArraySet<String>()
    private var sensorManager: SensorManager? = null
    private var rotationSensor: Sensor? = null
    private var lastSensorReport = 0L
    private var isJoining = false

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
        result.contents?.let { handleScanContent(it) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        sensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
        rotationSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)

        setupUi()
        requestPermissionsIfNeeded()
        checkForAppUpdate(showNoUpdateToast = false)
    }

    private fun setupUi() {
        binding.btnScanJoin.setOnClickListener { scanQrCode() }
        binding.btnCheckUpdate.setOnClickListener { checkForAppUpdate(showNoUpdateToast = true) }
        binding.btnStartCast.setOnClickListener { togglePublishing() }
        binding.switchSegmentation.setOnCheckedChangeListener { _, checked ->
            segmentationEnabled = checked
        }
        binding.btnJoinManual.setOnClickListener {
            val roomId = binding.etRoomId.text.toString().trim().uppercase()
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
            setPrompt("扫描房间或下载二维码")
            setBeepEnabled(false)
        })
    }

    private fun handleScanContent(content: String) {
        when (val parsed = QrContentParser.parse(content)) {
            is QrContentParser.ScanResult.JoinRoom -> {
                parsed.serverUrl?.let { url ->
                    binding.etServerUrl.setText(url)
                    SignalingConfig.setServerUrl(url)
                }
                joinRoom(parsed.roomId)
            }
            is QrContentParser.ScanResult.DownloadPage -> checkForAppUpdate(showNoUpdateToast = true)
        }
    }

    private fun resolveServerUrl(): String {
        val raw = binding.etServerUrl.text.toString().trim()
        return if (raw.isNotEmpty()) {
            SignalingConfig.setServerUrl(raw)
            SignalingConfig.getServerUrl()
        } else {
            SignalingConfig.getServerUrl()
        }
    }

    private fun checkForAppUpdate(showNoUpdateToast: Boolean) {
        Thread {
            val release = AppUpdateChecker.fetchRelease(resolveServerUrl())
            val localCode = BuildConfig.VERSION_CODE
            runOnUiThread {
                if (release == null) {
                    if (showNoUpdateToast) {
                        Toast.makeText(this, "无法检查更新", Toast.LENGTH_SHORT).show()
                    }
                    return@runOnUiThread
                }
                if (!release.available || release.downloadUrl.isNullOrBlank()) {
                    if (showNoUpdateToast) {
                        Toast.makeText(this, "服务器暂未发布 APK", Toast.LENGTH_SHORT).show()
                    }
                    return@runOnUiThread
                }
                if (release.versionCode > localCode) {
                    AlertDialog.Builder(this)
                        .setTitle("发现新版本 v${release.versionName}")
                        .setMessage(release.releaseNotes.ifBlank { "是否下载并安装？" })
                        .setPositiveButton("下载") { _, _ ->
                            AppUpdateChecker.openDownloadUrl(this, release.downloadUrl!!)
                        }
                        .setNegativeButton("稍后", null)
                        .show()
                } else if (showNoUpdateToast) {
                    Toast.makeText(this, "已是最新版本", Toast.LENGTH_SHORT).show()
                }
            }
        }.start()
    }

    private fun setJoinUiEnabled(enabled: Boolean) {
        binding.btnJoinManual.isEnabled = enabled
        binding.btnScanJoin.isEnabled = enabled
        binding.etRoomId.isEnabled = enabled
        binding.etServerUrl.isEnabled = enabled
    }

    private fun finishJoinAttempt() {
        isJoining = false
        setJoinUiEnabled(true)
    }

    private fun joinRoom(roomId: String) {
        if (isJoining) return
        if (signalingClient != null) {
            Toast.makeText(this, "已在连接或已加入房间", Toast.LENGTH_SHORT).show()
            return
        }

        val normalizedRoomId = roomId.trim().uppercase()
        if (normalizedRoomId.isEmpty()) {
            Toast.makeText(this, "请输入房间号", Toast.LENGTH_SHORT).show()
            return
        }
        if (!PermissionsHelper.allGranted(this)) {
            requestPermissionsIfNeeded()
            return
        }

        val serverUrl = binding.etServerUrl.text.toString().trim()
        if (serverUrl.isEmpty()) {
            Toast.makeText(this, "请输入信令服务器地址", Toast.LENGTH_SHORT).show()
            return
        }
        SignalingConfig.setServerUrl(serverUrl)

        isJoining = true
        setJoinUiEnabled(false)

        Thread {
            var client: SignalingClient? = null
            try {
                val joinPayload = mapOf(
                    "roomId" to normalizedRoomId,
                    "device" to mapOf(
                        "name" to android.os.Build.MODEL,
                        "type" to "mobile",
                        "role" to "user",
                        "streamTypes" to listOf("camera"),
                        "hasAlpha" to segmentationEnabled
                    )
                )

                client = SignalingClient(SignalingConfig.getServerUrl())
                client.setJoinPayload(joinPayload)
                client.onMessage { msg -> runOnUiThread { handleSignalingMessage(msg) } }

                if (!client.connect()) {
                    client.disconnect()
                    runOnUiThread {
                        Toast.makeText(this, "无法连接信令服务器", Toast.LENGTH_LONG).show()
                        finishJoinAttempt()
                    }
                    return@Thread
                }

                client.setLatencyCallback { ms ->
                    runOnUiThread { binding.tvLatency.text = "${ms}ms" }
                }
                client.setReconnectExhaustedCallback {
                    runOnUiThread {
                        binding.tvLatency.text = "已断开"
                        Toast.makeText(
                            this,
                            "信令连接已断开，请检查网络后重新加入房间",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
                client.startPing()
                signalingClient = client
            } catch (e: Exception) {
                client?.disconnect()
                runOnUiThread {
                    Toast.makeText(this, "连接失败: ${e.message}", Toast.LENGTH_LONG).show()
                    finishJoinAttempt()
                }
            }
        }.start()
    }

    private fun ensureWebRtcManager() {
        if (webrtcManager != null || localDeviceId == null || signalingClient == null) return
        if (eglBase == null) {
            eglBase = EglBase.create()
        }
        webrtcManager = WebRTCManager(
            context = this,
            signaling = signalingClient!!,
            localRenderer = binding.localPreview,
            remoteRenderer = binding.remotePreview,
            localDeviceId = localDeviceId!!,
            eglBase = eglBase!!
        )
        webrtcManager!!.ensureReceiveReady()
        webrtcManager!!.setKnownPeerIds(knownDeviceIds.toSet())
    }

    private fun notifyPublishStarted(): Boolean {
        val payload = mapOf("hasAlpha" to segmentationEnabled)
        val started = signalingClient?.send("publish_started", payload) == true
        if (started) {
            // device_update 失败不影响 EXE 收到 publish_started
            signalingClient?.send("device_update", payload)
        }
        return started
    }

    private fun togglePublishing() {
        if (localDeviceId == null) {
            Toast.makeText(this, "请先加入房间", Toast.LENGTH_SHORT).show()
            return
        }

        if (isPublishing) {
            webrtcManager?.stopPublishing()
            webrtcManager?.releaseLocalPreviewRenderer()
            isPublishing = false
            signalingClient?.send("publish_stopped", emptyMap())
            binding.btnStartCast.text = "开始投屏"
            binding.localPreview.visibility = View.GONE
            binding.tvEmptyHint.visibility = View.VISIBLE
            sensorManager?.unregisterListener(this)
        } else {
            if (!PermissionsHelper.allGranted(this)) {
                Toast.makeText(this, "需要摄像头和麦克风权限", Toast.LENGTH_LONG).show()
                requestPermissionsIfNeeded()
                return
            }
            binding.btnStartCast.isEnabled = false
            Thread {
                try {
                    val iceServers = IceConfigFetcher.fetch(SignalingConfig.getServerUrl())
                    runOnUiThread {
                        binding.btnStartCast.isEnabled = true
                        ensureWebRtcManager()
                        val manager = webrtcManager
                        if (manager == null) {
                            Toast.makeText(this, "连接未就绪，请稍后再试", Toast.LENGTH_SHORT).show()
                            return@runOnUiThread
                        }
                        manager.setIceServers(iceServers)
                        manager.setKnownPeerIds(knownDeviceIds.toSet())
                        binding.localPreview.visibility = View.VISIBLE
                        binding.tvEmptyHint.visibility = View.GONE
                        binding.remotePreview.visibility = View.GONE
                        binding.localPreview.bringToFront()
                        binding.localPreview.requestLayout()
                        manager.ensureLocalPreviewReady()
                        binding.localPreview.post {
                            manager.startPublishing(segmentationEnabled) { ok ->
                                if (!ok) {
                                    binding.localPreview.visibility = View.GONE
                                    binding.tvEmptyHint.visibility = View.VISIBLE
                                    Toast.makeText(this, "无法打开摄像头，请检查权限", Toast.LENGTH_LONG).show()
                                    return@startPublishing
                                }
                                isPublishing = true
                                binding.btnStartCast.text = "停止投屏"
                                manager.refreshLocalPreview()
                                if (!notifyPublishStarted()) {
                                    Toast.makeText(
                                        this,
                                        "信令已断开，投屏状态可能未同步",
                                        Toast.LENGTH_LONG
                                    ).show()
                                }
                                webrtcManager?.flushPendingOffers()
                                rotationSensor?.let {
                                    sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_UI)
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        binding.btnStartCast.isEnabled = true
                        Toast.makeText(this, "投屏失败: ${e.message}", Toast.LENGTH_LONG).show()
                    }
                }
            }.start()
        }
    }

    private fun applyRoomStateSync(msg: SignalingClient.SignalingMessage) {
        if (isPublishing) return
        msg.payload?.getAsJsonArray("publishers")?.forEach { el ->
            val obj = el.asJsonObject
            val publisherId = obj.get("deviceId")?.asString ?: return@forEach
            if (publisherId == localDeviceId) return@forEach
            knownDeviceIds.add(publisherId)
            ensureWebRtcManager()
            webrtcManager?.noteAwaitingPublisher(publisherId)
        }
    }

    private fun handleSignalingMessage(msg: SignalingClient.SignalingMessage) {
        when (msg.type) {
            "joined" -> {
                isJoining = false
                val device = msg.payload?.getAsJsonObject("device")
                localDeviceId = device?.get("id")?.asString
                val serverRoomId = msg.payload?.get("roomId")?.asString
                binding.tvRoomId.text = "房间: $serverRoomId"
                binding.tvLatency.text = "已连接"
                binding.statusBar.visibility = View.VISIBLE
                binding.joinPanel.visibility = View.GONE
                binding.controlBar.visibility = View.VISIBLE
                binding.tvEmptyHint.visibility = View.VISIBLE
                binding.localPreview.visibility = View.GONE
                setJoinUiEnabled(true)

                // 重连时使用服务端确认的房间号，避免与电脑端不一致
                serverRoomId?.let { rid ->
                    binding.etRoomId.setText(rid)
                    signalingClient?.setJoinPayload(
                        mapOf(
                            "roomId" to rid,
                            "device" to mapOf(
                                "name" to android.os.Build.MODEL,
                                "type" to "mobile",
                                "role" to "user",
                                "streamTypes" to listOf("camera"),
                                "hasAlpha" to segmentationEnabled
                            )
                        )
                    )
                }

                knownDeviceIds.clear()
                val selfId = localDeviceId
                msg.payload?.getAsJsonArray("devices")?.forEach { el ->
                    el.asJsonObject.get("id")?.asString?.let { id ->
                        if (id != selfId) knownDeviceIds.add(id)
                    }
                }
                localDeviceId?.let { id ->
                    if (webrtcManager != null) {
                        webrtcManager?.updateLocalDeviceId(id)
                    } else {
                        ensureWebRtcManager()
                    }
                }
                val shouldRenegotiate = isPublishing
                Thread {
                    val iceServers = IceConfigFetcher.fetch(SignalingConfig.getServerUrl())
                    runOnUiThread {
                        webrtcManager?.resetPeerConnections()
                        webrtcManager?.setIceServers(iceServers)
                        webrtcManager?.setKnownPeerIds(knownDeviceIds.toSet())
                        if (shouldRenegotiate) {
                            signalingClient?.send(
                                "publish_started",
                                mapOf("hasAlpha" to segmentationEnabled)
                            )
                            signalingClient?.send(
                                "device_update",
                                mapOf("hasAlpha" to segmentationEnabled)
                            )
                            webrtcManager?.flushPendingOffers()
                        }
                        signalingClient?.send("sync_room_state", emptyMap())
                    }
                }.start()
            }
            "room_state_sync" -> applyRoomStateSync(msg)
            "peer_joined" -> {
                val deviceId = msg.payload?.getAsJsonObject("device")?.get("id")?.asString
                if (deviceId != null) {
                    knownDeviceIds.add(deviceId)
                    ensureWebRtcManager()
                    webrtcManager?.notePeerJoined(deviceId)
                    webrtcManager?.handleSignalingMessage(msg)
                }
            }
            "peer_left" -> {
                val deviceId = msg.payload?.get("deviceId")?.asString ?: return
                knownDeviceIds.remove(deviceId)
                webrtcManager?.closePeer(deviceId)
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
            "offer", "answer", "ice", "subscribe" -> {
                ensureWebRtcManager()
                webrtcManager?.handleSignalingMessage(msg)
            }
            "error" -> {
                Toast.makeText(this, msg.payload?.get("message")?.asString ?: "错误", Toast.LENGTH_SHORT).show()
                if (localDeviceId == null) {
                    signalingClient?.disconnect()
                    signalingClient = null
                    binding.joinPanel.visibility = View.VISIBLE
                    binding.controlBar.visibility = View.GONE
                    binding.statusBar.visibility = View.GONE
                    finishJoinAttempt()
                }
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
