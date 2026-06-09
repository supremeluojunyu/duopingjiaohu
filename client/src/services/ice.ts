import { getIceServers as getEnvIceServers } from '../config';

let cachedServers: RTCIceServer[] | null = null;

export async function fetchIceServers(signalingUrl: string): Promise<RTCIceServer[]> {
  try {
    const res = await fetch(`${signalingUrl.replace(/\/$/, '')}/config/ice`);
    if (res.ok) {
      const data = (await res.json()) as { iceServers: RTCIceServer[] };
      if (data.iceServers?.length) {
        cachedServers = data.iceServers;
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
