/** WebRTC ICE 服务器配置，可通过环境变量覆盖 */
export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.qq.com:19302' },
  ];

  const turnUrl = import.meta.env.VITE_TURN_URL;
  const turnUser = import.meta.env.VITE_TURN_USER ?? 'holo';
  const turnPass = import.meta.env.VITE_TURN_PASS ?? 'holo123456';
  const publicIp = import.meta.env.VITE_PUBLIC_IP;

  if (publicIp) {
    servers.push({
      urls: [
        `turn:${publicIp}:3478?transport=udp`,
        `turn:${publicIp}:3478?transport=tcp`,
      ],
      username: turnUser,
      credential: turnPass,
    });
  }

  if (turnUrl && import.meta.env.VITE_TURN_USER && import.meta.env.VITE_TURN_PASS) {
    servers.push({
      urls: turnUrl,
      username: turnUser,
      credential: turnPass,
    });
  } else if (!publicIp) {
    servers.push({
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    });
  }

  return servers;
}

/** 与 Android SignalingConfig、Desktop 打包默认保持一致 */
export const DEFAULT_SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ?? 'http://124.220.4.69:9000';

export const RECONNECT_INTERVAL_MS = 3000;
export const MAX_RECONNECT_ATTEMPTS = 10;
export const PING_INTERVAL_MS = 10000;
export const LATENCY_PING_INTERVAL_MS = 3000;
export const LATENCY_GOOD_MS = 100;
export const LATENCY_WARN_MS = 300;
