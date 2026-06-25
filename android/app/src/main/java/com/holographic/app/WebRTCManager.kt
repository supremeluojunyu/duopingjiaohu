package com.holographic.app

import android.content.Context
import android.util.Log
import com.google.gson.JsonObject
import org.webrtc.*
import org.webrtc.PeerConnection.IceServer

/**
 * WebRTC 管理器 — 摄像头采集、推流、接收远端画面
 */
class WebRTCManager(
    private val context: Context,
    private val signaling: SignalingClient,
    private val localRenderer: SurfaceViewRenderer,
    private val remoteRenderer: SurfaceViewRenderer?,
    private var localDeviceId: String,
    private val eglBase: EglBase
) {
    companion object {
        private const val TAG = "WebRTCManager"
        private const val STREAM_TYPE = "camera"
    }

    private var factory: PeerConnectionFactory? = null
    private var localVideoTrack: VideoTrack? = null
    private var localAudioTrack: AudioTrack? = null
    private var videoCapturer: CameraVideoCapturer? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    private val peerConnections = mutableMapOf<String, PeerConnection>()
    private val pendingIce = mutableMapOf<String, MutableList<IceCandidate>>()
    private var isPublishing = false
    private var segmentationProcessor: SegmentationProcessor? = null
    private var receiveReady = false
    private val knownPeerIds = mutableSetOf<String>()
    private val makingOffer = mutableSetOf<String>()
    private var localRendererInitialized = false

    private var iceServers: List<IceServer> = emptyList()

    fun setIceServers(servers: List<IceServer>) {
        if (servers.isNotEmpty()) iceServers = servers
    }

    private fun activeIceServers(): List<IceServer> {
        if (iceServers.isNotEmpty()) return iceServers
        return IceConfigFetcher.fetch(SignalingConfig.getServerUrl()).also { iceServers = it }
    }

    /** 加入房间后初始化，用于接收远端 offer */
    fun ensureReceiveReady() {
        if (receiveReady) return
        try {
            initializeFactory()
            remoteRenderer?.let { renderer ->
                renderer.init(eglBase.eglBaseContext, null)
                renderer.setMirror(false)
                renderer.setEnableHardwareScaler(true)
            }
            receiveReady = true
            Log.i(TAG, "接收通道已就绪")
        } catch (e: Exception) {
            Log.e(TAG, "接收通道初始化失败", e)
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

    fun startPublishing(enableSegmentation: Boolean): Boolean {
        if (isPublishing) return true

        return try {
            ensureReceiveReady()
            val peerFactory = factory
            if (peerFactory == null) {
                Log.e(TAG, "PeerConnectionFactory 未初始化")
                return false
            }

            if (!localRendererInitialized) {
                localRenderer.init(eglBase.eglBaseContext, null)
                localRenderer.setMirror(true)
                localRenderer.setEnableHardwareScaler(true)
                localRendererInitialized = true
            }

            val capturer = createCameraCapturer() ?: run {
                Log.e(TAG, "无法打开摄像头")
                return false
            }
            videoCapturer = capturer

            val source = peerFactory.createVideoSource(capturer.isScreencast)
            videoSource = source
            capturer.initialize(
                SurfaceTextureHelper.create("CaptureThread", eglBase.eglBaseContext),
                context,
                source.capturerObserver
            )
            capturer.startCapture(1280, 720, 30)

            if (enableSegmentation) {
                try {
                    segmentationProcessor = SegmentationProcessor(context).also { it.setEnabled(true) }
                    source.setVideoProcessor(segmentationProcessor)
                    Log.i(TAG, "MediaPipe 人像抠图已启用")
                } catch (e: Exception) {
                    Log.e(TAG, "MediaPipe 初始化失败，回退普通推流", e)
                    segmentationProcessor = null
                }
            }

            val videoTrack = peerFactory.createVideoTrack("video0", source)
            localVideoTrack = videoTrack
            videoTrack.addSink(localRenderer)

            val audioConstraints = MediaConstraints()
            val aSource = peerFactory.createAudioSource(audioConstraints)
            audioSource = aSource
            localAudioTrack = peerFactory.createAudioTrack("audio0", aSource)

            isPublishing = true
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                renegotiateAllPeers()
            }, 300)
            Log.i(TAG, "推流已开始")
            true
        } catch (e: Exception) {
            Log.e(TAG, "startPublishing 失败", e)
            stopPublishing()
            false
        }
    }

    fun subscribe(publisherId: String) {
        if (publisherId == localDeviceId) return
        val key = peerKey(publisherId)
        if (peerConnections.containsKey(key)) return

        ensureReceiveReady()
        val pc = getOrCreatePeerConnection(publisherId)
        attachLocalTracks(pc)
        makingOffer.add(key)

        pc.createOffer(object : SdpObserver {
            override fun onCreateSuccess(offer: SessionDescription?) {
                offer ?: return
                pc.setLocalDescription(object : SdpObserver {
                    override fun onCreateSuccess(desc: SessionDescription?) {}
                    override fun onSetSuccess() {
                        makingOffer.remove(key)
                        sendSdp("offer", offer, publisherId)
                        signaling.send(
                            "subscribe",
                            mapOf("publisherId" to publisherId, "streamType" to STREAM_TYPE)
                        )
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
        }, MediaConstraints())
    }

    fun handleSignalingMessage(msg: SignalingClient.SignalingMessage) {
        when (msg.type) {
            "peer_joined" -> {
                val deviceId = msg.payload?.getAsJsonObject("device")?.get("id")?.asString ?: return
                if (deviceId == localDeviceId) return
                notePeerJoined(deviceId)
                // 手机作为采集端：仅主动推流，不 subscribe 电脑（避免双向 offer 冲突）
                if (isPublishing) {
                    offerStreamToPeer(deviceId)
                }
            }
            "offer" -> handleOffer(msg)
            "answer" -> handleAnswer(msg)
            "ice" -> handleIceCandidate(msg)
            "subscribe" -> {
                val publisherId = msg.payload?.get("publisherId")?.asString ?: return
                val subscriberId = msg.payload?.get("subscriberId")?.asString ?: return
                if (publisherId == localDeviceId && subscriberId != localDeviceId && isPublishing) {
                    offerStreamToPeer(subscriberId)
                }
            }
        }
    }

    fun stopPublishing() {
        isPublishing = false
        videoCapturer?.stopCapture()
        videoCapturer?.dispose()
        videoCapturer = null

        segmentationProcessor?.release()
        segmentationProcessor = null

        localVideoTrack?.removeSink(localRenderer)
        localVideoTrack?.dispose()
        localAudioTrack?.dispose()
        videoSource?.dispose()
        audioSource?.dispose()
        localVideoTrack = null
        localAudioTrack = null
    }

    fun release() {
        stopPublishing()
        peerConnections.values.forEach { it.close() }
        peerConnections.clear()
        pendingIce.clear()
        makingOffer.clear()
        factory?.dispose()
        factory = null
        receiveReady = false
        localRendererInitialized = false
        localRenderer.release()
        remoteRenderer?.release()
    }

    private fun initializeFactory() {
        if (factory != null) return

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )

        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(
                DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)
            )
            .setVideoDecoderFactory(
                DefaultVideoDecoderFactory(eglBase.eglBaseContext)
            )
            .createPeerConnectionFactory()
    }

    private fun createCameraCapturer(): CameraVideoCapturer? {
        val enumerator = Camera2Enumerator(context)
        val deviceNames = enumerator.deviceNames

        for (name in deviceNames) {
            if (enumerator.isFrontFacing(name)) {
                return enumerator.createCapturer(name, null)
            }
        }
        for (name in deviceNames) {
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
            if (sender != null) sender.setTrack(track, true) else pc.addTrack(track, listOf("stream0"))
        }
        localAudioTrack?.let { track ->
            val sender = pc.senders.firstOrNull { it.track()?.kind() == "audio" }
            if (sender != null) sender.setTrack(track, true) else pc.addTrack(track, listOf("stream0"))
        }
    }

    private fun offerStreamToPeer(remoteId: String) {
        if (!isPublishing || remoteId == localDeviceId) return
        ensureReceiveReady()
        val key = peerKey(remoteId)
        val pc = getOrCreatePeerConnection(remoteId)
        attachLocalTracks(pc)
        makingOffer.add(key)

        pc.createOffer(object : SdpObserver {
            override fun onCreateSuccess(offer: SessionDescription?) {
                offer ?: return
                pc.setLocalDescription(object : SdpObserver {
                    override fun onCreateSuccess(desc: SessionDescription?) {}
                    override fun onSetSuccess() {
                        makingOffer.remove(key)
                        sendSdp("offer", offer, remoteId)
                    }
                    override fun onCreateFailure(error: String?) {
                        makingOffer.remove(key)
                        Log.e(TAG, "setLocalDescription(re-offer) 失败: $error")
                    }
                    override fun onSetFailure(error: String?) {
                        makingOffer.remove(key)
                        Log.e(TAG, "setLocalDescription(re-offer) 失败: $error")
                    }
                }, offer)
            }
            override fun onSetSuccess() {}
            override fun onCreateFailure(error: String?) {
                makingOffer.remove(key)
                Log.e(TAG, "createOffer(renegotiate) 失败: $error")
            }
            override fun onSetFailure(error: String?) {
                makingOffer.remove(key)
            }
        }, MediaConstraints())
    }

    fun renegotiateAllPeers() {
        val targets = (peerConnections.keys.map { it.substringBefore(':') } + knownPeerIds)
            .filter { it != localDeviceId }
            .distinct()
        Log.i(TAG, "向 ${targets.size} 个设备重协商推流: $targets")
        targets.forEach { offerStreamToPeer(it) }
    }

    private fun getOrCreatePeerConnection(remoteId: String): PeerConnection {
        val key = peerKey(remoteId)
        peerConnections[key]?.let { return it }

        val rtcConfig = PeerConnection.RTCConfiguration(activeIceServers()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

        val pc = factory!!.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
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
                )
            }

            override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
                val track = receiver?.track()
                if (track is VideoTrack && remoteRenderer != null) {
                    track.addSink(remoteRenderer)
                    Log.i(TAG, "收到远端视频: $remoteId")
                }
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                Log.d(TAG, "ICE 状态 $remoteId: $state")
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
            override fun onAddStream(stream: MediaStream?) {}
            override fun onRemoveStream(stream: MediaStream?) {}
            override fun onDataChannel(channel: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
        })!!

        attachLocalTracks(pc)
        peerConnections[key] = pc
        return pc
    }

    private fun waitForSignalingStable(
        pc: PeerConnection,
        onStable: () -> Unit,
        timeoutMs: Long = 5000,
        intervalMs: Long = 50
    ) {
        if (pc.signalingState() == PeerConnection.SignalingState.STABLE) {
            onStable()
            return
        }

        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        val startedAt = System.currentTimeMillis()
        val check = object : Runnable {
            override fun run() {
                when {
                    pc.signalingState() == PeerConnection.SignalingState.STABLE -> onStable()
                    System.currentTimeMillis() - startedAt >= timeoutMs -> {
                        Log.w(TAG, "等待 signaling stable 超时，继续处理 offer")
                        onStable()
                    }
                    else -> handler.postDelayed(this, intervalMs)
                }
            }
        }
        handler.post(check)
    }

    private fun rollbackAndAnswerOffer(
        pc: PeerConnection,
        key: String,
        sdp: SessionDescription,
        from: String
    ) {
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
                                    Log.e(TAG, "setLocalDescription 失败: $error")
                                }
                                override fun onSetFailure(error: String?) {
                                    Log.e(TAG, "setLocalDescription 失败: $error")
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
                    Log.e(TAG, "setRemoteDescription 失败: $error")
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
            override fun onSetSuccess() {
                if (pc.signalingState() == PeerConnection.SignalingState.STABLE) {
                    answerOffer()
                } else {
                    waitForSignalingStable(pc, onStable = { answerOffer() })
                }
            }
            override fun onCreateFailure(error: String?) {
                waitForSignalingStable(pc, onStable = { answerOffer() })
            }
            override fun onSetFailure(error: String?) {
                Log.e(TAG, "rollback 失败: $error")
                waitForSignalingStable(pc, onStable = { answerOffer() })
            }
        }, SessionDescription(SessionDescription.Type.ROLLBACK, ""))
    }

    private fun handleOffer(msg: SignalingClient.SignalingMessage) {
        val from = msg.from ?: return
        if (from == localDeviceId) return

        ensureReceiveReady()

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

        val candidate = IceCandidate(
            candidateObj.get("sdpMid")?.asString,
            candidateObj.get("sdpMLineIndex")?.asInt ?: 0,
            candidateObj.get("candidate")?.asString ?: return
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
        signaling.send(
            type,
            mapOf(
                "sdp" to mapOf("type" to sdp.type.canonicalForm(), "sdp" to sdp.description),
                "streamType" to STREAM_TYPE,
                "targetId" to to
            ),
            to = to
        )
    }
}
