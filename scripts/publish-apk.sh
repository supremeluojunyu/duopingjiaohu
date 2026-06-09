#!/usr/bin/env bash
# 从 Android 构建产物发布 APK，并同步 version.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GRADLE_FILE="$ROOT/android/app/build.gradle.kts"
APK_DEBUG="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
APK_RELEASE="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
DOWNLOADS="$ROOT/server/public/downloads"

usage() {
  echo "用法: $0 [debug|release|/path/to/app.apk] [更新说明]"
  echo "示例: $0 release 修复连接稳定性"
  exit 1
}

[[ $# -ge 1 ]] || usage

BUILD_TYPE="${1:-release}"
NOTES="${2:-Android 客户端更新}"

read_gradle_value() {
  local key="$1"
  grep -E "^\s*${key}\s*=" "$GRADLE_FILE" | head -1 | sed -E 's/.*=\s*"([^"]+)".*/\1/' | tr -d ' '
}

read_gradle_int() {
  local key="$1"
  grep -E "^\s*${key}\s*=" "$GRADLE_FILE" | head -1 | sed -E 's/.*=\s*([0-9]+).*/\1/'
}

VERSION_NAME="$(read_gradle_value versionName)"
VERSION_CODE="$(read_gradle_int versionCode)"

if [[ -f "$BUILD_TYPE" ]]; then
  SOURCE_APK="$BUILD_TYPE"
elif [[ "$BUILD_TYPE" == "debug" ]]; then
  SOURCE_APK="$APK_DEBUG"
elif [[ "$BUILD_TYPE" == "release" ]]; then
  SOURCE_APK="$APK_RELEASE"
else
  echo "未知构建类型: $BUILD_TYPE"
  usage
fi

if [[ ! -f "$SOURCE_APK" ]]; then
  echo "未找到 APK: $SOURCE_APK"
  echo "请先构建: cd android && ./gradlew assembleDebug"
  exit 1
fi

mkdir -p "$DOWNLOADS"
TARGET_VERSIONED="$DOWNLOADS/holographic-${VERSION_NAME}.apk"
TARGET_LATEST="$DOWNLOADS/app-latest.apk"

cp "$SOURCE_APK" "$TARGET_VERSIONED"
cp "$SOURCE_APK" "$TARGET_LATEST"

FILE_SIZE=$(stat -c%s "$TARGET_LATEST" 2>/dev/null || stat -f%z "$TARGET_LATEST")
SHA256=$(sha256sum "$TARGET_LATEST" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$TARGET_LATEST" | awk '{print $1}')
UPDATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

cat > "$DOWNLOADS/version.json" <<EOF
{
  "versionName": "${VERSION_NAME}",
  "versionCode": ${VERSION_CODE},
  "fileName": "holographic-${VERSION_NAME}.apk",
  "fileSize": ${FILE_SIZE},
  "sha256": "${SHA256}",
  "updatedAt": "${UPDATED_AT}",
  "available": true,
  "releaseNotes": "${NOTES}"
}
EOF

echo "✓ 已发布 APK v${VERSION_NAME} (${VERSION_CODE})"
echo "  文件: $TARGET_LATEST"
echo "  大小: $FILE_SIZE bytes"
echo "  SHA256: $SHA256"
echo ""
echo "重启信令服务后，可通过以下地址访问:"
echo "  GET /api/app/version"
echo "  GET /downloads/app-latest.apk"
