import { SignalingClient } from './signaling';
import { getCachedIceServers } from './ice';
import { createSegmentedStream } from './segmentation';
import { RemoteStream, StreamType } from '../types';

const LOW_QUALITY_VIDEO: MediaTrackConstraints = { width: 640, height: 480, frameRate: 20 };
const HIGH_QUALITY_VIDEO: MediaTrackConstraints = { width: 1280, height: 720, frameRate: 30 };

/**
 * WebRTC 投屏约定（手机 → 电脑）：
 * 1. 电脑只发 subscribe，不发 offer
 * 2. 手机收到 subscribe 后发 offer
 * 3. 电脑收到 offer 后 answer
 * 4. ICE 交换完成后 ontrack 显示画面
 */
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
  private trackWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

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
      } catch {
        /* ignore */
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

  /** 电脑端订阅手机投屏：只发 subscribe，等手机 offer */
  requestMobileStream(publisherId: string, streamType: StreamType = 'camera'): void {
    if (publisherId === this.localDeviceId) return;
    const key = `${publisherId}:${streamType}`;
    const pc = this.peers.get(key);
    if (pc && this.isReceiving(pc) && this.remoteStreams.has(key)) {
      console.log('[WebRTC] 已在接收画面，跳过 subscribe:', publisherId);
      return;
    }
    if (pc?.signalingState === 'have-local-offer') {
      console.log('[WebRTC] SDP 协商中，跳过 subscribe:', publisherId);
      return;
    }
    if (pc?.signalingState === 'have-remote-offer') {
      console.log('[WebRTC] 已在处理 offer，跳过 subscribe:', publisherId);
      return;
    }
    if (pc) {
      console.warn('[WebRTC] 重置旧连接并重新 subscribe:', publisherId, pc.connectionState);
      this.closeSubscriberPc(key);
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
    console.log(ok ? '[WebRTC] subscribe 已发送:' : '[WebRTC] subscribe 失败:', publisherId);
  }

  /** @deprecated 使用 requestMobileStream */
  noteAwaitingPublisher(publisherId: string, streamType: StreamType = 'camera'): void {
    this.requestMobileStream(publisherId, streamType);
  }

  unsubscribe(publisherId: string, streamType: StreamType = 'camera'): void {
    const key = `${publisherId}:${streamType}`;
    this.peers.get(key)?.close();
    this.peers.delete(key);
    this.remoteStreams.delete(key);
    this.pendingCandidates.delete(key);
    this.makingOffer.delete(key);
    this.notifyStreams();
  }

  private isReceiving(pc: RTCPeerConnection): boolean {
    return (
      (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') &&
      pc.connectionState === 'connected'
    );
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
      const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
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

  private async renegotiateAllPeers(): Promise<void> {
    if (!this.localStream) return;
    const remoteIds = new Set<string>();
    for (const key of this.peers.keys()) {
      remoteIds.add(key.split(':')[0]!);
    }
    await Promise.all([...remoteIds].map((id) => this.offerStreamToPeer(id, 'camera')));
  }

  private closeSubscriberPc(key: string): void {
    const watchdog = this.trackWatchdogs.get(key);
    if (watchdog) {
      clearTimeout(watchdog);
      this.trackWatchdogs.delete(key);
    }
    this.peers.get(key)?.close();
    this.peers.delete(key);
    this.remoteStreams.delete(key);
    this.pendingCandidates.delete(key);
    this.makingOffer.delete(key);
  }

  private createSubscriberPc(remoteId: string, streamType: StreamType): RTCPeerConnection {
    const key = `${remoteId}:${streamType}`;
    const savedPending = this.pendingCandidates.get(key) ?? [];
    this.closeSubscriberPc(key);
    if (savedPending.length > 0) {
      this.pendingCandidates.set(key, savedPending);
    }
    const pc = this.createPeerConnection(remoteId, streamType);
    this.peers.set(key, pc);
    return pc;
  }

  private createPeerConnection(remoteId: string, streamType: StreamType): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers.length > 0 ? this.iceServers : getCachedIceServers(),
    });
    const key = `${remoteId}:${streamType}`;

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.signaling.send({
        type: 'ice',
        to: remoteId,
        payload: {
          candidate: event.candidate.toJSON(),
          streamType,
          targetId: remoteId,
        },
      });
    };

    pc.ontrack = (event) => {
      const track = event.track;
      if (track.kind !== 'video') return;
      track.enabled = true;

      const stream = event.streams[0] ?? new MediaStream([track]);
      const publish = () => {
        this.trackWatchdogs.delete(key);
        this.remoteStreams.set(key, {
          deviceId: remoteId,
          streamType,
          stream,
          // 网格/缩略图始终直接播视频；3D 绿幕抠图单独处理
          hasAlpha: this.deviceAlpha.get(remoteId) ?? false,
        });
        console.info('[WebRTC] 收到手机画面:', remoteId, 'tracks:', stream.getVideoTracks().length);
        this.notifyStreams();
      };

      track.onunmute = publish;
      if (track.readyState === 'live' && !track.muted) {
        publish();
      } else {
        publish();
      }
    };

    pc.onconnectionstatechange = () => {
      console.info('[WebRTC] connection:', remoteId, pc.connectionState);
      if (pc.connectionState === 'connected' && !this.remoteStreams.has(key)) {
        const watchdog = setTimeout(() => {
          if (this.peers.get(key) !== pc || this.remoteStreams.has(key)) return;
          console.warn('[WebRTC] 连接成功但 8s 内无画面，重新 subscribe:', remoteId);
          this.closeSubscriberPc(key);
          this.requestMobileStream(remoteId, streamType);
        }, 8000);
        this.trackWatchdogs.set(key, watchdog);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.info('[WebRTC] ice:', remoteId, pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.warn('[WebRTC] ICE 失败，重新 subscribe:', remoteId);
        this.closeSubscriberPc(key);
        this.requestMobileStream(remoteId, streamType);
      }
    };

    return pc;
  }

  private normalizeIceCandidate(raw: unknown): RTCIceCandidateInit | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as RTCIceCandidateInit;
    if (!c.candidate || typeof c.candidate !== 'string') return null;
    let candidate = c.candidate.trim();
    if (!candidate.startsWith('candidate:')) {
      candidate = `candidate:${candidate}`;
    }
    return {
      candidate,
      sdpMid: c.sdpMid ?? null,
      sdpMLineIndex: c.sdpMLineIndex ?? 0,
    };
  }

  private async addIceCandidateSafe(pc: RTCPeerConnection, init: RTCIceCandidateInit): Promise<void> {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(init));
    } catch (err) {
      console.warn('[WebRTC] addIceCandidate 失败:', err);
    }
  }

  private async drainPendingIce(key: string, pc: RTCPeerConnection): Promise<void> {
    const pending = this.pendingCandidates.get(key) ?? [];
    this.pendingCandidates.delete(key);
    for (const c of pending) {
      await this.addIceCandidateSafe(pc, c);
    }
  }

  private async handleSignaling(msg: import('../types').SignalingMessage): Promise<void> {
    const streamType = (msg.payload.streamType as StreamType) ?? 'camera';

    switch (msg.type) {
      case 'peer_joined': {
        const device = msg.payload.device as { id: string };
        if (device.id === this.localDeviceId) break;
        if (this.localStream) {
          await this.offerStreamToPeer(device.id, streamType);
        }
        break;
      }

      case 'offer': {
        if (!msg.from) return;
        const key = `${msg.from}:${streamType}`;
        const sdp = msg.payload.sdp as RTCSessionDescriptionInit;
        console.log('[WebRTC] 收到手机 offer:', msg.from);

        const pc = this.createSubscriberPc(msg.from, streamType);
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await this.drainPendingIce(key, pc);
          this.signaling.send({
            type: 'answer',
            to: msg.from,
            payload: { sdp: answer, streamType, targetId: msg.from },
          });
          console.log('[WebRTC] answer 已发送:', msg.from, 'signaling:', pc.signalingState);
        } catch (err) {
          console.error('[WebRTC] 处理 offer 失败:', err);
          this.closeSubscriberPc(key);
        }
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
          await this.drainPendingIce(key, pc);
        } catch (err) {
          console.error('[WebRTC] 处理 answer 失败:', err);
        }
        break;
      }

      case 'ice': {
        if (!msg.from) return;
        const key = `${msg.from}:${streamType}`;
        const pc = this.peers.get(key);
        const candidate = this.normalizeIceCandidate(msg.payload.candidate);
        if (!candidate) return;
        if (pc?.remoteDescription) {
          await this.addIceCandidateSafe(pc, candidate);
        } else if (pc?.localDescription) {
          await this.addIceCandidateSafe(pc, candidate);
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
    for (const t of this.trackWatchdogs.values()) clearTimeout(t);
    this.trackWatchdogs.clear();
  }
}

declare global {
  interface MediaStream {
    _hasAlpha?: boolean;
  }
}
