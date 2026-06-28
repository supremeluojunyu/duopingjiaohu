import { SignalingClient } from './signaling';
import { getCachedIceServers } from './ice';
import { createSegmentedStream } from './segmentation';
import { castLog } from '../utils/castLog';
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
  private lastSubscribeSent = new Map<string, number>();

  private streamKey(remoteId: string, streamType: StreamType): string {
    return `${remoteId}:${streamType}`;
  }

  private subscriberPcKey(remoteId: string, streamType: StreamType): string {
    return `${this.streamKey(remoteId, streamType)}:sub`;
  }

  private publisherPcKey(remoteId: string, streamType: StreamType): string {
    return `${this.streamKey(remoteId, streamType)}:pub`;
  }

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

  /** 仅返回订阅端 PC（用于性能监控 inbound 统计） */
  getSubscriberPeerConnections(): Map<string, RTCPeerConnection> {
    const result = new Map<string, RTCPeerConnection>();
    for (const [key, pc] of this.peers) {
      if (key.endsWith(':sub')) result.set(key, pc);
    }
    return result;
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

  /** 电脑端订阅手机投屏：只发 subscribe，等手机 offer（不在此预建 PC，避免协商中途被 reset） */
  requestMobileStream(publisherId: string, streamType: StreamType = 'camera'): void {
    if (publisherId === this.localDeviceId) return;
    const streamKey = this.streamKey(publisherId, streamType);
    const subKey = this.subscriberPcKey(publisherId, streamType);
    const pc = this.peers.get(subKey);

    if (pc && this.isReceiving(pc) && this.remoteStreams.has(streamKey)) {
      console.log('[WebRTC] 已在接收画面，跳过 subscribe:', publisherId);
      return;
    }

    if (pc && this.isNegotiating(pc)) {
      console.log('[WebRTC] 协商进行中，仅重发 subscribe:', publisherId, pc.signalingState);
      this.sendSubscribe(publisherId, streamType);
      return;
    }

    if (pc && this.shouldResetSubscriber(pc)) {
      console.warn('[WebRTC] 重置失效连接并 subscribe:', publisherId, pc.connectionState);
      this.closeSubscriberPc(publisherId, streamType);
    } else if (pc) {
      console.log('[WebRTC] 连接仍有效/建立中，重发 subscribe:', publisherId, pc.connectionState);
    }

    this.sendSubscribe(publisherId, streamType);
  }

  private sendSubscribe(publisherId: string, streamType: StreamType, attempt = 0): void {
    const subKey = this.subscriberPcKey(publisherId, streamType);
    const now = Date.now();
    const last = this.lastSubscribeSent.get(subKey) ?? 0;
    const pc = this.peers.get(subKey);
    if (
      attempt === 0 &&
      now - last < 1500 &&
      pc &&
      (this.isReceiving(pc) || this.isNegotiating(pc))
    ) {
      castLog('subscribe', `去重跳过 ${publisherId.slice(0, 8)}`, 'info');
      return;
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

    if (ok) {
      this.lastSubscribeSent.set(subKey, now);
      castLog('subscribe', `已发送 → ${publisherId.slice(0, 8)}`, 'ok', `subscriber=${this.localDeviceId.slice(0, 8)}`);
      return;
    }

    castLog('subscribe', `发送失败 ${publisherId.slice(0, 8)}`, attempt < 3 ? 'warn' : 'err', `attempt=${attempt}`);
    if (attempt < 3) {
      window.setTimeout(() => this.sendSubscribe(publisherId, streamType, attempt + 1), 500 * (attempt + 1));
    }
  }

  /** @deprecated 使用 requestMobileStream */
  noteAwaitingPublisher(publisherId: string, streamType: StreamType = 'camera'): void {
    this.requestMobileStream(publisherId, streamType);
  }

  unsubscribe(publisherId: string, streamType: StreamType = 'camera'): void {
    const streamKey = this.streamKey(publisherId, streamType);
    const subKey = this.subscriberPcKey(publisherId, streamType);
    this.peers.get(subKey)?.close();
    this.peers.delete(subKey);
    this.remoteStreams.delete(streamKey);
    this.pendingCandidates.delete(subKey);
    this.trackWatchdogs.delete(streamKey);
    this.lastSubscribeSent.delete(subKey);
    this.notifyStreams();
  }

  private isReceiving(pc: RTCPeerConnection): boolean {
    return (
      (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') &&
      pc.connectionState === 'connected'
    );
  }

  /** SDP/ICE 协商进行中，不可 destroy PC */
  private isNegotiating(pc: RTCPeerConnection): boolean {
    const sig = pc.signalingState;
    if (sig === 'have-local-offer' || sig === 'have-remote-offer') return true;
    const ice = pc.iceConnectionState;
    if (ice === 'checking' || ice === 'new') return true;
    const conn = pc.connectionState;
    if (conn === 'connecting' || conn === 'new') return true;
    return false;
  }

  private shouldResetSubscriber(pc: RTCPeerConnection): boolean {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') return true;
    if (pc.iceConnectionState === 'failed') return true;
    return pc.iceConnectionState === 'disconnected' && pc.signalingState === 'stable';
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
    const pubKey = this.publisherPcKey(remoteId, streamType);
    if (this.makingOffer.has(pubKey)) return;

    let pc = this.peers.get(pubKey);
    if (!pc) {
      pc = this.createPeerConnection(remoteId, streamType, null);
      this.peers.set(pubKey, pc);
    }
    this.attachLocalTracks(pc);

    this.makingOffer.add(pubKey);
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      this.signaling.send({
        type: 'offer',
        to: remoteId,
        payload: { sdp: offer, streamType, targetId: remoteId },
      });
    } finally {
      this.makingOffer.delete(pubKey);
    }
  }

  private async renegotiateAllPeers(): Promise<void> {
    if (!this.localStream) return;
    const remoteIds = new Set<string>();
    for (const key of this.peers.keys()) {
      if (key.endsWith(':pub')) {
        remoteIds.add(key.split(':')[0]!);
      }
    }
    await Promise.all([...remoteIds].map((id) => this.offerStreamToPeer(id, 'camera')));
  }

  private closeSubscriberPc(remoteId: string, streamType: StreamType): void {
    const streamKey = this.streamKey(remoteId, streamType);
    const subKey = this.subscriberPcKey(remoteId, streamType);
    const watchdog = this.trackWatchdogs.get(streamKey);
    if (watchdog) {
      clearTimeout(watchdog);
      this.trackWatchdogs.delete(streamKey);
    }
    this.peers.get(subKey)?.close();
    this.peers.delete(subKey);
    this.remoteStreams.delete(streamKey);
    this.pendingCandidates.delete(subKey);
    this.lastSubscribeSent.delete(subKey);
  }

  /** answer 前确保 transceiver 为 recvonly，与手机端 SEND_ONLY offer 对齐 */
  private ensureRecvOnlyTransceivers(pc: RTCPeerConnection): void {
    for (const transceiver of pc.getTransceivers()) {
      const dir = transceiver.direction;
      if (dir === 'sendrecv' || dir === 'sendonly') {
        transceiver.direction = 'recvonly';
      }
    }
  }

  private createSubscriberPc(remoteId: string, streamType: StreamType): RTCPeerConnection {
    const streamKey = this.streamKey(remoteId, streamType);
    const subKey = this.subscriberPcKey(remoteId, streamType);
    const savedPending = this.pendingCandidates.get(subKey) ?? [];
    this.closeSubscriberPc(remoteId, streamType);
    if (savedPending.length > 0) {
      this.pendingCandidates.set(subKey, savedPending);
    }
    const pc = this.createPeerConnection(remoteId, streamType, streamKey);
    this.peers.set(subKey, pc);
    return pc;
  }

  /** @param streamKey 非 null 时为订阅 PC（ontrack 写入 remoteStreams） */
  private createPeerConnection(
    remoteId: string,
    streamType: StreamType,
    streamKey: string | null
  ): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers.length > 0 ? this.iceServers : getCachedIceServers(),
    });
    const subKey = this.subscriberPcKey(remoteId, streamType);

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

    if (streamKey) {
      pc.ontrack = (event) => {
        const track = event.track;
        if (track.kind !== 'video') return;
        track.enabled = true;

        const stream = event.streams[0] ?? new MediaStream([track]);
        const publish = () => {
          this.trackWatchdogs.delete(streamKey);
          this.remoteStreams.set(streamKey, {
            deviceId: remoteId,
            streamType,
            stream,
            hasAlpha: this.deviceAlpha.get(remoteId) ?? false,
          });
          castLog(
            'ontrack',
            `收到画面 ${remoteId.slice(0, 8)}`,
            'ok',
            `tracks=${stream.getVideoTracks().length}`
          );
          this.notifyStreams();
        };

        track.onunmute = publish;
        publish();
      };

      pc.onconnectionstatechange = () => {
        castLog('ice', `connection ${remoteId.slice(0, 8)}: ${pc.connectionState}`, 'info');
        if (pc.connectionState === 'connected' && !this.remoteStreams.has(streamKey)) {
          const watchdog = setTimeout(() => {
            if (this.peers.get(subKey) !== pc || this.remoteStreams.has(streamKey)) return;
            castLog(
              'ontrack',
              `8s 内无画面，重试 subscribe ${remoteId.slice(0, 8)}`,
              'warn'
            );
            this.closeSubscriberPc(remoteId, streamType);
            this.requestMobileStream(remoteId, streamType);
          }, 8000);
          this.trackWatchdogs.set(streamKey, watchdog);
        }
      };

      pc.oniceconnectionstatechange = () => {
        const ice = pc.iceConnectionState;
        const level =
          ice === 'connected' || ice === 'completed'
            ? 'ok'
            : ice === 'failed'
              ? 'err'
              : ice === 'checking'
                ? 'warn'
                : 'info';
        castLog('ice', `${remoteId.slice(0, 8)}: ${ice}`, level);
        if (ice === 'checking') {
          const iceKey = subKey;
          window.setTimeout(() => {
            const current = this.peers.get(iceKey);
            if (!current || current !== pc) return;
            if (
              current.iceConnectionState === 'checking' ||
              current.iceConnectionState === 'new'
            ) {
              castLog(
                'ice',
                `${remoteId.slice(0, 8)} 长时间 checking`,
                'warn',
                '检查 STUN/网络，建议同一 WiFi'
              );
            }
          }, 15000);
        }
        if (ice === 'failed') {
          castLog('ice', `ICE 失败，重试 ${remoteId.slice(0, 8)}`, 'err');
          this.closeSubscriberPc(remoteId, streamType);
          this.requestMobileStream(remoteId, streamType);
        }
      };
    }

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
        const subKey = this.subscriberPcKey(msg.from, streamType);
        const sdp = msg.payload.sdp as RTCSessionDescriptionInit;
        castLog('offer', `收到 ← ${msg.from.slice(0, 8)}`, 'ok');

        let pc = this.peers.get(subKey);
        const needsFreshPc =
          !pc ||
          pc.connectionState === 'closed' ||
          pc.signalingState === 'have-local-offer' ||
          this.shouldResetSubscriber(pc);
        if (needsFreshPc) {
          pc = this.createSubscriberPc(msg.from, streamType);
        }
        const activePc = pc;
        if (!activePc) break;
        try {
          await activePc.setRemoteDescription(new RTCSessionDescription(sdp));
          this.ensureRecvOnlyTransceivers(activePc);
          const txInfo = activePc
            .getTransceivers()
            .map((t) => `${t.mid}:${t.direction}:${t.receiver.track?.kind ?? '?'}`)
            .join(', ');
          castLog('offer', `transceivers ${msg.from.slice(0, 8)}`, 'info', txInfo || 'none');
          const answer = await activePc.createAnswer();
          await activePc.setLocalDescription(answer);
          await this.drainPendingIce(subKey, activePc);
          this.signaling.send({
            type: 'answer',
            to: msg.from,
            payload: { sdp: answer, streamType, targetId: msg.from },
          });
          castLog(
            'answer',
            `已发送 → ${msg.from.slice(0, 8)}`,
            'ok',
            `signaling=${activePc.signalingState}`
          );
        } catch (err) {
          castLog('offer', `处理失败 ${msg.from.slice(0, 8)}`, 'err', String(err));
          this.closeSubscriberPc(msg.from, streamType);
        }
        break;
      }

      case 'answer': {
        if (!msg.from) return;
        const pubKey = this.publisherPcKey(msg.from, streamType);
        const pc = this.peers.get(pubKey);
        if (!pc) return;
        const sdp = msg.payload.sdp as RTCSessionDescriptionInit;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          await this.drainPendingIce(pubKey, pc);
        } catch (err) {
          console.error('[WebRTC] 处理 answer 失败:', err);
        }
        break;
      }

      case 'ice': {
        if (!msg.from) return;
        const subKey = this.subscriberPcKey(msg.from, streamType);
        const pubKey = this.publisherPcKey(msg.from, streamType);
        const pc = this.peers.get(subKey) ?? this.peers.get(pubKey);
        const pendingKey = this.peers.has(subKey) ? subKey : pubKey;
        const candidate = this.normalizeIceCandidate(msg.payload.candidate);
        if (!candidate) return;
        if (pc?.remoteDescription) {
          await this.addIceCandidateSafe(pc, candidate);
        } else if (pc?.localDescription) {
          await this.addIceCandidateSafe(pc, candidate);
        } else {
          const pending = this.pendingCandidates.get(pendingKey) ?? [];
          pending.push(candidate);
          this.pendingCandidates.set(pendingKey, pending);
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
    this.lastSubscribeSent.clear();
    for (const t of this.trackWatchdogs.values()) clearTimeout(t);
    this.trackWatchdogs.clear();
  }
}

declare global {
  interface MediaStream {
    _hasAlpha?: boolean;
  }
}
