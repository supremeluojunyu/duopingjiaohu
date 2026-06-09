import { useEffect, useState } from 'react';

export interface StreamStats {
  deviceId: string;
  streamType: string;
  bitrateKbps: number;
  fps: number;
  packetsLost: number;
  jitterMs: number;
  resolution: string;
  codec: string;
}

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

/** 根据统计信息建议降低质量 */
export function shouldReduceQuality(stats: StreamStats[]): boolean {
  return stats.some(
    (s) => s.packetsLost > 10 || s.jitterMs > 100 || (s.fps > 0 && s.fps < 15)
  );
}
