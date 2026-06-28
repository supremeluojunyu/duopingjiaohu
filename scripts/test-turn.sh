#!/usr/bin/env bash
# 验证 coturn 3478 与中继端口是否可用
set -euo pipefail

TURN_HOST="${TURN_HOST:-124.220.4.69}"
TURN_PORT="${TURN_PORT:-3478}"
TURN_USER="${TURN_USER:-holo}"
TURN_PASS="${TURN_PASS:-holo123456}"

echo "==> TURN 服务器: ${TURN_HOST}:${TURN_PORT}"
echo "    腾讯云安全组需放行: TCP+UDP ${TURN_PORT}, UDP 49152-65535"

if command -v turnutils_uclient >/dev/null 2>&1; then
  echo "==> turnutils_uclient 测试（需 coturn-client 包）"
  turnutils_uclient -v -u "$TURN_USER" -w "$TURN_PASS" "$TURN_HOST" || true
else
  echo "（未安装 turnutils_uclient，跳过深度测试；可 apt install coturn 后重试）"
fi

if nc -zvu "$TURN_HOST" "$TURN_PORT" 2>&1 | grep -qi succeeded; then
  echo "✓ UDP ${TURN_PORT} 可达"
else
  echo "✗ UDP ${TURN_PORT} 不可达"
fi

echo "==> ICE 配置:"
curl -fsS "http://${TURN_HOST}:9000/config/ice" | python3 -m json.tool 2>/dev/null || true
