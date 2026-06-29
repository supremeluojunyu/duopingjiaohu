import { SignalingClient } from './signaling';
import { getCachedIceServers } from './ice';
import { createSegmentedStream } from './segmentation';
import { castLog, getCastEvents, type CastEvent } from '../utils/castLog';
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
  private trackWatchdogs = new Map<string, number>();
  private lastSubscribeSent = new Map<string, number>();
  /** ontrack 早于 ICE 连通时暂存，待 connected 后再发布到 UI */
  private pendingRemoteMedia = new Map<
    string,
    { stream: MediaStream; track: MediaStreamTrack; pc: RTCPeerConnection }
  >();
  private streamRevisions = new Map<string, number>();
  private iceRecoveryTimers = new Map<string, number>();
  /** ICE 直连失败后强制走 TURN relay */
  private relayOnlyPeers = new Set<string>();
  /** 已成功 gather 到 relay 候选的 peer（openrelay 在国内常不可用，无 relay 时不切 relay-only） */
  private relayReadyPeers = new Set<string>();
  /** 远端 host 网段，用于过滤 PC 多网卡虚拟地址 */
  private remoteSubnetByPeer = new Map<string, string>();
  /** 远端已成功 gather relay（手机 TURN 可用） */
  private remoteRelaySeen = new Set<string>();
  /** 本机 host 网段（/24），用于检测 172.26.74 vs 172.26.153 等跨子网 */
  private localHostPrefixes = new Set<string>();
  private relayRetryTimers = new Map<string, number>();

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
    const hasTurn = servers.some((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some((u) => String(u).startsWith('turn:'));
    });
    castLog(
      'ice',
      hasTurn ? `ICE 配置 ${servers.length} 项（含 TURN）` : 'ICE 配置无 TURN',
      hasTurn ? 'info' : 'warn',
      hasTurn ? undefined : '跨网投屏需 coturn，运行 scripts/enable-coturn.sh'
    );
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
  requestMobileStream(publisherId: string, streamType: StreamType = 'camera', force = false): void {
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

    this.sendSubscribe(publisherId, streamType, 0, force);
  }

  private sendSubscribe(
    publisherId: string,
    streamType: StreamType,
    attempt = 0,
    force = false
  ): void {
    const subKey = this.subscriberPcKey(publisherId, streamType);
    const now = Date.now();
    const last = this.lastSubscribeSent.get(subKey) ?? 0;
    const pc = this.peers.get(subKey);
    if (
      !force &&
      attempt === 0 &&
      now - last < 1500 &&
      pc &&
      (this.isReceiving(pc) || this.isNegotiating(pc))
    ) {
      castLog('subscribe', `去重跳过 ${publisherId.slice(0, 8)}`, 'info');
      return;
    }

    const relayOnly = this.relayOnlyPeers.has(publisherId);
    const ok = this.signaling.send({
      type: 'subscribe',
      to: publisherId,
      payload: {
        publisherId,
        subscriberId: this.localDeviceId,
        streamType,
        relayOnly,
      },
    });

    if (ok) {
      this.lastSubscribeSent.set(subKey, now);
      castLog(
        'subscribe',
        `已发送 → ${publisherId.slice(0, 8)}`,
        'ok',
        `subscriber=${this.localDeviceId.slice(0, 8)}${relayOnly ? ' relayOnly' : ''}`
      );
      return;
    }

    castLog('subscribe', `发送失败 ${publisherId.slice(0, 8)}`, attempt < 3 ? 'warn' : 'err', `attempt=${attempt}`);
    if (attempt < 3) {
      window.setTimeout(() => this.sendSubscribe(publisherId, streamType, attempt + 1, force), 500 * (attempt + 1));
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
    const iceTimer = this.iceRecoveryTimers.get(streamKey);
    if (iceTimer) {
      clearTimeout(iceTimer);
      this.iceRecoveryTimers.delete(streamKey);
    }
    this.pendingRemoteMedia.delete(streamKey);
    this.peers.get(subKey)?.close();
    this.peers.delete(subKey);
    this.remoteStreams.delete(streamKey);
    this.pendingCandidates.delete(subKey);
    this.lastSubscribeSent.delete(subKey);
  }

  private isIceMediaReady(pc: RTCPeerConnection): boolean {
    const ice = pc.iceConnectionState;
    const conn = pc.connectionState;
    return (
      ice === 'connected' ||
      ice === 'completed' ||
      conn === 'connected'
    );
  }

  private tryPublishRemoteStream(
    streamKey: string,
    remoteId: string,
    streamType: StreamType,
    stream: MediaStream,
    track: MediaStreamTrack,
    pc: RTCPeerConnection,
    reason: string
  ): boolean {
    if (this.peers.get(this.subscriberPcKey(remoteId, streamType)) !== pc) return false;

    if (!this.isIceMediaReady(pc)) {
      this.pendingRemoteMedia.set(streamKey, { stream, track, pc });
      castLog(
        'ontrack',
        `轨道已协商，等待 ICE ${remoteId.slice(0, 8)}`,
        'warn',
        `ice=${pc.iceConnectionState} reason=${reason}`
      );
      return false;
    }

    this.pendingRemoteMedia.delete(streamKey);
    const rev = (this.streamRevisions.get(streamKey) ?? 0) + 1;
    this.streamRevisions.set(streamKey, rev);
    this.trackWatchdogs.delete(streamKey);
    this.remoteStreams.set(streamKey, {
      deviceId: remoteId,
      streamType,
      stream,
      hasAlpha: this.deviceAlpha.get(remoteId) ?? false,
      rev,
    });
    castLog(
      'ontrack',
      `画面就绪 ${remoteId.slice(0, 8)}`,
      'ok',
      `${reason} rev=${rev} track=${track.readyState}`
    );
    this.notifyStreams();
    return true;
  }

  private flushPendingRemoteStream(streamKey: string, remoteId: string, streamType: StreamType, pc: RTCPeerConnection): void {
    const pending = this.pendingRemoteMedia.get(streamKey);
    if (!pending || pending.pc !== pc) return;
    this.tryPublishRemoteStream(streamKey, remoteId, streamType, pending.stream, pending.track, pc, 'ice-connected');
  }

  private enableRelayOnly(remoteId: string, reason: string): boolean {
    if (this.relayOnlyPeers.has(remoteId)) return false;
    if (!this.relayReadyPeers.has(remoteId) && !this.remoteRelaySeen.has(remoteId)) {
      castLog(
        'ice',
        `跳过 relay-only ${remoteId.slice(0, 8)}`,
        'warn',
        `${reason}（无 TURN 可用）`
      );
      return false;
    }
    this.relayOnlyPeers.add(remoteId);
    castLog('ice', `切换 TURN relay-only ${remoteId.slice(0, 8)}`, 'warn', reason);
    return true;
  }

  /** 8s 后若 ICE 仍未连通：无本地 relay 则重试；双方已有 relay 则强制 relay-only */
  private scheduleRelayFallback(remoteId: string, streamType: StreamType, pc: RTCPeerConnection): void {
    const subKey = this.subscriberPcKey(remoteId, streamType);
    const existing = this.relayRetryTimers.get(subKey);
    if (existing) clearTimeout(existing);
    const timer = window.setTimeout(async () => {
      this.relayRetryTimers.delete(subKey);
      if (this.peers.get(subKey) !== pc) return;
      if (!this.remoteRelaySeen.has(remoteId) || this.relayOnlyPeers.has(remoteId)) return;
      const ice = pc.iceConnectionState;
      if (ice === 'connected' || ice === 'completed') return;
      let localRelay = false;
      try {
        const report = await pc.getStats();
        report.forEach((stat) => {
          if (
            stat.type === 'local-candidate' &&
            (stat as { candidateType?: string }).candidateType === 'relay'
          ) {
            localRelay = true;
          }
        });
      } catch {
        /* ignore */
      }
      if (localRelay) {
        castLog(
          'ice',
          '双方有 TURN 仍未连通',
          'err',
          '腾讯云需放行 UDP 49152-65535；将切换 relay-only 重试'
        );
        this.enableRelayOnly(remoteId, 'relay gather 完成但 ICE 未连通');
        this.closeSubscriberPc(remoteId, streamType);
        this.requestMobileStream(remoteId, streamType, true);
        return;
      }
      castLog('ice', '电脑未获取 TURN，relay-only 重试', 'warn', '124.220.4.69:3478');
      this.relayOnlyPeers.add(remoteId);
      this.closeSubscriberPc(remoteId, streamType);
      this.requestMobileStream(remoteId, streamType, true);
    }, 8000);
    this.relayRetryTimers.set(subKey, timer);
  }

  private maybeForceRelayOnSubnetMismatch(
    remoteId: string,
    streamType: StreamType,
    remoteIp: string
  ): void {
    const remotePrefix = this.ipPrefix(remoteIp);
    const localPrefixes = [...this.localHostPrefixes];
    if (localPrefixes.length === 0) return;
    if (localPrefixes.some((p) => p === remotePrefix)) return;
    if (!this.relayReadyPeers.has(remoteId) && !this.remoteRelaySeen.has(remoteId)) return;
    if (this.relayOnlyPeers.has(remoteId)) return;
    const subKey = this.subscriberPcKey(remoteId, streamType);
    const pc = this.peers.get(subKey);
    if (
      pc &&
      (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')
    ) {
      return;
    }
    castLog(
      'ice',
      '网段不一致',
      'err',
      `PC=[${localPrefixes.join(',')}] 手机=${remotePrefix}.x，切换 relay-only`
    );
    this.enableRelayOnly(remoteId, `子网不一致 ${remotePrefix}`);
    if (pc && pc.connectionState !== 'closed') {
      this.closeSubscriberPc(remoteId, streamType);
      this.requestMobileStream(remoteId, streamType, true);
    }
  }

  private async logIceDiagnostics(pc: RTCPeerConnection, remoteId: string): Promise<void> {
    try {
      const report = await pc.getStats();
      const counts = { host: 0, srflx: 0, relay: 0, mdns: 0, pairFailed: 0 };
      report.forEach((stat) => {
        if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
          const t = (stat as { candidateType?: string }).candidateType;
          const addr = (stat as { address?: string }).address ?? '';
          if (addr.includes('.local')) counts.mdns++;
          if (t === 'host') counts.host++;
          else if (t === 'srflx') counts.srflx++;
          else if (t === 'relay') counts.relay++;
        }
        if (stat.type === 'candidate-pair' && (stat as { state?: string }).state === 'failed') {
          counts.pairFailed++;
        }
      });
      const detail = `host=${counts.host} srflx=${counts.srflx} relay=${counts.relay} mdns=${counts.mdns} 失败对=${counts.pairFailed}`;
      castLog('ice', `ICE 诊断 ${remoteId.slice(0, 8)}`, 'warn', detail);
      const recent = getCastEvents().slice(-30);
      const extractIp = (e: CastEvent) =>
        e.detail?.match(/^\d+\.\d+\.\d+\.\d+$/)?.[0] ??
        e.message.match(/\d+\.\d+\.\d+\.\d+/)?.[0] ??
        '';
      const localIp = recent
        .map((e) => (e.message.includes('本地 host') ? extractIp(e) : ''))
        .find((ip) => ip.length > 0);
      const remoteIp = recent
        .map((e) => (e.message.includes('收到远端 host') ? extractIp(e) : ''))
        .find((ip) => ip.length > 0);
      if (localIp && remoteIp) {
        const localPrefixes = recent
          .filter((e) => e.message.includes('本地 host'))
          .map((e) => extractIp(e))
          .filter((ip) => ip.length > 0)
          .map((ip) => ip.split('.').slice(0, 3).join('.'));
        const remotePrefix = remoteIp.split('.').slice(0, 3).join('.');
        const hasMatch = localPrefixes.some((p) => p === remotePrefix);
        if (!hasMatch) {
          castLog(
            'ice',
            `网段不一致 PC=[${localPrefixes.join(',')}] 手机=${remoteIp}`,
            'err',
            localPrefixes.some((p) => p.startsWith('172.26.')) && remoteIp.startsWith('172.26.')
              ? '172.26 不同子网 host UDP 不通，需 TURN relay-only'
              : 'PC 多网卡干扰：关闭虚拟网卡/VPN 或启动 coturn'
          );
        }
      }
      const remotePublicSrflx = recent.some((e) => {
        if (e.step !== 'ice' || !e.message.includes('收到远端 srflx')) return false;
        const ip = extractIp(e);
        return ip.length > 0 && !ip.startsWith('192.168.') && !ip.startsWith('10.');
      });
      const localPrivateHost = recent.some((e) => {
        if (e.step !== 'ice' || !e.message.includes('本地 host')) return false;
        const ip = extractIp(e);
        return ip.startsWith('192.168.') || ip.startsWith('10.');
      });
      if (remotePublicSrflx && localPrivateHost) {
        castLog(
          'ice',
          '跨网段配对失败',
          'err',
          '手机 ICE 仍走蜂窝(106.x)：请关闭移动数据并更新 APK v0.1.8.37'
        );
      }
      if (counts.mdns > 0 && counts.host === 0) {
        castLog(
          'ice',
          '电脑使用了 mDNS(.local) 候选',
          'err',
          '请安装 v0.1.8.35+ 桌面 EXE，或 Chrome 关闭 WebRtcHideLocalIpsWithMdns'
        );
      } else if (counts.host > 0 && counts.relay === 0 && counts.pairFailed > 0) {
        castLog(
          'ice',
          '热点 host 直连全部失败',
          'warn',
          '改用手机连 WiFi（勿电脑连热点），或启动 coturn'
        );
      }
      const hasLocal172 = recent.some((e) => /本地 host 172\.26\./.test(e.message));
      const hasRemote172 = recent.some((e) => /收到远端 host 172\.26\./.test(e.message));
      if (hasLocal172 && hasRemote172 && counts.relay === 0) {
        castLog(
          'ice',
          '172.26 host 无法互通',
          'err',
          '172.26.74与153.x不同子网，请在服务器运行 enable-coturn.sh'
        );
      }
      if (counts.relay > 0 && counts.pairFailed > 0) {
        castLog(
          'ice',
          'TURN relay 配对失败',
          'err',
          '3478 已通但中继端口 UDP 49152-65535 可能被拦截'
        );
      } else if (
        counts.relay > 0 &&
        (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected')
      ) {
        castLog(
          'ice',
          '双方有 relay 但 ICE 未连通',
          'err',
          '请放行 124.220.4.69 UDP 49152-65535，并安装 v0.1.8.46+'
        );
      }
    } catch {
      /* ignore */
    }
  }

  private scheduleIceRecovery(streamKey: string, remoteId: string, streamType: StreamType, pc: RTCPeerConnection): void {
    const existing = this.iceRecoveryTimers.get(streamKey);
    if (existing) clearTimeout(existing);
    const hadStream = this.remoteStreams.has(streamKey);
    const delay = hadStream ? 15000 : 6000;
    const timer = window.setTimeout(() => {
      this.iceRecoveryTimers.delete(streamKey);
      if (this.peers.get(this.subscriberPcKey(remoteId, streamType)) !== pc) return;
      const ice = pc.iceConnectionState;
      if (ice === 'connected' || ice === 'completed') return;
      this.enableRelayOnly(remoteId, `disconnected 超时 ice=${ice}`);
      castLog('ice', `${remoteId.slice(0, 8)} ${ice} 超时，重试 subscribe`, 'warn');
      this.remoteStreams.delete(streamKey);
      this.pendingRemoteMedia.delete(streamKey);
      this.notifyStreams();
      this.closeSubscriberPc(remoteId, streamType);
      this.requestMobileStream(remoteId, streamType, true);
    }, delay);
    this.iceRecoveryTimers.set(streamKey, timer);
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
      iceServers: this.iceServersForPeer(remoteId),
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 10,
      iceTransportPolicy: this.relayOnlyPeers.has(remoteId) ? 'relay' : 'all',
    });
    const subKey = this.subscriberPcKey(remoteId, streamType);

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candStr = event.candidate.candidate ?? '';
      if (candStr && !this.isUsableIceCandidate(candStr)) return;
      const type = event.candidate.type ?? 'unknown';
      const addr = event.candidate.address ?? candStr.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? '';
      if (this.relayOnlyPeers.has(remoteId) && type !== 'relay') return;
      if (addr && !this.shouldSendLocalCandidate(remoteId, addr)) return;
      if (type === 'relay') {
        this.relayReadyPeers.add(remoteId);
        castLog('ice', `本地 relay ${addr || remoteId.slice(0, 8)}`, 'info');
      } else if (type === 'host' || type === 'srflx') {
        if (addr.includes('.local')) {
          castLog('ice', `本地 mDNS ${remoteId.slice(0, 8)}`, 'warn', addr);
        } else if (addr) {
          if (type === 'host') this.localHostPrefixes.add(this.ipPrefix(addr));
          castLog('ice', `本地 ${type} ${addr}`, 'info');
        }
      }
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
          this.tryPublishRemoteStream(streamKey, remoteId, streamType, stream, track, pc, 'ontrack');
        };

        track.onunmute = () => {
          if (this.isIceMediaReady(pc)) {
            this.tryPublishRemoteStream(streamKey, remoteId, streamType, stream, track, pc, 'unmute');
          }
        };
        publish();
      };

      pc.onconnectionstatechange = () => {
        castLog('ice', `peer ${remoteId.slice(0, 8)} conn=${pc.connectionState}`, 'info');
        if (pc.connectionState === 'connected') {
          this.flushPendingRemoteStream(streamKey, remoteId, streamType, pc);
          const existing = this.remoteStreams.get(streamKey);
          if (existing) {
            const rev = (this.streamRevisions.get(streamKey) ?? 0) + 1;
            this.streamRevisions.set(streamKey, rev);
            this.remoteStreams.set(streamKey, { ...existing, rev });
            this.notifyStreams();
          }
        }
        if (pc.connectionState === 'connected' && !this.remoteStreams.has(streamKey)) {
          const watchdog = window.setTimeout(() => {
            if (this.peers.get(subKey) !== pc || this.remoteStreams.has(streamKey)) return;
            castLog(
              'ontrack',
              `8s 内无画面，重试 subscribe ${remoteId.slice(0, 8)}`,
              'warn'
            );
            this.closeSubscriberPc(remoteId, streamType);
            this.requestMobileStream(remoteId, streamType, true);
          }, 8000);
          this.trackWatchdogs.set(streamKey, watchdog);
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          this.remoteStreams.delete(streamKey);
          this.pendingRemoteMedia.delete(streamKey);
          this.notifyStreams();
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
        if (ice === 'connected' || ice === 'completed') {
          const iceTimer = this.iceRecoveryTimers.get(streamKey);
          if (iceTimer) {
            clearTimeout(iceTimer);
            this.iceRecoveryTimers.delete(streamKey);
          }
          this.flushPendingRemoteStream(streamKey, remoteId, streamType, pc);
        }
        if (ice === 'checking') {
          const iceKey = subKey;
          this.scheduleRelayFallback(remoteId, streamType, pc);
          let sawRelay = false;
          window.setTimeout(async () => {
            const current = this.peers.get(iceKey);
            if (!current || current !== pc) return;
            try {
              const report = await pc.getStats();
              report.forEach((stat) => {
                if (
                  stat.type === 'local-candidate' &&
                  (stat as { candidateType?: string }).candidateType === 'relay'
                ) {
                  sawRelay = true;
                }
              });
            } catch {
              /* ignore */
            }
            if (
              current.iceConnectionState === 'checking' ||
              current.iceConnectionState === 'new'
            ) {
              castLog(
                'ice',
                `${remoteId.slice(0, 8)} 长时间 checking`,
                'warn',
                sawRelay ? '已有 relay 候选' : '无 relay 候选'
              );
              await this.logIceDiagnostics(pc, remoteId);
              if (!sawRelay && this.relayOnlyPeers.has(remoteId)) {
                castLog(
                  'ice',
                  'relay-only 但无 TURN 可用',
                  'err',
                  '请在 124.220.4.69 运行 enable-coturn.sh'
                );
              }
            }
          }, 12000);
        }
        if (ice === 'disconnected') {
          this.scheduleIceRecovery(streamKey, remoteId, streamType, pc);
        }
        if (ice === 'failed') {
          const hadMedia = this.remoteStreams.has(streamKey);
          const retry = () => {
            if (this.peers.get(subKey) !== pc) return;
            this.enableRelayOnly(remoteId, 'ice failed');
            this.remoteStreams.delete(streamKey);
            this.pendingRemoteMedia.delete(streamKey);
            this.notifyStreams();
            castLog('ice', `ICE 失败，重试 ${remoteId.slice(0, 8)}`, 'err');
            this.closeSubscriberPc(remoteId, streamType);
            this.requestMobileStream(remoteId, streamType, true);
          };
          if (hadMedia) {
            castLog('ice', `${remoteId.slice(0, 8)} 短暂断流，8s 后重试`, 'warn');
            window.setTimeout(retry, 8000);
          } else {
            retry();
          }
        }
      };
    }

    return pc;
  }

  private ipPrefix(ip: string): string {
    return ip.split('.').slice(0, 3).join('.');
  }

  /** relay-only 时仅用自建 TURN（124.220.4.69），避免 openrelay 候选干扰 */
  private iceServersForPeer(remoteId: string): RTCIceServer[] {
    const servers = this.iceServers.length > 0 ? this.iceServers : getCachedIceServers();
    if (!this.relayOnlyPeers.has(remoteId)) return servers;
    const selfTurn = servers.filter((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some((u) => String(u).includes('124.220.4.69'));
    });
    return selfTurn.length > 0 ? selfTurn : servers;
  }

  private noteRemoteSubnet(remoteId: string, ip: string, streamType: StreamType): void {
    if (!this.remoteSubnetByPeer.has(remoteId)) {
      this.remoteSubnetByPeer.set(remoteId, this.ipPrefix(ip));
    }
    this.maybeForceRelayOnSubnetMismatch(remoteId, streamType, ip);
  }

  /** 过滤 Hyper-V/虚拟网卡 .1 地址；已知远端网段时只发同 /24 候选 */
  private shouldSendLocalCandidate(remoteId: string, ip: string): boolean {
    if (ip.endsWith('.1') && (ip.startsWith('192.168.128.') || ip.startsWith('192.168.178.'))) {
      return false;
    }
    const remotePrefix = this.remoteSubnetByPeer.get(remoteId);
    if (!remotePrefix) return true;
    return this.ipPrefix(ip) === remotePrefix;
  }

  private isUsableIceCandidate(candidate: string): boolean {
    const ip = candidate.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1];
    if (!ip) return true;
    if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip.startsWith('169.254.')) return false;
    return true;
  }

  private normalizeIceCandidate(raw: unknown): RTCIceCandidateInit | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as RTCIceCandidateInit & { completed?: boolean };
    if (c.completed || c.candidate === '') return null;
    if (!c.candidate || typeof c.candidate !== 'string') return null;
    let candidate = c.candidate.trim();
    if (!candidate.startsWith('candidate:')) {
      candidate = `candidate:${candidate}`;
    }
    if (!this.isUsableIceCandidate(candidate)) {
      castLog('ice', '忽略远端无效候选', 'warn', '127.0.0.1/链路本地');
      return null;
    }
    const type = candidate.includes('typ relay')
      ? 'relay'
      : candidate.includes('typ srflx')
        ? 'srflx'
        : candidate.includes('typ host')
          ? 'host'
          : '?';
    if (type === 'relay') {
      const ip = candidate.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
      castLog('ice', '收到远端 relay 候选', 'info', ip ?? '');
    } else if (type === 'host' && candidate.includes('.local')) {
      castLog('ice', '收到远端 mDNS 候选', 'warn');
    } else if (type === 'host' || type === 'srflx') {
      const ip = candidate.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
      if (ip) castLog('ice', `收到远端 ${type} ${ip}`, 'info');
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
        const hostIp = candidate.candidate?.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1];
        if (hostIp && candidate.candidate?.includes('typ host')) {
          this.noteRemoteSubnet(msg.from, hostIp, streamType);
          if (this.relayOnlyPeers.has(msg.from)) {
            castLog(
              'ice',
              `远端仍发 host ${hostIp}`,
              'warn',
              '手机未同步 relay-only，请更新 APK v0.1.8.46+'
            );
          }
        }
        if (candidate.candidate?.includes('typ relay')) {
          this.remoteRelaySeen.add(msg.from);
        }
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
    for (const t of this.iceRecoveryTimers.values()) clearTimeout(t);
    this.iceRecoveryTimers.clear();
    this.pendingRemoteMedia.clear();
    this.streamRevisions.clear();
    this.relayOnlyPeers.clear();
    this.relayReadyPeers.clear();
    this.remoteRelaySeen.clear();
    this.localHostPrefixes.clear();
    this.relayRetryTimers.forEach((t) => clearTimeout(t));
    this.relayRetryTimers.clear();
  }
}

declare global {
  interface MediaStream {
    _hasAlpha?: boolean;
  }
}
