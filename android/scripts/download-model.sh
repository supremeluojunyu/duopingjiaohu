#!/usr/bin/env bash
# 下载 MediaPipe Selfie Segmenter 模型到 Android assets
set -euo pipefail

ASSETS_DIR="$(dirname "$0")/../app/src/main/assets"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"
MODEL_FILE="$ASSETS_DIR/selfie_segmenter.tflite"

mkdir -p "$ASSETS_DIR"

if [ -f "$MODEL_FILE" ]; then
  echo "模型已存在: $MODEL_FILE"
  exit 0
fi

echo "下载 selfie_segmenter.tflite ..."
curl -fsSL "$MODEL_URL" -o "$MODEL_FILE"
echo "完成: $MODEL_FILE ($(du -h "$MODEL_FILE" | cut -f1))"
