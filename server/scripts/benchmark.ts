/** 信令层并发压测 CLI — 在 server 目录运行 */
import WebSocket from 'ws';

const ROOM = process.argv[2] ?? 'TEST01';
const COUNT = Number(process.argv[3] ?? 5);
const PORT = process.env.PORT ?? '8765';
const WS_URL = `ws://localhost:${PORT}/ws`;

let connected = 0;
let failed = 0;
const start = Date.now();

function report() {
  const elapsed = Date.now() - start;
  console.log('--- 信令压测结果 ---');
  console.log(`房间: ${ROOM} | 目标: ${COUNT} | 成功: ${connected} | 失败: ${failed}`);
  console.log(`总耗时: ${elapsed}ms | 平均: ${(elapsed / COUNT).toFixed(1)}ms/客户端`);
  process.exit(failed > 0 ? 1 : 0);
}

for (let i = 0; i < COUNT; i++) {
  const ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    ws.send(
      JSON.stringify({
        type: 'join',
        payload: {
          roomId: ROOM,
          device: {
            name: `bench-${i}`,
            type: i % 3 === 0 ? 'desktop' : 'mobile',
            role: 'user',
            streamTypes: ['camera'],
          },
        },
        timestamp: Date.now(),
      })
    );
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'joined') {
      connected++;
      if (connected + failed >= COUNT) report();
    }
    if (msg.type === 'error') {
      failed++;
      if (connected + failed >= COUNT) report();
    }
  });
  ws.on('error', () => {
    failed++;
    if (connected + failed >= COUNT) report();
  });
}

setTimeout(() => {
  console.error('超时 (30s) — 请先启动信令服务器');
  process.exit(1);
}, 30000);
