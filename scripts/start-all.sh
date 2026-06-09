#!/usr/bin/env bash
# 一键启动全息投影系统（信令 + Web 客户端）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.local/node/bin:${PATH}"

MODE="${1:-http}"
SIGNALING_PORT="${PORT:-9876}"
WEB_PORT="${WEB_PORT:-8080}"

echo "=== 全息投影系统启动 ==="
echo "模式: $MODE | 信令端口: $SIGNALING_PORT"

# 检查 Node
if ! command -v npm &>/dev/null; then
  echo "错误: 未找到 npm，请先安装 Node.js"
  exit 1
fi

# 安装依赖（首次）
for dir in server client; do
  if [ ! -d "$ROOT/$dir/node_modules" ]; then
    echo "安装 $dir 依赖..."
    npm install --prefix "$ROOT/$dir"
  fi
done

cleanup() {
  echo ""
  echo "停止服务..."
  kill $(jobs -p) 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 启动信令
echo "启动信令服务器..."
cd "$ROOT/server"
PORT="$SIGNALING_PORT" npm run dev &
sleep 2

# 健康检查
if curl -sf "http://localhost:$SIGNALING_PORT/health" >/dev/null; then
  echo "✓ 信令服务器就绪 http://localhost:$SIGNALING_PORT"
else
  echo "✗ 信令服务器启动失败"
  exit 1
fi

# 启动客户端
cd "$ROOT/client"
if [ "$MODE" = "https" ]; then
  echo "启动 HTTPS 客户端（手机可用摄像头）..."
  echo "访问 https://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):$WEB_PORT"
  VITE_SIGNALING_URL="http://localhost:$SIGNALING_PORT" npm run dev:https -- --port "$WEB_PORT"
else
  echo "启动 HTTP 客户端..."
  echo "访问 http://localhost:$WEB_PORT"
  VITE_SIGNALING_URL="http://localhost:$SIGNALING_PORT" npm run dev -- --port "$WEB_PORT"
fi
