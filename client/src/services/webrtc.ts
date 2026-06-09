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
  private iceServers: RTCIceServer[] = getCachedIceServers();
  private lowQualityMode = false;

  constructor(
    private signaling: SignalingClient,
    private localDeviceId: string
  ) {
    this.signaling.onMessage((msg) => this.handleSignaling(msg));
  }

  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = servers;
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

    const pc = this.createPeerConnection(publisherId, streamType, true);
    this.peers.set(key, pc);

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.signaling.send({
      type: 'offer',
      to: publisherId,
      payload: { sdp: offer, streamType, targetId: publisherId },
    });
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

  private createPeerConnection(
    remoteId: string,
    streamType: StreamType,
    _isInitiator: boolean
  ): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const key = `${remoteId}:${streamType}`;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({
          type: 'ice',
          to: remoteId,
          payload: { candidate: event.candidate, streamType, targetId: remoteId },
        });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.remoteStreams.set(key, {
        deviceId: remoteId,
        streamType,
        stream,
        hasAlpha: false,
      });
      this.notifyStreams();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.peers.delete(key);
        this.remoteStreams.delete(key);
        this.notifyStreams();
      }
    };

    return pc;
  }

  private async handleSignaling(msg: import('../types').SignalingMessage): Promise<void> {
    const streamType = (msg.payload.streamType as StreamType) ?? 'camera';

    switch (msg.type) {
      case 'peer_joined': {
        const device = msg.payload.device as { id: string };
        if (device.id !== this.localDeviceId && this.localStream) {
          await this.subscribe(device.id, 'camera');
        }
        break;
      }

      case 'offer': {
        if (!msg.from) return;
        const key = `${msg.from}:${streamType}`;
        let pc = this.peers.get(key);
        if (!pc) {
          pc = this.createPeerConnection(msg.from, streamType, false);
          this.peers.set(key, pc);

          if (this.localStream) {
            this.localStream.getTracks().forEach((track) => {
              pc!.addTrack(track, this.localStream!);
            });
          }
        }

        const sdp = msg.payload.sdp as RTCSessionDescriptionInit;
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));

        const pending = this.pendingCandidates.get(key) ?? [];
        for (const c of pending) {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        }
        this.pendingCandidates.delete(key);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

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
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        break;
      }

      case 'ice': {
        if (!msg.from) return;
        const key = `${msg.from}:${streamType}`;
        const pc = this.peers.get(key);
        const candidate = msg.payload.candidate as RTCIceCandidateInit;
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
        const subscriberId = msg.payload.subscriberId as string;
        if (subscriberId !== this.localDeviceId && this.localStream) {
          await this.subscribe(subscriberId, streamType);
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
    this.stopPublishing();
    this.peers.forEach((pc) => pc.close());
    this.peers.clear();
    this.remoteStreams.clear();
  }
}

declare global {
  interface MediaStream {
    _hasAlpha?: boolean;
  }
}
