#!/usr/bin/env bash
# 性能压测：模拟多客户端加入房间（信令层）
# 用法: ./scripts/benchmark.sh [房间号] [客户端数量]
set -euo pipefail

ROOM="${1:-TEST01}"
COUNT="${2:-5}"
SERVER="${SIGNALING_URL:-http://localhost:8765}"
WS_URL="${SERVER/http/ws}/ws"

export PATH="${HOME}/.local/node/bin:${PATH}"

node -e "
const WebSocket = require('ws');
const COUNT = $COUNT;
const ROOM = '$ROOM';
const WS_URL = '$WS_URL';

let connected = 0;
let failed = 0;
const start = Date.now();

for (let i = 0; i < COUNT; i++) {
  const ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'join',
      payload: {
        roomId: ROOM,
        device: { name: 'bench-' + i, type: i % 3 === 0 ? 'desktop' : 'mobile', role: 'user', streamTypes: ['camera'] }
      },
      timestamp: Date.now()
    }));
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'joined') {
      connected++;
      if (connected + failed === COUNT) report();
    }
    if (msg.type === 'error') { failed++; if (connected + failed === COUNT) report(); }
  });
  ws.on('error', () => { failed++; if (connected + failed === COUNT) report(); });
}

function report() {
  const elapsed = Date.now() - start;
  console.log('--- 压测结果 ---');
  console.log('房间:', ROOM);
  console.log('目标客户端:', COUNT);
  console.log('成功加入:', connected);
  console.log('失败:', failed);
  console.log('耗时:', elapsed + 'ms');
  console.log('平均:', (elapsed / COUNT).toFixed(1) + 'ms/客户端');
  process.exit(failed > 0 ? 1 : 0);
}

setTimeout(() => { console.error('超时'); process.exit(1); }, 30000);
" 2>/dev/null || {
  echo "需要 ws 模块，在 server 目录运行:"
  echo "  cd server && node ../scripts/benchmark-cli.js $ROOM $COUNT"
}
