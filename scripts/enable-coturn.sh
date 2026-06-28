#!/usr/bin/env bash
# 在信令服务器上启动 coturn TURN（解决跨网 ICE failed）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PUBLIC_IP="${PUBLIC_IP:-124.220.4.69}"

echo "==> 启动 coturn (PUBLIC_IP=$PUBLIC_IP)"
echo "    腾讯云安全组 + 防火墙需放行:"
echo "      TCP/UDP 3478          ← TURN 分配"
echo "      UDP 49152-65535       ← 中继媒体（缺此项会导致「有 relay 但 ICE failed」）"
echo ""
echo "    验证: bash scripts/test-turn.sh"

export PUBLIC_IP
docker compose --profile turn up -d coturn

echo "==> 重启信令服务以加载 TURN 配置"
docker compose up -d signaling 2>/dev/null || echo "（非 docker 部署请手动设置 PUBLIC_IP=$PUBLIC_IP 并重启 node 信令）"

sleep 2
echo "==> ICE 配置:"
curl -fsS "http://127.0.0.1:${PORT:-9000}/config/ice" | python3 -m json.tool 2>/dev/null || true
echo "✓ 完成。/config/ice 应包含 turn:${PUBLIC_IP}:3478"
