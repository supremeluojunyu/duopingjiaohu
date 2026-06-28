package com.holographic.app

import android.content.Context
import android.os.Looper
import android.util.Log
import android.view.SurfaceHolder
import android.view.View
import android.view.ViewTreeObserver
import com.google.gson.JsonObject
import org.webrtc.*
import org.webrtc.PeerConnection.IceServer
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * WebRTC 管理器 — 摄像头采集、推流、接收远端画面
 */
class WebRTCManager(
    context: Context,
    private val signaling: SignalingClient,
    private val localRenderer: SurfaceViewRenderer,
    private val remoteRenderer: SurfaceViewRenderer?,
    private var localDeviceId: String,
    private val eglBase: EglBase
) {
    companion object {
        private const val TAG = "WebRTCManager"
        private const val STREAM_TYPE = "camera"
        private const val CAPTURE_WIDTH = 640
        private const val CAPTURE_HEIGHT = 480
        private const val CAPTURE_FPS = 24
        private const val SEGMENTATION_DELAY_MS = 3000L
        private val FALLBACK_ICE = listOf(
            IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
            IceServer.builder("stun:stun2.l.google.com:19302").createIceServer(),
            IceServer.builder("stun:stun3.l.google.com:19302").createIceServer(),
            IceServer.builder("stun:stun4.l.google.com:19302").createIceServer(),
            IceServer.builder("stun:stun.qq.com:3478").createIceServer(),
            IceServer.builder("stun:stun.qq.com:19302").createIceServer(),
            IceServer.builder("turn:openrelay.metered.ca:80")
                .setUsername("openrelayproject")
                .setPassword("openrelayproject")
                .createIceServer(),
            IceServer.builder("turn:openrelay.metered.ca:443")
                .setUsername("openrelayproject")
                .setPassword("openrelayproject")
                .createIceServer(),
            IceServer.builder("turn:openrelay.metered.ca:443?transport=tcp")
                .setUsername("openrelayproject")
                .setPassword("openrelayproject")
                .createIceServer()
        )
    }

    private val appContext = context.applicationContext
    private val mainHandler = android.os.Handler(Looper.getMainLooper())

    private var factory: PeerConnectionFactory? = null
    private var localVideoTrack: VideoTrack? = null
    private var localAudioTrack: AudioTrack? = null
    private var videoCapturer: CameraVideoCapturer? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    private val peerConnections = mutableMapOf<String, PeerConnection>()
    private val pendingIce = mutableMapOf<String, MutableList<IceCandidate>>()
    private var isPublishing = false
    private var segmentationProcessor: SegmentationProcessor? = null
    private var segmentationPending = false
    private var receiveReady = false
    private var remoteRendererInitialized = false
    private val knownPeerIds = CopyOnWriteArraySet<String>()
    private val pendingSubscribers = CopyOnWriteArraySet<String>()
    /** 曾发送 subscribe 的订阅方；用于重连/重建连接时补发 offer */
    private val activeSubscribers = CopyOnWriteArraySet<String>()
    /** ICE 直连失败后强制 TURN relay */
    private val relayOnlyPeers = CopyOnWriteArraySet<String>()
    /** 已成功 gather relay 候选（无 relay 时不切 relay-only，避免国内 openrelay 不可用） */
    private val relayReadyPeers = CopyOnWriteArraySet<String>()
    private val lastIceRecoveryMs = mutableMapOf<String, Long>()
    private val iceRecoveryCounts = mutableMapOf<String, Int>()
    private val makingOffer = mutableSetOf<String>()
    private val pendingOfferRetries = mutableMapOf<String, Runnable>()
    private var localRendererInitialized = false
    private var released = false

    private inline fun safeRelease(label: String, block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            Log.w(TAG, "$label 释放失败: ${e.message}")
        }
    }

    private fun runOnMainThread(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            block()
            return
        }
        val latch = CountDownLatch(1)
        mainHandler.post {
            try {
                block()
            } finally {
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
    }

    private fun initRemoteRendererOnMainThread() {
        if (remoteRendererInitialized || remoteRenderer == null) return
        remoteRenderer.init(eglBase.eglBaseContext, null)
        remoteRenderer.setMirror(false)
        remoteRenderer.setEnableHardwareScaler(true)
        remoteRendererInitialized = true
    }

    /** SurfaceView 从 GONE 恢复后必须 release 再 init，否则预览黑屏 */
    fun releaseLocalPreviewRenderer() {
        runOnMainThread {
            localVideoTrack?.removeSink(localRenderer)
            if (localRendererInitialized) {
                try {
                    localRenderer.release()
                } catch (e: Exception) {
                    Log.w(TAG, "释放本地渲染器失败: ${e.message}")
                }
                localRendererInitialized = false
                Log.i(TAG, "本地渲染器已 release，等待下次绑定")
            }
        }
    }

    private fun initLocalRendererOnMainThread() {
        if (localRendererInitialized) return
        localRenderer.init(eglBase.eglBaseContext, null)
        localRenderer.setMirror(true)
        localRenderer.setEnableHardwareScaler(true)
        localRenderer.setZOrderMediaOverlay(true)
        localRenderer.setZOrderOnTop(false)
        localRendererInitialized = true
        Log.i(TAG, "本地渲染器已 init (${localRenderer.width}x${localRenderer.height})")
    }

    /** Surface 就绪后 init/addSink；轮询 + layout + SurfaceHolder 三保险 */
    private fun bindLocalPreviewWhenReady(videoTrack: VideoTrack) {
        runOnMainThread {
            if (localRenderer.visibility != View.VISIBLE) {
                localRenderer.visibility = View.VISIBLE
            }
            var bound = false
            var layoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null
            var surfaceCallback: SurfaceHolder.Callback? = null

            fun cleanupListeners() {
                layoutListener?.let { listener ->
                    if (localRenderer.viewTreeObserver.isAlive) {
                        localRenderer.viewTreeObserver.removeOnGlobalLayoutListener(listener)
                    }
                }
                layoutListener = null
                surfaceCallback?.let { cb ->
                    try {
                        localRenderer.holder.removeCallback(cb)
                    } catch (_: Exception) {
                    }
                }
                surfaceCallback = null
            }

            fun doBind(force: Boolean = false): Boolean {
                if (bound) return true
                if (!force && (localRenderer.width <= 0 || localRenderer.height <= 0)) return false
                initLocalRendererOnMainThread()
                videoTrack.removeSink(localRenderer)
                videoTrack.addSink(localRenderer)
                localRenderer.requestLayout()
                bound = true
                cleanupListeners()
                Log.i(
                    TAG,
                    "本地预览已绑定 (${localRenderer.width}x${localRenderer.height}, force=$force)"
                )
                castLog("preview", "本地预览已绑定 ${localRenderer.width}x${localRenderer.height}")
                return true
            }

            localRenderer.requestLayout()
            if (doBind()) return@runOnMainThread

            var attempts = 0
            val retry = object : Runnable {
                override fun run() {
                    if (bound || localVideoTrack !== videoTrack) return
                    if (doBind()) return
                    attempts++
                    if (attempts >= 5 && doBind(force = true)) return
                    if (attempts < 30) {
                        mainHandler.postDelayed(this, 200)
                    } else if (!doBind(force = true)) {
                        castError("preview", "本地预览绑定失败，Surface 可能未就绪")
                    }
                }
            }
            mainHandler.postDelayed(retry, 100)

            layoutListener = object : ViewTreeObserver.OnGlobalLayoutListener {
                override fun onGlobalLayout() {
                    doBind()
                }
            }
            localRenderer.viewTreeObserver.addOnGlobalLayoutListener(layoutListener)

            surfaceCallback = object : SurfaceHolder.Callback {
                override fun surfaceCreated(holder: SurfaceHolder) {
                    doBind()
                }

                override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                    if (width > 0 && height > 0) doBind()
                }

                override fun surfaceDestroyed(holder: SurfaceHolder) {
                    releaseLocalPreviewRenderer()
                }
            }
            localRenderer.holder.addCallback(surfaceCallback)
        }
    }

    private var iceServers: List<IceServer> = emptyList()

    fun setIceServers(servers: List<IceServer>) {
        if (servers.isEmpty()) return
        iceServers = servers
        if (peerConnections.isEmpty()) return
        val rtcConfig = PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        peerConnections.values.forEach { pc ->
            try {
                pc.setConfiguration(rtcConfig)
            } catch (e: Exception) {
                Log.w(TAG, "更新 ICE 配置失败: ${e.message}")
            }
        }
    }

    private fun activeIceServers(): List<IceServer> {
        return if (iceServers.isNotEmpty()) iceServers else FALLBACK_ICE
    }

    fun ensureReceiveReady() {
        if (receiveReady) return
        runOnMainThread {
            if (receiveReady) return@runOnMainThread
            try {
                initializeFactory()
                receiveReady = true
                Log.i(TAG, "PeerConnectionFactory 已就绪")
            } catch (e: Exception) {
                Log.e(TAG, "接收通道初始化失败", e)
            }
        }
    }

    fun updateLocalDeviceId(newId: String) {
        localDeviceId = newId
        knownPeerIds.remove(newId)
    }

    fun setKnownPeerIds(ids: Collection<String>) {
        knownPeerIds.clear()
        knownPeerIds.addAll(ids.filter { it != localDeviceId })
    }

    fun notePeerJoined(peerId: String) {
        if (peerId != localDeviceId) knownPeerIds.add(peerId)
    }

    fun ensureLocalPreviewReady() {
        runOnMainThread {
            if (localRenderer.visibility == View.VISIBLE &&
                localRenderer.width > 0 &&
                localRenderer.height > 0
            ) {
                initLocalRendererOnMainThread()
            }
        }
    }

    /** Surface 从 GONE 恢复可见后需重新绑定，否则预览可能黑屏 */
    fun refreshLocalPreview() {
        val track = localVideoTrack ?: return
        bindLocalPreviewWhenReady(track)
    }

    fun startPublishing(enableSegmentation: Boolean, callback: (Boolean) -> Unit) {
        if (isPublishing) {
            callback(true)
            return
        }
        ensureReceiveReady()
        mainHandler.post {
            val ok = startPublishingInternal(enableSegmentation)
            callback(ok)
        }
    }

    /** @deprecated 内部使用 callback 版本 */
    fun startPublishing(enableSegmentation: Boolean): Boolean {
        if (isPublishing) return true
        var result = false
        val latch = CountDownLatch(1)
        startPublishing(enableSegmentation) { ok ->
            result = ok
            latch.countDown()
        }
        latch.await(15, TimeUnit.SECONDS)
        return result
    }

    private fun sendOnlyMediaConstraints() = MediaConstraints().apply {
        mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
    }

    private fun logTransceivers(pc: PeerConnection, label: String) {
        val lines = pc.transceivers.mapIndexed { i, t ->
            "[$i] mid=${t.mid} dir=${t.direction} media=${t.mediaType} " +
                "sender=${t.sender.track()?.kind() ?: "none"} recv=${t.receiver.track()?.kind() ?: "none"}"
        }
        Log.i(TAG, "$label transceivers(${pc.transceivers.size}): ${lines.joinToString("; ")}")
    }

    private fun logVideoMLineDirection(sdp: String) {
        val videoLine = sdp.lineSequence().firstOrNull { it.startsWith("m=video") } ?: "none"
        val directions = Regex("a=(sendrecv|sendonly|recvonly|inactive)")
            .findAll(sdp)
            .map { it.groupValues[1] }
            .joinToString(",")
        Log.i(TAG, "offer video m-line: $videoLine | directions: ${directions.ifEmpty { "unknown" }}")
    }

    private fun castLog(step: String, message: String) {
        Log.i(TAG, "[cast:$step] $message")
    }

    private fun castWarn(step: String, message: String) {
        Log.w(TAG, "[cast:$step] $message")
    }

    private fun castError(step: String, message: String) {
        Log.e(TAG, "[cast:$step] $message")
    }

    private fun startPublishingInternal(enableSegmentation: Boolean): Boolean {
        if (isPublishing) return true
        return try {
            if (factory == null) {
                initializeFactory()
                receiveReady = true
            }
            val peerFactory = factory ?: run {
                castError("preview", "PeerConnectionFactory 未初始化")
                return false
            }

            val capturer = createCameraCapturer() ?: run {
                castError("preview", "无法打开摄像头，检查权限与占用")
                return false
            }
            videoCapturer = capturer

            val textureHelper = SurfaceTextureHelper.create("CaptureThread", eglBase.eglBaseContext)
            surfaceTextureHelper?.dispose()
            surfaceTextureHelper = textureHelper
            val source = peerFactory.createVideoSource(false)
            videoSource = source
            capturer.initialize(textureHelper, appContext, source.capturerObserver)
            capturer.startCapture(CAPTURE_WIDTH, CAPTURE_HEIGHT, CAPTURE_FPS)
            castLog("preview", "摄像头采集已启动 ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}")

            segmentationPending = enableSegmentation
            if (enableSegmentation) {
                scheduleSegmentationAttach(source)
            }

            val videoTrack = peerFactory.createVideoTrack("video0", source)
            localVideoTrack = videoTrack
            videoTrack.setEnabled(true)
            bindLocalPreviewWhenReady(videoTrack)

            val audioConstraints = MediaConstraints()
            val aSource = peerFactory.createAudioSource(audioConstraints)
            audioSource = aSource
            localAudioTrack = peerFactory.createAudioTrack("audio0", aSource)

            isPublishing = true
            castLog("preview", "推流已开始 localVideoTrack=${localVideoTrack != null} renderer=${localRendererInitialized}")
            true
        } catch (e: Exception) {
            castError("preview", "startPublishing 失败: ${e.message}")
            stopPublishing()
            false
        }
    }

    private fun scheduleSegmentationAttach(source: VideoSource) {
        mainHandler.postDelayed({
            if (!isPublishing || videoSource !== source) return@postDelayed
            Thread {
                val processor = SegmentationProcessor(appContext)
                val ready = try {
                    processor.prepareSegmenter()
                } catch (e: Exception) {
                    Log.e(TAG, "MediaPipe 预初始化异常: ${e.message}")
                    false
                }
                mainHandler.post {
                    if (!isPublishing || videoSource !== source) {
                        processor.release()
                        segmentationPending = false
                        return@post
                    }
                    if (!ready) {
                        processor.release()
                        segmentationPending = false
                        Log.w(TAG, "MediaPipe 不可用，继续普通推流")
                        return@post
                    }
                    try {
                        processor.setEnabled(true)
                        source.setVideoProcessor(processor)
                        segmentationProcessor = processor
                        segmentationPending = false
                        Log.i(TAG, "MediaPipe 抠图已挂载")
                        refreshLocalPreview()
                    } catch (e: Exception) {
                        processor.release()
                        segmentationPending = false
                        Log.e(TAG, "MediaPipe 挂载失败，继续普通推流", e)
                    }
                }
            }.start()
        }, SEGMENTATION_DELAY_MS)
    }

    fun noteAwaitingPublisher(publisherId: String) {
        if (publisherId == localDeviceId) return
        notePeerJoined(publisherId)
        ensureReceiveReady()
        val key = peerKey(publisherId)
        peerConnections[key]?.let { existing ->
            if (existing.connectionState() == PeerConnection.PeerConnectionState.FAILED ||
                existing.connectionState() == PeerConnection.PeerConnectionState.CLOSED ||
                existing.connectionState() == PeerConnection.PeerConnectionState.DISCONNECTED
            ) {
                existing.close()
                peerConnections.remove(key)
            }
        }
        if (!signaling.send(
                "subscribe",
                mapOf(
                    "publisherId" to publisherId,
                    "subscriberId" to localDeviceId,
                    "streamType" to STREAM_TYPE
                ),
                to = publisherId
            )
        ) {
            Log.w(TAG, "subscribe 发送失败(等待发布): $publisherId")
        }
    }

    fun handleSignalingMessage(msg: SignalingClient.SignalingMessage) {
        when (msg.type) {
            "peer_joined" -> {
                val deviceId = msg.payload?.getAsJsonObject("device")?.get("id")?.asString ?: return
                if (deviceId == localDeviceId) return
                notePeerJoined(deviceId)
                // 仅记录 peer；offer 必须等对方 subscribe 后再发
            }
            "offer" -> handleOffer(msg)
            "answer" -> handleAnswer(msg)
            "ice" -> handleIceCandidate(msg)
            "subscribe" -> {
                val publisherId = msg.payload?.get("publisherId")?.asString ?: return
                val subscriberId = msg.payload?.get("subscriberId")?.asString ?: return
                if (publisherId != localDeviceId || subscriberId == localDeviceId) return
                castLog("subscribe", "收到 ← ${subscriberId.take(8)} (isPublishing=$isPublishing)")
                notePeerJoined(subscriberId)
                activeSubscribers.add(subscriberId)
                pendingSubscribers.add(subscriberId)
                pendingOfferRetries.remove(peerKey(subscriberId))?.let { mainHandler.removeCallbacks(it) }
                if (!isPublishing) {
                    castWarn("subscribe", "尚未推流，已排队 ${subscriberId.take(8)}")
                    return
                }
                offerStreamToPeer(subscriberId, respondToSubscribe = true)
            }
        }
    }

    fun resetPeerConnections() {
        pendingOfferRetries.values.forEach { mainHandler.removeCallbacks(it) }
        pendingOfferRetries.clear()
        makingOffer.clear()
        pendingIce.clear()
        pendingSubscribers.clear()
        // activeSubscribers 保留：信令重连后桌面会再 subscribe，flush/renegotiate 仍需知道订阅方
        peerConnections.values.forEach { pc ->
            try {
                pc.close()
            } catch (e: Exception) {
                Log.w(TAG, "resetPeerConnections 关闭失败: ${e.message}")
            }
        }
        peerConnections.clear()
    }

    fun closePeer(remoteId: String) {
        val key = peerKey(remoteId)
        pendingOfferRetries.remove(key)?.let { mainHandler.removeCallbacks(it) }
        makingOffer.remove(key)
        pendingIce.remove(key)
        pendingSubscribers.remove(remoteId)
        activeSubscribers.remove(remoteId)
        peerConnections.remove(key)?.close()
    }

    fun stopPublishing() {
        isPublishing = false
        segmentationPending = false
        pendingSubscribers.clear()
        activeSubscribers.clear()
        pendingOfferRetries.values.forEach { mainHandler.removeCallbacks(it) }
        pendingOfferRetries.clear()

        safeRelease("videoCapturer") {
            videoCapturer?.stopCapture()
            videoCapturer?.dispose()
            videoCapturer = null
        }

        safeRelease("surfaceTextureHelper") {
            surfaceTextureHelper?.dispose()
            surfaceTextureHelper = null
        }

        safeRelease("segmentation") {
            videoSource?.setVideoProcessor(null)
            segmentationProcessor?.release()
            segmentationProcessor = null
        }

        safeRelease("localTracks") {
            releaseLocalPreviewRenderer()
            localVideoTrack?.dispose()
            localVideoTrack = null
            localAudioTrack?.dispose()
            localAudioTrack = null
        }

        safeRelease("mediaSources") {
            videoSource?.dispose()
            videoSource = null
            audioSource?.dispose()
            audioSource = null
        }

        safeRelease("peerConnectionsOnStop") {
            makingOffer.clear()
            pendingIce.clear()
            peerConnections.values.forEach { pc ->
                try {
                    pc.close()
                } catch (e: Exception) {
                    Log.w(TAG, "关闭 PeerConnection 失败: ${e.message}")
                }
            }
            peerConnections.clear()
        }
    }

    fun release() {
        if (released) return
        released = true
        stopPublishing()
        safeRelease("peerConnections") {
            peerConnections.clear()
            pendingIce.clear()
            makingOffer.clear()
        }
        safeRelease("factory") {
            factory?.dispose()
            factory = null
        }
        receiveReady = false
        localRendererInitialized = false
        remoteRendererInitialized = false
        safeRelease("localRenderer") {
            if (localRendererInitialized) localRenderer.release()
        }
        safeRelease("remoteRenderer") {
            if (remoteRendererInitialized) remoteRenderer?.release()
        }
    }

    private fun initializeFactory() {
        if (factory != null) return
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }

    private fun createCameraCapturer(): CameraVideoCapturer? {
        val enumerator = Camera2Enumerator(appContext)
        for (name in enumerator.deviceNames) {
            if (enumerator.isFrontFacing(name)) {
                return enumerator.createCapturer(name, null)
            }
        }
        for (name in enumerator.deviceNames) {
            if (enumerator.isBackFacing(name)) {
                return enumerator.createCapturer(name, null)
            }
        }
        return null
    }

    private fun peerKey(remoteId: String) = "$remoteId:$STREAM_TYPE"

    private fun attachLocalTracks(pc: PeerConnection) {
        if (!isPublishing) return
        localVideoTrack?.let { track ->
            val sender = pc.senders.firstOrNull { it.track()?.kind() == "video" }
            if (sender != null) {
                sender.setTrack(track, true)
            } else {
                pc.addTransceiver(
                    track,
                    RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY)
                )
            }
        }
        localAudioTrack?.let { track ->
            val sender = pc.senders.firstOrNull { it.track()?.kind() == "audio" }
            if (sender != null) {
                sender.setTrack(track, true)
            } else {
                pc.addTransceiver(
                    track,
                    RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY)
                )
            }
        }
    }

    private fun resetPublisherPeerConnectionOnMain(remoteId: String) {
        val key = peerKey(remoteId)
        pendingOfferRetries.remove(key)?.let { mainHandler.removeCallbacks(it) }
        makingOffer.remove(key)
        pendingIce.remove(key)
        peerConnections.remove(key)?.let { pc ->
            try {
                pc.close()
            } catch (e: Exception) {
                Log.w(TAG, "关闭 PeerConnection 失败: ${e.message}")
            }
        }
    }

    /** PeerConnection 必须在创建线程（主线程）关闭，否则 ICE 回调线程 close 会 native 闪退 */
    private fun resetPublisherPeerConnection(remoteId: String) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            resetPublisherPeerConnectionOnMain(remoteId)
        } else {
            mainHandler.post { resetPublisherPeerConnectionOnMain(remoteId) }
        }
    }

    private fun schedulePublisherIceRecovery(remoteId: String, reason: String) {
        mainHandler.post {
            if (!isPublishing) return@post
            val key = peerKey(remoteId)
            val now = System.currentTimeMillis()
            if (now - (lastIceRecoveryMs[key] ?: 0L) < 2500L) return@post
            val count = (iceRecoveryCounts[key] ?: 0) + 1
            if (count > 5) {
                castError("ice", "ICE 重试过多 ${remoteId.take(8)}，请检查网络/TURN")
                return@post
            }
            iceRecoveryCounts[key] = count
            lastIceRecoveryMs[key] = now
            if (relayReadyPeers.contains(remoteId)) {
                enableRelayOnly(remoteId, reason)
            } else {
                castWarn("ice", "跳过 relay-only ${remoteId.take(8)} ($reason)")
            }
            resetPublisherPeerConnectionOnMain(remoteId)
            mainHandler.postDelayed({
                if (!isPublishing || !activeSubscribers.contains(remoteId)) return@postDelayed
                offerStreamToPeer(remoteId, respondToSubscribe = true)
            }, 1200L)
        }
    }

    private fun isCastConnected(pc: PeerConnection): Boolean {
        val iceOk = pc.iceConnectionState() == PeerConnection.IceConnectionState.CONNECTED ||
            pc.iceConnectionState() == PeerConnection.IceConnectionState.COMPLETED
        return pc.connectionState() == PeerConnection.PeerConnectionState.CONNECTED &&
            iceOk &&
            pc.signalingState() == PeerConnection.SignalingState.STABLE
    }

    private fun subscriberNeedsOffer(remoteId: String): Boolean {
        val pc = peerConnections[peerKey(remoteId)] ?: return true
        return !isCastConnected(pc)
    }

    private fun offerStreamToPeer(remoteId: String, respondToSubscribe: Boolean = false) {
        if (!isPublishing || remoteId == localDeviceId) return
        val key = peerKey(remoteId)

        peerConnections[key]?.let { existing ->
            // 非 subscribe 触发且已稳定连接：跳过
            if (!respondToSubscribe && isCastConnected(existing)) {
                Log.i(TAG, "已与 $remoteId 连接，跳过 offer")
                pendingSubscribers.remove(remoteId)
                return
            }
            // subscribe 触发：电脑可能已重建 PC，必须响应；清理 stale offer / 死连接
            if (respondToSubscribe) {
                val staleOffer =
                    existing.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER
                val dead = !isCastConnected(existing)
                if (staleOffer || dead) {
                    Log.i(
                        TAG,
                        "subscribe 触发，重置连接: $remoteId (staleOffer=$staleOffer dead=$dead)"
                    )
                    resetPublisherPeerConnection(remoteId)
                }
            } else if (existing.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER) {
                Log.i(TAG, "offer 已发出，等待 $remoteId answer")
                return
            }
        }

        if (makingOffer.contains(key)) {
            if (respondToSubscribe) {
                Log.i(TAG, "subscribe 打断进行中的 offer，重置: $remoteId")
                resetPublisherPeerConnection(remoteId)
            } else {
                return
            }
        }
        if (localVideoTrack == null) {
            castError("offer", "localVideoTrack 为空，无法向 ${remoteId.take(8)} 发 offer")
            return
        }
        castLog("offer", "videoTrack enabled=${localVideoTrack?.enabled()} state=${localVideoTrack?.state()}")

        try {
            ensureReceiveReady()
            val pc = preparePublisherPeerConnection(remoteId)
            attachLocalTracks(pc)
            logTransceivers(pc, "createOffer 前")
            Log.i(TAG, "准备向 $remoteId 发送 offer")
            castLog("offer", "准备发送 → ${remoteId.take(8)}")
            makingOffer.add(key)

            pc.createOffer(object : SdpObserver {
                override fun onCreateSuccess(offer: SessionDescription?) {
                    offer ?: return
                    logVideoMLineDirection(offer.description)
                    pc.setLocalDescription(object : SdpObserver {
                        override fun onCreateSuccess(desc: SessionDescription?) {}
                        override fun onSetSuccess() {
                            makingOffer.remove(key)
                            pendingSubscribers.remove(remoteId)
                            pendingOfferRetries.remove(key)?.let { mainHandler.removeCallbacks(it) }
                            sendSdp("offer", offer, remoteId)
                            castLog("offer", "已发送 → ${remoteId.take(8)}")
                            Log.i(TAG, "offer 已发送: $remoteId")
                            scheduleOfferRetryIfNoAnswer(remoteId)
                        }
                        override fun onCreateFailure(error: String?) {
                            makingOffer.remove(key)
                            Log.e(TAG, "setLocalDescription(offer) 失败: $error")
                        }
                        override fun onSetFailure(error: String?) {
                            makingOffer.remove(key)
                            Log.e(TAG, "setLocalDescription(offer) 失败: $error")
                        }
                    }, offer)
                }
                override fun onSetSuccess() {}
                override fun onCreateFailure(error: String?) {
                    makingOffer.remove(key)
                    Log.e(TAG, "createOffer 失败: $error")
                }
                override fun onSetFailure(error: String?) {
                    makingOffer.remove(key)
                }
            }, sendOnlyMediaConstraints())
        } catch (e: Exception) {
            makingOffer.remove(key)
            Log.e(TAG, "offerStreamToPeer 失败: $remoteId", e)
        }
    }

    /** 5 秒内无 answer 才重置并重发（仅一次） */
    private fun scheduleOfferRetryIfNoAnswer(remoteId: String) {
        val key = peerKey(remoteId)
        pendingOfferRetries.remove(key)?.let { mainHandler.removeCallbacks(it) }
        val retry = Runnable {
            val pc = peerConnections[key] ?: return@Runnable
            if (isCastConnected(pc)) return@Runnable
            if (pc.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER) {
                Log.w(TAG, "answer 超时，重置并重发 offer: $remoteId")
                resetPublisherPeerConnection(remoteId)
                offerStreamToPeer(remoteId, respondToSubscribe = activeSubscribers.contains(remoteId))
            }
        }
        pendingOfferRetries[key] = retry
        mainHandler.postDelayed(retry, 5000)
    }

    fun renegotiateAllPeers() {
        if (!isPublishing) return
        // 仅重协商已有 PC 且未连通的 peer；新 subscribe 须等对方发 subscribe（subscribe-first）
        val targets = (
            peerConnections.keys.map { it.substringBefore(':') }.filter { subscriberNeedsOffer(it) } +
                pendingSubscribers
            ).filter { it != localDeviceId }.distinct()
        Log.i(TAG, "向 ${targets.size} 个设备重协商: $targets")
        targets.forEachIndexed { index, remoteId ->
            mainHandler.postDelayed({
                offerStreamToPeer(
                    remoteId,
                    respondToSubscribe = activeSubscribers.contains(remoteId)
                )
            }, (index * 200L + 300L))
        }
    }

    /** 推流开始后向已 subscribe 但尚未连通的设备发送 offer */
    fun flushPendingOffers() {
        if (!isPublishing) return
        val targets = (
            pendingSubscribers +
                activeSubscribers.filter { subscriberNeedsOffer(it) }
            ).filter { it != localDeviceId }.distinct()
        if (targets.isEmpty()) {
            Log.i(TAG, "暂无待推送设备，等待 subscribe")
            return
        }
        Log.i(TAG, "向 ${targets.size} 个已订阅设备推送 offer: $targets")
        targets.forEach { remoteId ->
            offerStreamToPeer(remoteId, respondToSubscribe = true)
        }
    }

    private fun preparePublisherPeerConnection(remoteId: String): PeerConnection {
        val key = peerKey(remoteId)
        peerConnections[key]?.let { existing ->
            val deadConnection = when (existing.connectionState()) {
                PeerConnection.PeerConnectionState.FAILED,
                PeerConnection.PeerConnectionState.CLOSED,
                PeerConnection.PeerConnectionState.DISCONNECTED -> true
                else -> false
            }
            val stuckSignaling = existing.signalingState() != PeerConnection.SignalingState.STABLE &&
                existing.signalingState() != PeerConnection.SignalingState.HAVE_LOCAL_OFFER
            val missingVideo = isPublishing && existing.senders.none {
                it.track()?.kind() == "video" && it.track()?.enabled() == true
            }
            if (deadConnection || stuckSignaling || missingVideo) {
                existing.close()
                peerConnections.remove(key)
                pendingIce.remove(key)
                makingOffer.remove(key)
            }
        }
        return getOrCreatePeerConnection(remoteId)
    }

    private fun rtcConfigForPeer(remoteId: String): PeerConnection.RTCConfiguration {
        return PeerConnection.RTCConfiguration(activeIceServers()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.ENABLED
            iceTransportsType = if (relayOnlyPeers.contains(remoteId)) {
                PeerConnection.IceTransportsType.RELAY
            } else {
                PeerConnection.IceTransportsType.ALL
            }
        }
    }

    private fun enableRelayOnly(remoteId: String, reason: String) {
        if (!relayReadyPeers.contains(remoteId)) {
            castWarn("ice", "跳过 relay-only ${remoteId.take(8)} ($reason)")
            return
        }
        if (relayOnlyPeers.add(remoteId)) {
            castWarn("ice", "切换 TURN relay-only ${remoteId.take(8)} ($reason)")
        }
    }

    private fun parseIceCandidate(candidateObj: com.google.gson.JsonObject): IceCandidate? {
        var candidateStr = candidateObj.get("candidate")?.asString ?: return null
        if (candidateStr.isBlank()) return null
        if (candidateStr.startsWith("a=")) candidateStr = candidateStr.removePrefix("a=")
        if (!candidateStr.startsWith("candidate:")) candidateStr = "candidate:$candidateStr"
        return IceCandidate(
            candidateObj.get("sdpMid")?.asString,
            candidateObj.get("sdpMLineIndex")?.asInt ?: 0,
            candidateStr
        )
    }

    private fun getOrCreatePeerConnection(remoteId: String): PeerConnection {
        val key = peerKey(remoteId)
        peerConnections[key]?.let { existing ->
            when (existing.connectionState()) {
                PeerConnection.PeerConnectionState.FAILED,
                PeerConnection.PeerConnectionState.CLOSED,
                PeerConnection.PeerConnectionState.DISCONNECTED -> {
                    existing.close()
                    peerConnections.remove(key)
                }
                else -> return existing
            }
        }

        val peerFactory = factory ?: throw IllegalStateException("PeerConnectionFactory 未初始化")
        val rtcConfig = rtcConfigForPeer(remoteId)

        val pc = peerFactory.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate?) {
                candidate ?: return
                val candType = when {
                    candidate.sdp.contains("typ relay") -> "relay"
                    candidate.sdp.contains("typ srflx") -> "srflx"
                    candidate.sdp.contains("typ host") -> "host"
                    else -> "unknown"
                }
                Log.d(TAG, "ICE 候选 ($candType): $remoteId")
                when (candType) {
                    "relay" -> {
                        relayReadyPeers.add(remoteId)
                        castLog("ice", "发送 relay 候选 → ${remoteId.take(8)}")
                    }
                    "host", "srflx" -> {
                        val ip = Regex("""(\d+\.\d+\.\d+\.\d+)""").find(candidate.sdp)?.groupValues?.get(1)
                        if (ip != null) {
                            castLog("ice", "发送 $candType $ip → ${remoteId.take(8)}")
                        }
                    }
                }
                signaling.send(
                    "ice",
                    mapOf(
                        "candidate" to mapOf(
                            "candidate" to candidate.sdp,
                            "sdpMid" to candidate.sdpMid,
                            "sdpMLineIndex" to candidate.sdpMLineIndex
                        ),
                        "streamType" to STREAM_TYPE,
                        "targetId" to remoteId
                    ),
                    to = remoteId
                ).let { ok ->
                    if (ok) Log.i(TAG, "ICE 候选已发送: $remoteId")
                    else Log.w(TAG, "ICE 候选发送失败: $remoteId")
                }
            }

            override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
                val track = receiver?.track()
                Log.i(TAG, "收到远端轨道: $track, streams: ${streams?.size ?: 0}")
                if (track is VideoTrack && receiveReady && remoteRenderer != null) {
                    runOnMainThread {
                        if (remoteRenderer.width <= 0 || remoteRenderer.height <= 0) {
                            remoteRenderer.viewTreeObserver.addOnGlobalLayoutListener(object :
                                ViewTreeObserver.OnGlobalLayoutListener {
                                override fun onGlobalLayout() {
                                    if (remoteRenderer.width <= 0 || remoteRenderer.height <= 0) return
                                    remoteRenderer.viewTreeObserver.removeOnGlobalLayoutListener(this)
                                    initRemoteRendererOnMainThread()
                                    track.addSink(remoteRenderer)
                                    remoteRenderer.visibility = View.VISIBLE
                                    Log.i(TAG, "远端视频已绑定: $remoteId")
                                }
                            })
                        } else {
                            initRemoteRendererOnMainThread()
                            track.addSink(remoteRenderer)
                            remoteRenderer.visibility = View.VISIBLE
                            Log.i(TAG, "远端视频已绑定到渲染器: $remoteId")
                        }
                    }
                }
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED -> {
                        iceRecoveryCounts.remove(peerKey(remoteId))
                        castLog("ice", "ICE 已连接 ${remoteId.take(8)}")
                    }
                    PeerConnection.IceConnectionState.COMPLETED -> {
                        iceRecoveryCounts.remove(peerKey(remoteId))
                        castLog("ice", "ICE completed ${remoteId.take(8)}")
                    }
                    PeerConnection.IceConnectionState.CHECKING ->
                        castWarn("ice", "${remoteId.take(8)} checking…")
                    PeerConnection.IceConnectionState.FAILED -> {
                        castError("ice", "ICE 失败 ${remoteId.take(8)}")
                        schedulePublisherIceRecovery(remoteId, "failed")
                    }
                    PeerConnection.IceConnectionState.DISCONNECTED -> {
                        castWarn("ice", "${remoteId.take(8)} disconnected")
                        if (isPublishing) {
                            mainHandler.postDelayed({
                                val pcRef = peerConnections[peerKey(remoteId)] ?: return@postDelayed
                                val ice = pcRef.iceConnectionState()
                                if (ice == PeerConnection.IceConnectionState.CONNECTED ||
                                    ice == PeerConnection.IceConnectionState.COMPLETED
                                ) return@postDelayed
                                schedulePublisherIceRecovery(remoteId, "disconnected")
                            }, 4000)
                        }
                    }
                    else ->
                        Log.d(TAG, "ICE 连接状态 $remoteId: $state")
                }
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
                Log.d(TAG, "ICE 收集状态 $remoteId: $state")
            }
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
            override fun onAddStream(stream: MediaStream?) {}
            override fun onRemoveStream(stream: MediaStream?) {}
            override fun onDataChannel(channel: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
        }) ?: throw IllegalStateException("PeerConnection 创建失败: $remoteId")

        attachLocalTracks(pc)
        peerConnections[key] = pc
        return pc
    }

    private fun handleOffer(msg: SignalingClient.SignalingMessage) {
        val from = msg.from ?: return
        if (from == localDeviceId) return
        ensureReceiveReady()
        initRemoteRendererOnMainThread()

        val sdpJson = msg.payload?.getAsJsonObject("sdp") ?: return
        val sdp = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(sdpJson.get("type").asString),
            sdpJson.get("sdp").asString
        )
        val key = peerKey(from)
        val pc = getOrCreatePeerConnection(from)
        attachLocalTracks(pc)
        rollbackAndAnswerOffer(pc, key, sdp, from)
    }

    private fun rollbackAndAnswerOffer(pc: PeerConnection, key: String, sdp: SessionDescription, from: String) {
        fun answerOffer() {
            makingOffer.remove(key)
            pc.setRemoteDescription(object : SdpObserver {
                override fun onCreateSuccess(desc: SessionDescription?) {}
                override fun onSetSuccess() {
                    drainPendingIce(from)
                    attachLocalTracks(pc)
                    pc.createAnswer(object : SdpObserver {
                        override fun onCreateSuccess(answer: SessionDescription?) {
                            answer ?: return
                            pc.setLocalDescription(object : SdpObserver {
                                override fun onCreateSuccess(desc: SessionDescription?) {}
                                override fun onSetSuccess() {
                                    sendSdp("answer", answer, from)
                                }
                                override fun onCreateFailure(error: String?) {
                                    Log.e(TAG, "setLocalDescription(answer) 失败: $error")
                                }
                                override fun onSetFailure(error: String?) {
                                    Log.e(TAG, "setLocalDescription(answer) 失败: $error")
                                }
                            }, answer)
                        }
                        override fun onSetSuccess() {}
                        override fun onCreateFailure(error: String?) {
                            Log.e(TAG, "createAnswer 失败: $error")
                        }
                        override fun onSetFailure(error: String?) {}
                    }, sendOnlyMediaConstraints())
                }
                override fun onCreateFailure(error: String?) {}
                override fun onSetFailure(error: String?) {
                    Log.e(TAG, "setRemoteDescription(offer) 失败: $error")
                }
            }, sdp)
        }

        val needRollback = makingOffer.contains(key) ||
            pc.signalingState() != PeerConnection.SignalingState.STABLE
        if (!needRollback) {
            answerOffer()
            return
        }
        pc.setLocalDescription(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription?) {}
            override fun onSetSuccess() { answerOffer() }
            override fun onCreateFailure(error: String?) { answerOffer() }
            override fun onSetFailure(error: String?) { answerOffer() }
        }, SessionDescription(SessionDescription.Type.ROLLBACK, ""))
    }

    private fun handleAnswer(msg: SignalingClient.SignalingMessage) {
        val from = msg.from ?: return
        Log.i(TAG, "收到远端 answer: $from")
        val key = peerKey(from)
        val pc = peerConnections[key] ?: return
        val sdpJson = msg.payload?.getAsJsonObject("sdp") ?: return
        val sdp = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(sdpJson.get("type").asString),
            sdpJson.get("sdp").asString
        )
        pc.setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription?) {}
            override fun onSetSuccess() {
                makingOffer.remove(key)
                pendingOfferRetries.remove(key)?.let { mainHandler.removeCallbacks(it) }
                drainPendingIce(from)
                Log.i(TAG, "answer 已应用: $from")
            }
            override fun onCreateFailure(error: String?) {}
            override fun onSetFailure(error: String?) {
                Log.e(TAG, "setRemoteDescription(answer) 失败: $error")
            }
        }, sdp)
    }

    private fun handleIceCandidate(msg: SignalingClient.SignalingMessage) {
        val from = msg.from ?: return
        val key = peerKey(from)
        val candidateObj = msg.payload?.getAsJsonObject("candidate") ?: return
        val candidate = parseIceCandidate(candidateObj) ?: return
        val pc = peerConnections[key]
        if (pc != null && pc.remoteDescription != null) {
            pc.addIceCandidate(candidate)
        } else if (pc != null && pc.localDescription != null) {
            pc.addIceCandidate(candidate)
        } else {
            pendingIce.getOrPut(key) { mutableListOf() }.add(candidate)
        }
    }

    private fun drainPendingIce(remoteId: String) {
        val key = peerKey(remoteId)
        val pc = peerConnections[key] ?: return
        pendingIce.remove(key)?.forEach { pc.addIceCandidate(it) }
    }

    private fun sendSdp(type: String, sdp: SessionDescription, to: String) {
        val ok = signaling.send(
            type,
            mapOf(
                "sdp" to mapOf("type" to sdp.type.canonicalForm(), "sdp" to sdp.description),
                "streamType" to STREAM_TYPE,
                "targetId" to to
            ),
            to = to
        )
        if (!ok) Log.w(TAG, "信令发送失败: $type -> $to")
    }
}
