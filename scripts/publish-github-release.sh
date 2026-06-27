#!/usr/bin/env bash
# 将本地 APK/EXE 发布到 GitHub Releases（需 GITHUB_TOKEN，repo 权限）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:?用法: GITHUB_TOKEN=xxx $0 v0.1.8.28 [更新说明]}"
NOTES="${2:-Release $TAG}"
VERSION="${TAG#v}"
REPO="${GITHUB_REPO:-supremeluojunyu/duopingjiaohu}"
TOKEN="${GITHUB_TOKEN:?请设置 GITHUB_TOKEN（classic token，勾选 repo）}"

APK="${APK:-$ROOT/android/app/build/outputs/apk/debug/app-debug.apk}"
DESKTOP_VER="$(echo "$VERSION" | sed -E 's/^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$/\1.\2.\3-\4/')"
EXE="${EXE:-$ROOT/desktop/dist/HolographicSystem-Portable-${DESKTOP_VER}.exe}"

for f in "$APK" "$EXE"; do
  if [[ ! -f "$f" ]]; then
    echo "缺少文件: $f"
    exit 1
  fi
done

api() {
  curl -sf -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"
}

echo "==> 创建/获取 Release: $TAG"
if ! RELEASE_JSON="$(api "https://api.github.com/repos/$REPO/releases/tags/$TAG" 2>/dev/null)"; then
  RELEASE_JSON="$(api -X POST "https://api.github.com/repos/$REPO/releases" \
    -d "$(jq -n --arg tag "$TAG" --arg name "Release $TAG" --arg body "$NOTES" \
      '{tag_name:$tag,name:$name,body:$body,generate_release_notes:true}')")"
fi
RELEASE_ID="$(echo "$RELEASE_JSON" | jq -r .id)"

upload() {
  local file="$1"
  local name="$2"
  echo "==> 上传 $(basename "$file") -> $name"
  curl -sf -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$file" \
    "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$name"
  echo
}

upload "$APK" "holographic-${VERSION}.apk"
upload "$EXE" "HolographicSystem-Portable-${DESKTOP_VER}.exe"

echo "✓ GitHub Release 已发布: https://github.com/$REPO/releases/tag/$TAG"
