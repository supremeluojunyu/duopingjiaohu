#!/usr/bin/env node
/** 模拟手机→电脑投屏信令链路，验证 publish_started/subscribe/offer 路由 */
import WebSocket from 'ws';

const BASE = process.env.SIGNALING_URL ?? 'ws://127.0.0.1:9876/ws';
const ROOM = process.env.ROOM_ID ?? 'CASTTEST';

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE);
    const inbox = [];
    ws.on('open', () => resolve({ ws, inbox, label }));
    ws.on('error', reject);
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      inbox.push(msg);
      console.log(`[${label}] <= ${msg.type}${msg.from ? ` from ${msg.from.slice(0, 8)}` : ''}`);
    });
  });
}

function send(ws, type, payload, to) {
  ws.send(JSON.stringify({ type, payload, timestamp: Date.now(), ...(to ? { to } : {}) }));
}

async function join(client, name, type) {
  send(client.ws, 'join', {
    roomId: ROOM,
    device: { name, type, role: 'user', streamTypes: ['camera'], hasAlpha: false },
  });
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const joined = client.inbox.find((m) => m.type === 'joined');
    if (joined) return joined.payload.device.id;
  }
  throw new Error(`${client.label} join timeout`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const desktop = await connect('desktop');
  const mobile = await connect('mobile');
  const desktopId = await join(desktop, 'PC', 'desktop');
  const mobileId = await join(mobile, 'Phone', 'mobile');
  console.log('IDs', { desktopId: desktopId.slice(0, 8), mobileId: mobileId.slice(0, 8) });

  // 1. publish_started 广播
  send(mobile.ws, 'publish_started', { hasAlpha: false });
  await sleep(300);
  const pubEvt = desktop.inbox.find((m) => m.type === 'publish_started' && m.payload.deviceId === mobileId);
  if (!pubEvt) throw new Error('desktop 未收到 publish_started（检查服务器 broadcast）');
  console.log('✓ publish_started 已广播到 desktop');

  // 2. subscribe 转发
  send(
    desktop.ws,
    'subscribe',
    { publisherId: mobileId, subscriberId: desktopId, streamType: 'camera' },
    mobileId
  );
  await sleep(500);
  const sub = mobile.inbox.find((m) => m.type === 'subscribe');
  if (!sub) throw new Error('mobile 未收到 subscribe（检查设备 ID 与 sendToDeviceInRoom）');
  console.log('✓ subscribe 已转发到 mobile');

  // 3. offer 转发
  send(
    mobile.ws,
    'offer',
    {
      sdp: { type: 'offer', sdp: 'v=0\r\n' },
      streamType: 'camera',
      targetId: desktopId,
    },
    desktopId
  );
  await sleep(300);
  const offer = desktop.inbox.find((m) => m.type === 'offer');
  if (!offer) throw new Error('desktop 未收到 offer');
  console.log('✓ offer 已转发到 desktop');

  console.log('\n✓ 信令链路正常: publish_started → subscribe → offer');
  console.log('  排查黑屏时对照 logcat [cast:*] 与电脑端「投屏诊断」面板');
  desktop.ws.close();
  mobile.ws.close();
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
