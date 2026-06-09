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
    private val localDeviceId: String,
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

    private val iceServers = listOf(
        IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
        IceServer.builder("stun:stun1.l.google.com:19302").createIceServer()
    )

    fun startPublishing(enableSegmentation: Boolean): Boolean {
        if (isPublishing) return true
        initializeFactory()

        localRenderer.init(eglBase.eglBaseContext, null)
        localRenderer.setMirror(true)
        localRenderer.setEnableHardwareScaler(true)

        remoteRenderer?.init(eglBase.eglBaseContext, null)
        remoteRenderer?.setMirror(false)
        remoteRenderer?.setEnableHardwareScaler(true)

        val capturer = createCameraCapturer() ?: run {
            Log.e(TAG, "无法打开摄像头")
            return false
        }
        videoCapturer = capturer

        videoSource = factory!!.createVideoSource(capturer.isScreencast)
        capturer.initialize(
            SurfaceTextureHelper.create("CaptureThread", eglBase.eglBaseContext),
            context,
            videoSource!!.capturerObserver
        )
        capturer.startCapture(1280, 720, 30)

        if (enableSegmentation) {
            segmentationProcessor = SegmentationProcessor(context).also { it.setEnabled(true) }
            videoSource!!.setVideoProcessor(segmentationProcessor)
            Log.i(TAG, "MediaPipe 人像抠图已启用")
        }

        localVideoTrack = factory!!.createVideoTrack("video0", videoSource!!)
        localVideoTrack!!.addSink(localRenderer)

        val audioConstraints = MediaConstraints()
        audioSource = factory!!.createAudioSource(audioConstraints)
        localAudioTrack = factory!!.createAudioTrack("audio0", audioSource!!)

        isPublishing = true
        Log.i(TAG, "推流已开始")
        return true
    }

    fun handleSignalingMessage(msg: SignalingClient.SignalingMessage) {
        when (msg.type) {
            "peer_joined" -> {
                val deviceId = msg.payload?.getAsJsonObject("device")?.get("id")?.asString ?: return
                if (deviceId != localDeviceId && isPublishing) {
                    // 等待对方发送 offer
                }
            }
            "offer" -> handleOffer(msg)
            "answer" -> handleAnswer(msg)
            "ice" -> handleIceCandidate(msg)
            "subscribe" -> {
                val subscriberId = msg.payload?.get("subscriberId")?.asString ?: return
                if (subscriberId != localDeviceId && isPublishing) {
                    // Web 端会主动发 offer，此处无需动作
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

        localVideoTrack?.dispose()
        localAudioTrack?.dispose()
        videoSource?.dispose()
        audioSource?.dispose()
        localVideoTrack = null
        localAudioTrack = null

        peerConnections.values.forEach { it.close() }
        peerConnections.clear()
        pendingIce.clear()
    }

    fun release() {
        stopPublishing()
        factory?.dispose()
        factory = null
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

        // 优先前置摄像头
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

    private fun getOrCreatePeerConnection(remoteId: String): PeerConnection {
        val key = peerKey(remoteId)
        peerConnections[key]?.let { return it }

        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
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

        if (isPublishing) {
            localVideoTrack?.let { pc.addTrack(it, listOf("stream0")) }
            localAudioTrack?.let { pc.addTrack(it, listOf("stream0")) }
        }

        peerConnections[key] = pc
        return pc
    }

    private fun handleOffer(msg: SignalingClient.SignalingMessage) {
        val from = msg.from ?: return
        if (from == localDeviceId) return

        val sdpJson = msg.payload?.getAsJsonObject("sdp") ?: return
        val sdp = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(sdpJson.get("type").asString),
            sdpJson.get("sdp").asString
        )

        val pc = getOrCreatePeerConnection(from)
        pc.setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription?) {}
            override fun onSetSuccess() {
                drainPendingIce(from)
                pc.createAnswer(object : SdpObserver {
                    override fun onCreateSuccess(answer: SessionDescription?) {
                        answer ?: return
                        pc.setLocalDescription(object : SdpObserver {
                            override fun onCreateSuccess(desc: SessionDescription?) {}
                            override fun onSetSuccess() {
                                signaling.send(
                                    "answer",
                                    mapOf(
                                        "sdp" to mapOf("type" to answer.type.canonicalForm(), "sdp" to answer.description),
                                        "streamType" to STREAM_TYPE,
                                        "targetId" to from
                                    ),
                                    to = from
                                )
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
            override fun onSetSuccess() { drainPendingIce(from) }
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
}
