#!/usr/bin/env bash
# 用户目录安装 JDK + Android SDK 并构建 debug APK
unzip_file() {
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$1" -d "$2"
  else
    python3 - "$1" "$2" <<'PY'
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
  fi
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
BUILD_HOME="$HOME/.android-build"
RELEASE_NOTES="${2:-Android 客户端更新}"
JDK_DIR="$BUILD_HOME/jdk-17"
SDK_DIR="$BUILD_HOME/android-sdk"
GRADLE_DIR="$BUILD_HOME/gradle-8.9"
LOG="$BUILD_HOME/build.log"

mkdir -p "$BUILD_HOME"
exec > >(tee -a "$LOG") 2>&1

echo "==> [1/6] 安装 JDK 17"
if [[ ! -x "$JDK_DIR/bin/java" ]]; then
  JDK_TAR="$BUILD_HOME/jdk17.tar.gz"
  curl -fsSL -o "$JDK_TAR" \
    "https://cdn.azul.com/zulu/bin/zulu17.56.15-ca-jdk17.0.14-linux_x64.tar.gz"
  rm -rf "$JDK_DIR"
  mkdir -p "$BUILD_HOME/jdk-extract"
  tar -xzf "$JDK_TAR" -C "$BUILD_HOME/jdk-extract"
  mv "$BUILD_HOME/jdk-extract"/zulu17.* "$JDK_DIR"
  rm -rf "$BUILD_HOME/jdk-extract" "$JDK_TAR"
fi
export JAVA_HOME="$JDK_DIR"
export PATH="$JAVA_HOME/bin:$PATH"
java -version

echo "==> [2/6] 安装 Android SDK"
if [[ ! -x "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" ]]; then
  CMD_ZIP="$BUILD_HOME/cmdline-tools.zip"
  curl -fsSL -o "$CMD_ZIP" \
    "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
  rm -rf "$SDK_DIR/cmdline-tools"
  mkdir -p "$SDK_DIR/cmdline-tools/latest"
  unzip_file "$CMD_ZIP" "$BUILD_HOME/cmdline-tmp"
  mv "$BUILD_HOME/cmdline-tmp/cmdline-tools/"* "$SDK_DIR/cmdline-tools/latest/"
  rm -rf "$BUILD_HOME/cmdline-tmp" "$CMD_ZIP"
  chmod +x "$SDK_DIR/cmdline-tools/latest/bin/"*
fi
export ANDROID_HOME="$SDK_DIR"
export PATH="$SDK_DIR/cmdline-tools/latest/bin:$SDK_DIR/platform-tools:$PATH"

echo "==> [3/6] 安装 SDK 组件"
yes | sdkmanager --sdk_root="$SDK_DIR" \
  "platform-tools" \
  "platforms;android-34" \
  "platforms;android-35" \
  "build-tools;34.0.0" \
  > /dev/null

echo "==> [4/6] 准备 Gradle Wrapper"
if [[ ! -x "$ANDROID_DIR/gradlew" ]]; then
  if [[ ! -x "$GRADLE_DIR/bin/gradle" ]]; then
    GRADLE_ZIP="$BUILD_HOME/gradle-8.9-bin.zip"
    curl -fsSL -o "$GRADLE_ZIP" "https://mirrors.cloud.tencent.com/gradle/gradle-8.9-bin.zip"
    rm -rf "$GRADLE_DIR"
    unzip_file "$GRADLE_ZIP" "$BUILD_HOME"
    rm -f "$GRADLE_ZIP"
    chmod +x "$GRADLE_DIR/bin/gradle"
  fi
  cd "$ANDROID_DIR"
  "$GRADLE_DIR/bin/gradle" wrapper \
    --gradle-version 8.9 \
    --gradle-distribution-url "https://mirrors.cloud.tencent.com/gradle/gradle-8.9-bin.zip" \
    --distribution-type bin
fi

echo "==> [5/6] 构建 debug APK"
cd "$ANDROID_DIR"
cat > local.properties <<EOF
sdk.dir=$SDK_DIR
EOF
chmod +x gradlew
./gradlew assembleDebug --no-daemon -x lint

APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
if [[ ! -f "$APK" ]]; then
  echo "APK 构建失败"
  exit 1
fi
ls -lah "$APK"

echo "==> [6/6] 发布到信令服务器"
bash "$ROOT/scripts/publish-apk.sh" "$APK" "${RELEASE_NOTES:-Android 客户端更新}"
echo "✓ 发布完成"
