import { useEffect, useRef, useState } from 'react';

export interface StreamStats {
  deviceId: string;
  streamType: string;
  bitrateKbps: number;
  fps: number;
  packetsLost: number;
  packetsReceived: number;
  jitterMs: number;
  resolution: string;
  codec: string;
}

interface QualityState {
  badStreak: number;
  goodStreak: number;
  qualityReduced: boolean;
}

/** 解析 peer key：`{uuid}:camera:sub` → deviceId + streamType */
export function parseSubscriberPeerKey(key: string): { deviceId: string; streamType: string } {
  const base = key.replace(/:(sub|pub)$/, '');
  const lastColon = base.lastIndexOf(':');
  if (lastColon <= 0) return { deviceId: base, streamType: 'camera' };
  return {
    deviceId: base.slice(0, lastColon),
    streamType: base.slice(lastColon + 1),
  };
}

function evaluateQualityReduced(stats: StreamStats[], state: QualityState): boolean {
  if (stats.length === 0) return state.qualityReduced;

  const isBad = stats.some((s) => {
    const totalPackets = s.packetsReceived + s.packetsLost;
    const lossRate = totalPackets > 0 ? s.packetsLost / totalPackets : 0;
    return lossRate > 0.1 || s.jitterMs > 100 || (s.fps > 0 && s.fps < 15);
  });

  if (isBad) {
    state.badStreak++;
    state.goodStreak = 0;
    if (state.badStreak >= 3) state.qualityReduced = true;
  } else {
    state.goodStreak++;
    state.badStreak = 0;
    if (state.goodStreak >= 5) state.qualityReduced = false;
  }

  return state.qualityReduced;
}

export function useWebRTCStats(
  getPeers: () => Map<string, RTCPeerConnection> | null,
  intervalMs = 2000
): { stats: StreamStats[]; qualityReduced: boolean } {
  const [stats, setStats] = useState<StreamStats[]>([]);
  const [qualityReduced, setQualityReduced] = useState(false);
  const qualityStateRef = useRef<QualityState>({
    badStreak: 0,
    goodStreak: 0,
    qualityReduced: false,
  });

  useEffect(() => {
    let prevBytes = new Map<string, number>();
    let prevTime = Date.now();

    const poll = async () => {
      const peers = getPeers();
      if (!peers || peers.size === 0) {
        setStats([]);
        const reduced = evaluateQualityReduced([], qualityStateRef.current);
        setQualityReduced((prev) => (prev === reduced ? prev : reduced));
        return;
      }
      const results: StreamStats[] = [];
      const now = Date.now();
      const dt = (now - prevTime) / 1000;

      for (const [key, pc] of peers) {
        if (!key.endsWith(':sub')) continue;
        if (pc.connectionState === 'closed') continue;

        try {
          const report = await pc.getStats();
          let bitrateKbps = 0;
          let fps = 0;
          let packetsLost = 0;
          let packetsReceived = 0;
          let jitterMs = 0;
          let width = 0;
          let height = 0;
          let codec = '';

          report.forEach((stat) => {
            const isVideoInbound =
              stat.type === 'inbound-rtp' &&
              (stat.kind === 'video' || (stat as { mediaType?: string }).mediaType === 'video');
            if (isVideoInbound) {
              const inbound = stat as RTCInboundRtpStreamStats;
              const bytes = inbound.bytesReceived ?? 0;
              const prev = prevBytes.get(key) ?? bytes;
              if (dt > 0) bitrateKbps = ((bytes - prev) * 8) / dt / 1000;
              prevBytes.set(key, bytes);
              fps = inbound.framesPerSecond ?? 0;
              packetsLost = inbound.packetsLost ?? 0;
              packetsReceived = inbound.packetsReceived ?? 0;
              jitterMs = Math.round((inbound.jitter ?? 0) * 1000);
              width = inbound.frameWidth ?? 0;
              height = inbound.frameHeight ?? 0;
              if (bytes === 0 && packetsReceived === 0) {
                console.warn('[WebRTC] 视频统计: 尚未收到数据', key);
              }
            }
            if (stat.type === 'codec' && stat.mimeType?.startsWith('video/')) {
              codec = stat.mimeType.replace('video/', '');
            }
          });

          const { deviceId, streamType } = parseSubscriberPeerKey(key);
          results.push({
            deviceId,
            streamType,
            bitrateKbps: Math.round(bitrateKbps),
            fps: Math.round(fps),
            packetsLost,
            packetsReceived,
            jitterMs,
            resolution: width && height ? `${width}x${height}` : '-',
            codec: codec || '-',
          });
        } catch {
          /* ignore */
        }
      }

      prevTime = now;
      setStats(results);

      const reduced = evaluateQualityReduced(results, qualityStateRef.current);
      setQualityReduced((prev) => (prev === reduced ? prev : reduced));
    };

    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [getPeers, intervalMs]);

  return { stats, qualityReduced };
}
