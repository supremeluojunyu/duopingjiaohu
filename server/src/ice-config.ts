/** ICE / TURN 配置，从环境变量读取 */
export interface IceConfig {
  iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
}

export function getIceConfig(): IceConfig {
  const servers: IceConfig['iceServers'] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.qq.com:19302' },
  ];

  const turnUrl = process.env.TURN_URL;
  const turnUser = process.env.TURN_USER ?? 'holo';
  const turnPass = process.env.TURN_PASS ?? 'holo123456';
  const publicIp = process.env.PUBLIC_IP ?? process.env.SIGNALING_PUBLIC_IP;

  /** 自建 coturn（docker compose --profile turn）优先，国内比 openrelay 更稳定 */
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

  if (turnUrl && turnUser && turnPass) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnPass });
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

  const turnUrls = process.env.TURN_URLS;
  if (turnUrls && turnUser && turnPass) {
    for (const url of turnUrls.split(',').map((s) => s.trim()).filter(Boolean)) {
      servers.push({ urls: url, username: turnUser, credential: turnPass });
    }
  }

  return { iceServers: servers };
}
