import { getIceServers as getEnvIceServers } from '../config';

let cachedServers: RTCIceServer[] | null = null;

const SELF_TURN: RTCIceServer = {
  urls: [
    'turn:124.220.4.69:3478?transport=udp',
    'turn:124.220.4.69:3478?transport=tcp',
  ],
  username: 'holo',
  credential: 'holo123456',
};

function mergeSelfTurn(servers: RTCIceServer[]): RTCIceServer[] {
  const hasSelf = servers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => String(u).includes('124.220.4.69:3478'));
  });
  return hasSelf ? servers : [...servers, SELF_TURN];
}

export async function fetchIceServers(signalingUrl: string): Promise<RTCIceServer[]> {
  try {
    const res = await fetch(`${signalingUrl.replace(/\/$/, '')}/config/ice`);
    if (res.ok) {
      const data = (await res.json()) as { iceServers: RTCIceServer[] };
      if (data.iceServers?.length) {
        cachedServers = mergeSelfTurn(data.iceServers);
        return cachedServers;
      }
    }
  } catch {
    /* fallback */
  }
  cachedServers = getEnvIceServers();
  return cachedServers;
}

export function getCachedIceServers(): RTCIceServer[] {
  return cachedServers ?? getEnvIceServers();
}
