package com.holographic.app

import android.content.Context
import android.os.Looper
import android.util.Log
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
            IceServer.builder("stun:stun.qq.com:19302").createIceServer()
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

    private fun waitForLocalSurfaceReady(onReady: () -> Unit) {
        runOnMainThread {
            if (localRenderer.width > 0 && localRenderer.height > 0) {
                initLocalRendererOnMainThread()
                onReady()
                return@runOnMainThread
            }
            val observer = localRenderer.viewTreeObserver
            observer.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
                override fun onGlobalLayout() {
                    if (localRenderer.width <= 0 || localRenderer.height <= 0) return
                    if (observer.isAlive) {
                        observer.removeOnGlobalLayoutListener(this)
                    } else {
                        localRenderer.viewTreeObserver.removeOnGlobalLayoutListener(this)
                    }
                    initLocalRendererOnMainThread()
                    Log.i(TAG, "本地 Surface 就绪: ${localRenderer.width}x${localRenderer.height}")
                    onReady()
                }
            })
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
            if (localRenderer.visibility == View.VISIBLE) {
                initLocalRendererOnMainThread()
            }
        }
    }

    fun startPublishing(enableSegmentation: Boolean, callback: (Boolean) -> Unit) {
        if (isPublishing) {
            callback(true)
            return
        }
        ensureReceiveReady()
        waitForLocalSurfaceReady {
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

    private fun startPublishingInternal(enableSegmentation: Boolean): Boolean {
        if (isPublishing) return true
        return try {
            val peerFactory = factory ?: run {
                Log.e(TAG, "PeerConnectionFactory 未初始化")
                return false
            }

            val capturer = createCameraCapturer() ?: run {
                Log.e(TAG, "无法打开摄像头")
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
            Log.i(TAG, "摄像头采集已启动 ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}")

            segmentationPending = enableSegmentation
            if (enableSegmentation) {
                scheduleSegmentationAttach(source)
            }

            val videoTrack = peerFactory.createVideoTrack("video0", source)
            localVideoTrack = videoTrack
            videoTrack.setEnabled(true)
            videoTrack.addSink(localRenderer)
            localRenderer.post { localRenderer.requestLayout() }

            val audioConstraints = MediaConstraints()
            val aSource = peerFactory.createAudioSource(audioConstraints)
            audioSource = aSource
            localAudioTrack = peerFactory.createAudioTrack("audio0", aSource)

            isPublishing = true
            Log.i(TAG, "推流已开始，本地预览已绑定")
            true
        } catch (e: Exception) {
            Log.e(TAG, "startPublishing 失败", e)
            stopPublishing()
            false
        }
    }

    private fun scheduleSegmentationAttach(source: VideoSource) {
        mainHandler.postDelayed({
            if (!isPublishing || videoSource !== source) return@postDelayed
            try {
                val processor = SegmentationProcessor(appContext)
                processor.setEnabled(true)
                source.setVideoProcessor(processor)
                segmentationProcessor = processor
                segmentationPending = false
                Log.i(TAG, "MediaPipe 抠图已延迟挂载")
            } catch (e: Exception) {
                Log.e(TAG, "MediaPipe 挂载失败，继续普通推流", e)
                segmentationPending = false
            }
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
                if (isPublishing) offerStreamToPeer(deviceId)
            }
            "offer" -> handleOffer(msg)
            "answer" -> handleAnswer(msg)
            "ice" -> handleIceCandidate(msg)
            "subscribe" -> {
                val publisherId = msg.payload?.get("publisherId")?.asString ?: return
                val subscriberId = msg.payload?.get("subscriberId")?.asString ?: return
                if (publisherId != localDeviceId || subscriberId == localDeviceId) return
                notePeerJoined(subscriberId)
                if (!isPublishing) {
                    pendingSubscribers.add(subscriberId)
                    Log.w(TAG, "收到 subscribe 但尚未推流，已排队: $subscriberId")
                    return
                }
                offerStreamToPeer(subscriberId)
            }
        }
    }

    fun resetPeerConnections() {
        pendingOfferRetries.values.forEach { mainHandler.removeCallbacks(it) }
        pendingOfferRetries.clear()
        makingOffer.clear()
        pendingIce.clear()
        pendingSubscribers.clear()
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
        peerConnections.remove(key)?.close()
    }

    fun stopPublishing() {
        isPublishing = false
        segmentationPending = false
        pendingSubscribers.clear()
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
            localVideoTrack?.removeSink(localRenderer)
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

    private fun offerStreamToPeer(remoteId: String) {
        if (!isPublishing || remoteId == localDeviceId) return
        val key = peerKey(remoteId)
        try {
            ensureReceiveReady()
            if (makingOffer.contains(key)) {
                pendingOfferRetries[key]?.let { mainHandler.removeCallbacks(it) }
                val retry = Runnable { offerStreamToPeer(remoteId) }
                pendingOfferRetries[key] = retry
                mainHandler.postDelayed(retry, 400)
                return
            }
            if (localVideoTrack == null) {
                Log.e(TAG, "本地视频轨道为空，无法发送 offer")
                return
            }
            val pc = preparePublisherPeerConnection(remoteId)
            attachLocalTracks(pc)
            Log.i(TAG, "准备向 $remoteId 发送 offer")
            makingOffer.add(key)

            val offerConstraints = MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
            }

            pc.createOffer(object : SdpObserver {
                override fun onCreateSuccess(offer: SessionDescription?) {
                    offer ?: return
                    pc.setLocalDescription(object : SdpObserver {
                        override fun onCreateSuccess(desc: SessionDescription?) {}
                        override fun onSetSuccess() {
                            makingOffer.remove(key)
                            pendingSubscribers.remove(remoteId)
                            sendSdp("offer", offer, remoteId)
                            Log.i(TAG, "offer 已发送: $remoteId")
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
            }, offerConstraints)
        } catch (e: Exception) {
            makingOffer.remove(key)
            Log.e(TAG, "offerStreamToPeer 失败: $remoteId", e)
        }
    }

    fun renegotiateAllPeers() {
        if (!isPublishing) return
        val targets = (peerConnections.keys.map { it.substringBefore(':') } + knownPeerIds + pendingSubscribers)
            .filter { it != localDeviceId }
            .distinct()
        Log.i(TAG, "向 ${targets.size} 个设备重协商: $targets")
        targets.forEachIndexed { index, remoteId ->
            mainHandler.postDelayed({ offerStreamToPeer(remoteId) }, (index * 200L + 300L))
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
        val rtcConfig = PeerConnection.RTCConfiguration(activeIceServers()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

        val pc = peerFactory.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate?) {
                candidate ?: return
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
                if (track is VideoTrack && remoteRenderer != null) {
                    runOnMainThread {
                        initRemoteRendererOnMainThread()
                        track.addSink(remoteRenderer)
                        remoteRenderer.visibility = View.VISIBLE
                        Log.i(TAG, "远端视频已绑定到渲染器: $remoteId")
                    }
                }
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED ->
                        Log.i(TAG, "ICE 连接已建立: $remoteId")
                    PeerConnection.IceConnectionState.FAILED ->
                        Log.e(TAG, "ICE 连接失败: $remoteId")
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
                    }, MediaConstraints())
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
        val candidateStr = candidateObj.get("candidate")?.asString
        if (candidateStr.isNullOrBlank()) {
            Log.w(TAG, "收到空 ICE candidate: $from")
            return
        }
        val candidate = IceCandidate(
            candidateObj.get("sdpMid")?.asString,
            candidateObj.get("sdpMLineIndex")?.asInt ?: 0,
            candidateStr
        )
        val pc = peerConnections[key]
        if (pc != null && pc.remoteDescription != null) {
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
