import { SignalingClient } from './signaling';
import { getCachedIceServers } from './ice';
import { createSegmentedStream } from './segmentation';
import { RemoteStream, StreamType } from '../types';

const LOW_QUALITY_VIDEO: MediaTrackConstraints = { width: 640, height: 480, frameRate: 20 };
const HIGH_QUALITY_VIDEO: MediaTrackConstraints = { width: 1280, height: 720, frameRate: 30 };

export class WebRTCManager {
  private localStream: MediaStream | null = null;
  private segmentedStop: (() => void) | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private remoteStreams = new Map<string, RemoteStream>();
  private onRemoteStream?: (streams: Map<string, RemoteStream>) => void;
  private deviceAlpha = new Map<string, boolean>();
  private iceServers: RTCIceServer[] = getCachedIceServers();
  private lowQualityMode = false;
  private makingOffer = new Set<string>();
  private unregisterSignaling: (() => void) | null = null;
  private onPeerFailed?: (remoteId: string, streamType: StreamType) => void;

  constructor(
    private signaling: SignalingClient,
    private localDeviceId: string
  ) {
    this.unregisterSignaling = this.signaling.onMessage((msg) => {
      void this.handleSignaling(msg);
    });
  }

  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = servers;
    const config: RTCConfiguration = { iceServers: servers };
    for (const pc of this.peers.values()) {
      try {
        pc.setConfiguration(config);
      } catch (err) {
        console.warn('[WebRTC] 更新 ICE 配置失败', err);
      }
    }
  }

  getPeerConnections(): Map<string, RTCPeerConnection> {
    return this.peers;
  }

  async setQualityMode(low: boolean): Promise<void> {
    if (this.lowQualityMode === low || !this.localStream) return;
    this.lowQualityMode = low;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (!videoTrack) return;
    try {
      await videoTrack.applyConstraints(low ? LOW_QUALITY_VIDEO : HIGH_QUALITY_VIDEO);
    } catch {
      /* ignore */
    }
  }

  setRemoteStreamCallback(cb: (streams: Map<string, RemoteStream>) => void): void {
    this.onRemoteStream = cb;
  }

  setPeerFailedCallback(cb: (remoteId: string, streamType: StreamType) => void): void {
    this.onPeerFailed = cb;
  }

  setDeviceAlpha(deviceId: string, hasAlpha: boolean): void {
    this.deviceAlpha.set(deviceId, hasAlpha);
    const key = `${deviceId}:camera`;
    const existing = this.remoteStreams.get(key);
    if (existing && existing.hasAlpha !== hasAlpha) {
      this.remoteStreams.set(key, { ...existing, hasAlpha });
      this.notifyStreams();
    }
  }

  async startPublishing(streamTypes: StreamType[] = ['camera'], hasAlpha = false): Promise<MediaStream> {
    const tracks: MediaStreamTrack[] = [];

    if (streamTypes.includes('camera')) {
      const camera = await navigator.mediaDevices.getUserMedia({
        video: this.lowQualityMode ? LOW_QUALITY_VIDEO : HIGH_QUALITY_VIDEO,
        audio: true,
      });
      tracks.push(...camera.getTracks());
    }

    if (streamTypes.includes('screen')) {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1920, height: 1080, frameRate: 30 },
        audio: true,
      });
      tracks.push(...screen.getTracks());
    }

    this.localStream?.getTracks().forEach((t) => t.stop());
    this.segmentedStop?.();
    this.segmentedStop = null;

    let stream: MediaStream;
    if (hasAlpha && streamTypes.includes('camera')) {
      const raw = new MediaStream(tracks);
      const { stream: segmented, stop } = createSegmentedStream(raw, true);
      this.segmentedStop = stop;
      stream = segmented;
    } else {
      stream = new MediaStream(tracks);
    }

    this.localStream = stream;
    this.localStream._hasAlpha = hasAlpha;
    await this.renegotiateAllPeers();
    return this.localStream;
  }

  stopPublishing(): void {
    this.segmentedStop?.();
    this.segmentedStop = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }

  async subscribe(publisherId: string, streamType: StreamType = 'camera'): Promise<void> {
    if (publisherId === this.localDeviceId) return;

    const key = `${publisherId}:${streamType}`;
    if (this.peers.has(key)) return;

    const pc = this.createPeerConnection(publisherId, streamType);
    this.peers.set(key, pc);
    this.attachLocalTracks(pc);
    this.ensureRecvTransceivers(pc);

    this.makingOffer.add(key);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.send({
        type: 'offer',
        to: publisherId,
        payload: { sdp: offer, streamType, targetId: publisherId },
      });
    } finally {
      this.makingOffer.delete(key);
    }
  }

  /** 手机端开始投屏后会主动发 offer；电脑端只发 subscribe，等 offer 到达再建 PC */
  noteAwaitingPublisher(publisherId: string, streamType: StreamType = 'camera'): void {
    if (publisherId === this.localDeviceId) return;
    const key = `${publisherId}:${streamType}`;
    const pc = this.peers.get(key);
    if (
      pc &&
      (pc.connectionState === 'failed' ||
        pc.connectionState === 'closed' ||
        pc.connectionState === 'disconnected')
    ) {
      pc.close();
      this.peers.delete(key);
      this.remoteStreams.delete(key);
    }
    const ok = this.signaling.send({
      type: 'subscribe',
      to: publisherId,
      payload: {
        publisherId,
        subscriberId: this.localDeviceId,
        streamType,
      },
    });
    if (!ok) {
      console.warn('[WebRTC] subscribe 发送失败，等待发布端:', publisherId);
    }
  }

  private ensureRecvTransceivers(pc: RTCPeerConnection): void {
    const transceivers = pc.getTransceivers();
    const hasVideoRecv = transceivers.some(
      (t) =>
        t.direction === 'recvonly' ||
        t.direction === 'sendrecv' ||
        t.receiver.track?.kind === 'video'
    );
    const hasAudioRecv = transceivers.some(
      (t) =>
        t.direction === 'recvonly' ||
        t.direction === 'sendrecv' ||
        t.receiver.track?.kind === 'audio'
    );
    if (!hasVideoRecv) {
      try {
        pc.addTransceiver('video', { direction: 'recvonly' });
      } catch {
        /* ignore */
      }
    }
    if (!hasAudioRecv) {
      try {
        pc.addTransceiver('audio', { direction: 'recvonly' });
      } catch {
        /* ignore */
      }
    }
  }

  unsubscribe(publisherId: string, streamType: StreamType = 'camera'): void {
    const key = `${publisherId}:${streamType}`;
    const pc = this.peers.get(key);
    if (pc) {
      pc.close();
      this.peers.delete(key);
    }
    this.remoteStreams.delete(key);
    this.notifyStreams();
  }

  private attachLocalTracks(pc: RTCPeerConnection): void {
    if (!this.localStream) return;
    for (const track of this.localStream.getTracks()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === track.kind);
      if (sender) {
        void sender.replaceTrack(track);
      } else {
        pc.addTrack(track, this.localStream);
      }
    }
  }

  /** 作为发布方，向订阅者推送本地媒体轨 */
  private async offerStreamToPeer(remoteId: string, streamType: StreamType = 'camera'): Promise<void> {
    if (!this.localStream || remoteId === this.localDeviceId) return;

    const key = `${remoteId}:${streamType}`;
    if (this.makingOffer.has(key)) return;

    let pc = this.peers.get(key);
    if (!pc) {
      pc = this.createPeerConnection(remoteId, streamType);
      this.peers.set(key, pc);
    }

    this.attachLocalTracks(pc);

    this.makingOffer.add(key);
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);
      this.signaling.send({
        type: 'offer',
        to: remoteId,
        payload: { sdp: offer, streamType, targetId: remoteId },
      });
    } finally {
      this.makingOffer.delete(key);
    }
  }

  /** 手机端开始投屏后，主动向房间内已知设备推送画面 */
  async publishToPeers(peerIds: string[]): Promise<void> {
    if (!this.localStream) return;
    const targets = peerIds.filter((id) => id !== this.localDeviceId);
    await Promise.all(targets.map((id) => this.offerStreamToPeer(id, 'camera')));
  }

  private async renegotiateAllPeers(): Promise<void> {
    if (!this.localStream) return;
    const remoteIds = new Set<string>();
    for (const key of this.peers.keys()) {
      remoteIds.add(key.split(':')[0]!);
    }
    await Promise.all([...remoteIds].map((id) => this.offerStreamToPeer(id, 'camera')));
  }

  private waitForSignalingStable(pc: RTCPeerConnection, timeoutMs = 5000): Promise<void> {
    if (pc.signalingState === 'stable') return Promise.resolve();

    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pc.removeEventListener('signalingstatechange', onChange);
        resolve();
      }, timeoutMs);

      const onChange = () => {
        if (pc.signalingState === 'stable') {
          window.clearTimeout(timer);
          pc.removeEventListener('signalingstatechange', onChange);
          resolve();
        }
      };

      pc.addEventListener('signalingstatechange', onChange);
    });
  }

  private serializeIceCandidate(candidate: RTCIceCandidate): RTCIceCandidateInit {
    if (typeof candidate.toJSON === 'function') {
      return candidate.toJSON();
    }
    return {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    };
  }

  private normalizeIceCandidate(raw: unknown): RTCIceCandidateInit | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as RTCIceCandidateInit;
    if (!c.candidate || typeof c.candidate !== 'string') return null;
    return {
      candidate: c.candidate,
      sdpMid: c.sdpMid ?? null,
      sdpMLineIndex: c.sdpMLineIndex ?? 0,
    };
  }

  private createPeerConnection(remoteId: string, streamType: StreamType): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers.length > 0 ? this.iceServers : getCachedIceServers(),
      iceCandidatePoolSize: 4,
    });
    const key = `${remoteId}:${streamType}`;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({
          type: 'ice',
          to: remoteId,
          payload: {
            candidate: this.serializeIceCandidate(event.candidate),
            streamType,
            targetId: remoteId,
          },
        });
      }
    };

    pc.ontrack = (event) => {
      const track = event.track;
      track.enabled = true;
      const stream = event.streams[0] ?? new MediaStream([track]);
      this.remoteStreams.set(key, {
        deviceId: remoteId,
        streamType,
        stream,
        hasAlpha: this.deviceAlpha.get(remoteId) ?? false,
      });
      console.info('[WebRTC] ontrack', remoteId, track.kind, track.readyState);
      this.notifyStreams();
    };

    pc.onconnectionstatechange = () => {
      console.info('[WebRTC] connectionState', remoteId, pc.connectionState, 'ice', pc.iceConnectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.peers.delete(key);
        this.remoteStreams.delete(key);
        this.notifyStreams();
        this.onPeerFailed?.(remoteId, streamType);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.info('[WebRTC] iceConnectionState', remoteId, pc.iceConnectionState);
    };

    return pc;
  }

  private async handleSignaling(msg: import('../types').SignalingMessage): Promise<void> {
    const streamType = (msg.payload.streamType as StreamType) ?? 'camera';

    switch (msg.type) {
      case 'peer_joined': {
        const device = msg.payload.device as { id: string; type: 'mobile' | 'desktop' };
        if (device.id === this.localDeviceId) break;
        if (this.localStream) {
          await this.offerStreamToPeer(device.id, streamType);
        }
        break;
      }

      case 'offer': {
        if (!msg.from) return;
        const key = `${msg.from}:${streamType}`;

        // 作为订阅方应答：不在 setRemoteDescription 之前预建 recv transceiver，避免 m-line 错位
        let pc = this.peers.get(key);
        if (pc) {
          pc.close();
          this.peers.delete(key);
          this.remoteStreams.delete(key);
        }
        pc = this.createPeerConnection(msg.from, streamType);
        this.peers.set(key, pc);

        const sdp = msg.payload.sdp as RTCSessionDescriptionInit;
        console.log('[WebRTC] 收到 offer:', msg.from, 'SDP 长度:', sdp.sdp?.length);

        const offerCollision = this.makingOffer.has(key) || pc.signalingState !== 'stable';
        if (offerCollision) {
          let rollbackFailed = false;
          try {
            await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
          } catch {
            rollbackFailed = true;
          }
          if (rollbackFailed || pc.signalingState !== 'stable') {
            await this.waitForSignalingStable(pc);
          }
        }

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (err) {
          console.error('[WebRTC] setRemoteDescription(offer) failed', err);
          return;
        }

        console.log('[WebRTC] setRemoteDescription 成功，transceivers:', pc.getTransceivers().length);

        for (const t of pc.getTransceivers()) {
          if (t.receiver.track?.kind === 'video') {
            if (t.direction !== 'recvonly' && t.direction !== 'sendrecv') {
              t.direction = 'recvonly';
            }
          }
        }

        const pending = this.pendingCandidates.get(key) ?? [];
        for (const c of pending) {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        }
        this.pendingCandidates.delete(key);
        this.makingOffer.delete(key);

        const answer = await pc.createAnswer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: true,
        });
        console.log('[WebRTC] createAnswer 成功，answer SDP 长度:', answer.sdp?.length);
        await pc.setLocalDescription(answer);

        console.log('[WebRTC] 发送 answer 给', msg.from);
        console.info('[WebRTC] answer sent to', msg.from, 'senders', pc.getSenders().length);

        this.signaling.send({
          type: 'answer',
          to: msg.from,
          payload: { sdp: answer, streamType, targetId: msg.from },
        });
        break;
      }

      case 'answer': {
        if (!msg.from) return;
        const key = `${msg.from}:${streamType}`;
        const pc = this.peers.get(key);
        if (!pc) return;
        const sdp = msg.payload.sdp as RTCSessionDescriptionInit;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (err) {
          console.error('[WebRTC] setRemoteDescription(answer) failed', err);
          return;
        }
        const pending = this.pendingCandidates.get(key) ?? [];
        for (const c of pending) {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        }
        this.pendingCandidates.delete(key);
        this.makingOffer.delete(key);
        break;
      }

      case 'ice': {
        if (!msg.from) return;
        const key = `${msg.from}:${streamType}`;
        const pc = this.peers.get(key);
        const candidate = this.normalizeIceCandidate(msg.payload.candidate);
        if (!candidate) {
          console.warn('[WebRTC] 忽略无效 ICE candidate', msg.from);
          return;
        }
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          const pending = this.pendingCandidates.get(key) ?? [];
          pending.push(candidate);
          this.pendingCandidates.set(key, pending);
        }
        break;
      }

      case 'subscribe': {
        const publisherId = msg.payload.publisherId as string;
        const subscriberId = msg.payload.subscriberId as string;
        if (publisherId !== this.localDeviceId || subscriberId === this.localDeviceId) return;
        if (this.localStream) {
          await this.offerStreamToPeer(subscriberId, streamType);
        }
        break;
      }
    }
  }

  private notifyStreams(): void {
    this.onRemoteStream?.(new Map(this.remoteStreams));
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStreams(): Map<string, RemoteStream> {
    return this.remoteStreams;
  }

  destroy(): void {
    this.unregisterSignaling?.();
    this.unregisterSignaling = null;
    this.stopPublishing();
    this.peers.forEach((pc) => pc.close());
    this.peers.clear();
    this.remoteStreams.clear();
    this.pendingCandidates.clear();
    this.makingOffer.clear();
    this.deviceAlpha.clear();
  }
}

declare global {
  interface MediaStream {
    _hasAlpha?: boolean;
  }
}
