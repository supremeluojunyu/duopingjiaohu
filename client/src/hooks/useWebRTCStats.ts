import { useEffect, useState } from 'react';

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

let badStreak = 0;
let goodStreak = 0;
let qualityReduced = false;

export function useWebRTCStats(
  getPeers: () => Map<string, RTCPeerConnection> | null,
  intervalMs = 2000
): StreamStats[] {
  const [stats, setStats] = useState<StreamStats[]>([]);

  useEffect(() => {
    let prevBytes = new Map<string, number>();
    let prevTime = Date.now();

    const poll = async () => {
      const peers = getPeers();
      if (!peers || peers.size === 0) {
        setStats([]);
        return;
      }
      const results: StreamStats[] = [];
      const now = Date.now();
      const dt = (now - prevTime) / 1000;

      for (const [key, pc] of peers) {
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
            if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
              const bytes = stat.bytesReceived ?? 0;
              const prev = prevBytes.get(key) ?? bytes;
              if (dt > 0) bitrateKbps = ((bytes - prev) * 8) / dt / 1000;
              prevBytes.set(key, bytes);
              fps = stat.framesPerSecond ?? 0;
              packetsLost = stat.packetsLost ?? 0;
              packetsReceived = stat.packetsReceived ?? 0;
              jitterMs = Math.round((stat.jitter ?? 0) * 1000);
              width = stat.frameWidth ?? 0;
              height = stat.frameHeight ?? 0;
            }
            if (stat.type === 'codec' && stat.mimeType?.startsWith('video/')) {
              codec = stat.mimeType.replace('video/', '');
            }
          });

          const [deviceId, streamType] = key.split(':');
          results.push({
            deviceId,
            streamType: streamType ?? 'camera',
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
    };

    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [getPeers, intervalMs]);

  return stats;
}

/** 根据统计信息建议降低质量（带持续时间判断与恢复机制） */
export function shouldReduceQuality(stats: StreamStats[]): boolean {
  if (stats.length === 0) return qualityReduced;

  const isBad = stats.some((s) => {
    const totalPackets = s.packetsReceived + s.packetsLost;
    const lossRate = totalPackets > 0 ? s.packetsLost / totalPackets : 0;
    return lossRate > 0.1 || s.jitterMs > 100 || (s.fps > 0 && s.fps < 15);
  });

  if (isBad) {
    badStreak++;
    goodStreak = 0;
    if (badStreak >= 3) qualityReduced = true;
  } else {
    goodStreak++;
    badStreak = 0;
    if (goodStreak >= 5) qualityReduced = false;
  }

  return qualityReduced;
}
