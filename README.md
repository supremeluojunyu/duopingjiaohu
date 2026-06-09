# 实时全息投影与多屏互动系统

跨平台（Android + Windows）实时视频交互系统，支持多设备投屏、人像抠图、3D 多角度合成与管理员角度控制。

## 项目结构

```
holographic-system/
├── docs/           # 需求规格、API、部署文档
├── server/         # WebSocket 信令服务器 (Node.js)
├── client/         # Web/PC 客户端 (React + Three.js + WebRTC)
├── android/        # Android 原生客户端骨架 (Kotlin)
├── desktop/        # Electron Windows 打包
└── README.md
```

## 快速开始

### 1. 安装依赖

```bash
cd holographic-system
npm install --prefix server
npm install --prefix client
```

### 2. 启动信令服务器

```bash
npm run dev:server
# 默认 http://localhost:8765
```

### 3. 启动 Web 客户端

```bash
npm run dev:client
# 默认 http://localhost:5173
```

**手机访问需 HTTPS（摄像头权限）：**

```bash
npm run dev:https --prefix client
# 或: cd client && npm run dev:https
# 访问 https://<电脑IP>:5173
```

首次访问自签名证书时，浏览器会提示不安全，选择「继续访问」即可。

### 4. 多设备测试

1. 浏览器 A（电脑）：打开 http://localhost:5173，创建房间，勾选「管理员」
2. 浏览器 B（手机/另一窗口）：同地址加入，输入房间号（或扫描左侧二维码）
3. 两端点击「摄像头投屏」，电脑端勾选订阅手机画面
4. 管理员模式调节 Yaw/Pitch/Roll，实时预览 3D 合成
5. 点击「虚实融合」开启背景摄像头叠加
6. 点击「全息输出」在新窗口全屏投影

### 5. Docker 部署（含 TURN）

```bash
docker compose up -d signaling   # 仅信令
docker compose up -d             # 信令 + coturn
```

## MVP 功能清单

| 阶段 | 功能 | 状态 |
|------|------|------|
| P1 | 信令服务器 + WebRTC 双向投屏 | ✅ |
| P2 | 多路接收 + 2D 网格视图 | ✅ |
| P3 | MediaPipe 人像抠图（Web） | ✅ |
| P4 | Three.js 3D 半圆排列 | ✅ |
| P5 | 管理员角度调节面板 | ✅ |
| P6 | 手机角度指引罗盘 | ✅ |
| P7 | 立体对 (SBS) 输出模式 | ✅ |
| P8 | 虚实融合（背景摄像头叠加） | ✅ |
| P9 | 信令自动重连 + TURN 配置 | ✅ |
| P10 | 房间二维码 + 屏幕共享 | ✅ |
| P11 | Android WebRTC 完整实现 | ✅ |
| P12 | Android MediaPipe 抠图 | ✅ |
| P13 | 3D 浮雕 / 点云模式 | ✅ |
| P14 | HTTPS 开发环境 | ✅ |
| P15 | Electron EXE 打包 | 🔄 GitHub Actions CI |
| P16 | 性能监控 + 自适应降质 | ✅ |
| P17 | TURN 配置 API + Docker | ✅ |
| P18 | 一键启动 + 演示指南 | ✅ |

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 信令服务器端口 | 8765 |
| `VITE_SIGNALING_URL` | 客户端信令地址 | http://localhost:8765 |

## 一键启动

```bash
chmod +x scripts/start-all.sh
npm run start          # HTTP 模式
npm run start:https    # HTTPS（手机摄像头）
```

## 压测

```bash
# 先启动信令服务器，然后：
npm run benchmark --prefix server -- BENCH01 10
```

## 演示指南

详见 [docs/DEMO.md](docs/DEMO.md) — 含 5 分钟演示脚本与录制建议。

**用户操作说明**详见 [docs/USER_MANUAL.md](docs/USER_MANUAL.md)。

## 构建 Windows EXE

```bash
cd desktop
npm install
npm run build:win
```

## 构建 Android APK

需安装 Android Studio + SDK 34：

```bash
cd android
./gradlew assembleDebug
# 输出: app/build/outputs/apk/debug/app-debug.apk
```

## 文档

- **[使用说明书](docs/USER_MANUAL.md)** — 面向用户的完整操作指南（Web / Android / APK 下载 / 公网访问）
- [需求规格说明书 v1.1](docs/REQUIREMENTS.md)
- [信令 API](docs/API.md)
- [部署指南](docs/DEPLOYMENT.md)
- [演示指南](docs/DEMO.md)

## 技术栈

- **信令**: Node.js + ws + Express
- **媒体**: WebRTC (STUN)
- **3D**: Three.js
- **抠图**: MediaPipe Selfie Segmentation
- **桌面**: Electron
- **移动**: Kotlin + WebRTC Native (骨架)

## 许可证

MIT
