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
  const turnUser = import.meta.env.VITE_TURN_USER;
  const turnPass = import.meta.env.VITE_TURN_PASS;

  if (turnUrl && turnUser && turnPass) {
    servers.push({
      urls: turnUrl,
      username: turnUser,
      credential: turnPass,
    });
  }

  return servers;
}

export const DEFAULT_SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:9876';

export const RECONNECT_INTERVAL_MS = 3000;
export const MAX_RECONNECT_ATTEMPTS = 10;
export const PING_INTERVAL_MS = 10000;
export const LATENCY_PING_INTERVAL_MS = 3000;
export const LATENCY_GOOD_MS = 100;
export const LATENCY_WARN_MS = 300;
