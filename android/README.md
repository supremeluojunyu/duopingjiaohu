# Android 客户端

Kotlin 原生 Android 应用，与 Web/PC 客户端共用同一信令协议。

## 已实现

- [x] WebSocket 信令（连接、心跳、延迟显示）
- [x] WebRTC 摄像头采集与推流
- [x] 完整 SDP offer/answer/ICE 交换
- [x] 接收电脑端远端画面（小窗预览）
- [x] 角度指引罗盘 UI
- [x] 传感器角度上报（Rotation Vector）
- [x] 扫码 / 手动加入房间
- [x] 运行时权限申请

## 待完成

- [x] MediaPipe GPU 人像抠图（VideoProcessor 实时分割）
- [ ] 屏幕采集投屏
- [ ] 后台服务保活

## 配置

编辑 `SignalingConfig.kt`：

```kotlin
const val SERVER_URL = "ws://192.168.1.100:8765/ws"
```

将 IP 改为运行信令服务器的电脑局域网地址。

## 构建

1. 下载 MediaPipe 模型（首次必须）：

```bash
./scripts/download-model.sh
```

2. 用 Android Studio 打开 `android/` 目录
3. 修改 `SignalingConfig.kt` 中的 `SERVER_URL`
4. Sync Gradle → Run

或命令行：

```bash
cd android
./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

## 与 Web 端互通测试

1. 电脑启动信令服务器 + Web 客户端
2. Web 端创建房间，记下房间号
3. 手机 APK 输入房间号加入
4. 手机点击「开始投屏」
5. Web 端勾选订阅 → 3D 视图显示手机画面
6. Web 管理员发送角度指引 → 手机显示罗盘

## 权限

| 权限 | 用途 |
|------|------|
| CAMERA | 摄像头采集 |
| RECORD_AUDIO | 音频推流 |
| INTERNET | 网络通信 |

## 架构

```
MainActivity
  ├── SignalingClient   (OkHttp WebSocket)
  ├── WebRTCManager     (Camera2 + PeerConnection)
  └── AngleGuideView    (自定义罗盘 UI)
```
