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
  const turnUser = process.env.TURN_USER;
  const turnPass = process.env.TURN_PASS;

  if (turnUrl && turnUser && turnPass) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnPass });
  }

  // 支持多个 TURN URL（逗号分隔）
  const turnUrls = process.env.TURN_URLS;
  if (turnUrls && turnUser && turnPass) {
    for (const url of turnUrls.split(',').map((s) => s.trim()).filter(Boolean)) {
      servers.push({ urls: url, username: turnUser, credential: turnPass });
    }
  }

  return { iceServers: servers };
}
