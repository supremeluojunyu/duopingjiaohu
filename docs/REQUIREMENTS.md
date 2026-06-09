# 项目需求规格说明书 – 实时全息投影与多屏互动系统

> 版本：v1.1 | 状态：MVP 开发中 | 最后更新：2026-06-09

---

## 1. 项目概述

### 1.1 目标
开发一套跨平台（Android 手机端 + Windows 电脑端）的实时视频交互系统，实现多设备屏幕/摄像头画面的双向投屏、多角度合成、人像抠图、3D 播放以及后台视角控制，最终形成实时全息投影效果。

### 1.2 核心价值
- 多台手机作为不同角度摄像机，采集人像后经抠图，在电脑端组合成可自由调节视角的 3D 场景
- 支持外部屏幕/投影仪的实时全息映射输出
- 管理员可实时调节每路画面的空间角度与手机拍摄引导

### 1.3 项目边界（Out of Scope – v1.0）
- 云端 AI 训练与自定义抠图模型训练
- 商业级 DRM 与付费订阅
- iOS 原生客户端（后续版本）
- 物理全息金字塔硬件驱动（仅提供标准 HDMI/DisplayPort 输出）

---

## 2. 用户角色与权限

| 角色 | 平台 | 权限 |
|------|------|------|
| 普通用户（手机） | Android APK | 采集/推流、接收投屏、加入房间、开启抠图、接收角度指引 |
| 普通用户（电脑） | Windows EXE / Web | 订阅多路画面、3D 浏览、保存个人场景 |
| 管理员（电脑） | Windows EXE / Web | 全部普通用户权限 + 角度调节、发送手机指引、加载场景方案、全息输出 |
| 系统（信令服务） | 服务器 | 房间管理、信令转发、状态持久化（可选） |

### 2.1 权限矩阵

| 操作 | 手机用户 | 电脑用户 | 管理员 |
|------|:--------:|:--------:|:------:|
| 创建/加入房间 | ✓ | ✓ | ✓ |
| 推流（摄像头/屏幕） | ✓ | ✓ | ✓ |
| 订阅他人画面 | ✓ | ✓ | ✓ |
| 调节 3D 映射角度 | ✗ | ✗ | ✓ |
| 发送手机角度指引 | ✗ | ✗ | ✓ |
| 保存/加载场景方案 | ✗ | ✓ | ✓ |
| 全息投影全屏输出 | ✗ | ✓ | ✓ |

---

## 3. 系统架构

### 3.1 逻辑架构

```
┌─────────────┐     WebRTC Media      ┌─────────────┐
│  Android    │◄─────────────────────►│  Windows    │
│  Client     │     (P2P / SFU)       │  Client     │
└──────┬──────┘                       └──────┬──────┘
       │ WebSocket 信令                      │ WebSocket 信令
       └──────────────┬──────────────────────┘
                      ▼
              ┌───────────────┐
              │ Signaling     │
              │ Server        │
              │ (Node.js)     │
              └───────────────┘
```

### 3.2 技术栈（MVP 确定）

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| 信令服务 | Node.js + ws + Express | 房间、设备、WebRTC 信令、角度控制 |
| 媒体传输 | WebRTC (STUN/TURN) | 局域网 P2P 优先，公网需 TURN |
| 电脑端 UI | React + Vite + Three.js | 开发期 Web 可用，Electron 打包 EXE |
| 手机端 | Kotlin + WebRTC Native | MVP 提供 Web 备选 + Android 骨架 |
| 人像抠图 | MediaPipe Selfie Segmentation | 手机端 GPU，电脑端 Canvas 后备 |
| 3D 渲染 | Three.js | 半圆排列、角度调节、立体对输出 |
| 配置持久化 | JSON 文件 / localStorage | 场景方案本地保存 |

### 3.3 硬件/软件环境

- **手机端**：Android 8.0+，摄像头，Wi-Fi 5/6，OpenGL ES 3.1+（抠图 GPU 加速）
- **电脑端**：Windows 10/11，独立显卡，DirectX 12；开发/演示可用现代浏览器
- **网络**：局域网优先（延迟 < 200ms）；公网需部署 TURN 服务器

---

## 4. 数据模型

### 4.1 设备 (Device)

```typescript
interface Device {
  id: string;              // UUID
  name: string;            // 用户可读名称
  type: 'mobile' | 'desktop';
  role: 'user' | 'admin';
  roomId: string;
  streamTypes: ('camera' | 'screen')[];
  hasAlpha: boolean;       // 是否发送抠图 Alpha
  sensor?: {               // 手机传感器（可选）
    yaw: number;
    pitch: number;
    roll: number;
  };
  online: boolean;
  joinedAt: number;
}
```

### 4.2 流订阅 (Subscription)

```typescript
interface Subscription {
  subscriberId: string;
  publisherId: string;
  streamType: 'camera' | 'screen';
}
```

### 4.3 3D 映射配置 (SceneMapping)

```typescript
interface StreamMapping {
  deviceId: string;
  streamType: 'camera' | 'screen';
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number; roll: number }; // 度
  scale: number;
  visible: boolean;
}

interface ScenePreset {
  id: string;
  name: string;
  layout: 'semicircle' | 'grid' | 'custom';
  mappings: StreamMapping[];
  cameraView?: { yaw: number; pitch: number; distance: number };
  createdAt: number;
}
```

### 4.4 手机角度指引 (AngleGuide)

```typescript
interface AngleGuide {
  targetDeviceId: string;
  targetYaw: number;
  targetPitch: number;
  tolerance: number;       // 允许误差 ±度
  message?: string;
}
```

---

## 5. 信令协议（WebSocket JSON）

### 5.1 通用消息格式

```json
{
  "type": "message_type",
  "payload": {},
  "timestamp": 1710000000000,
  "from": "device-uuid"
}
```

### 5.2 消息类型一览

| type | 方向 | 说明 |
|------|------|------|
| `join` | C→S | 加入房间，携带 device 信息 |
| `joined` | S→C | 加入成功，返回 room 状态 |
| `peer_joined` | S→All | 新设备上线 |
| `peer_left` | S→All | 设备离线 |
| `offer` / `answer` / `ice` | C↔S↔C | WebRTC 信令 |
| `subscribe` | C→S | 请求订阅某设备流 |
| `unsubscribe` | C→S | 取消订阅 |
| `mapping_update` | Admin→S→All | 更新 3D 映射角度 |
| `mapping_sync` | S→C | 全量同步当前映射 |
| `angle_guide` | Admin→S→Mobile | 发送手机拍摄角度指引 |
| `sensor_report` | Mobile→S→Admin | 上报手机传感器角度 |
| `scene_save` | C→S | 保存场景方案 |
| `scene_load` | Admin→S→All | 加载场景方案 |
| `ping` / `pong` | C↔S | 心跳与延迟测量 |
| `error` | S→C | 错误通知 |

### 5.3 房间限制

- 单房间最多：**8 手机 + 3 电脑**
- 单电脑建议同时解码：**4～6 路 720p@30fps**
- 房间号：6 位字母数字，扫码或手动输入

---

## 6. 功能需求详情

### 6.1 基础投屏（双向）— MVP Phase 1

| ID | 功能 | 描述 | 验收标准 |
|----|------|------|----------|
| F1 | 手机→电脑投屏 | 摄像头/屏幕实时传输 | 720p@30fps，延迟 LAN ≤200ms |
| F2 | 电脑→手机投屏 | 屏幕/窗口/摄像头到手机 | 手机全屏/小窗播放 |
| F3 | 多设备互投 | 8 手机 + 3 电脑同房间 | 自由订阅任意在线流 |

### 6.2 多手机取像与合成 — MVP Phase 2-4

| ID | 功能 | 描述 | 验收标准 |
|----|------|------|----------|
| F4 | 多路同步接收 | ≥4 路 1080p/720p | 无明显卡顿，延迟 <150ms LAN |
| F5 | 3D 空间排列 | 平面纹理球面/半圆布局 | 默认半圆 30° 间隔，可拖拽 |
| F6 | 人像抠图 | MediaPipe 实时分割 | Alpha 通道合成，开关可选 |
| F7 | 3D 播放模式 | 旋转查看 + 立体对 | 鼠标拖拽视角；SBS 立体输出 |

### 6.3 后台管理 — MVP Phase 5-6

| ID | 功能 | 描述 | 验收标准 |
|----|------|------|----------|
| F8 | 管理员模式 | 控制面板切换 | 角色校验，UI 即时切换 |
| F9 | 独立角度调节 | Yaw/Pitch/Roll 滑条 | 每路独立，实时预览 |
| F10 | 实时预览 | 滑块联动 3D 场景 | 所见即所得，<50ms UI 响应 |
| F11 | 场景保存/加载 | JSON 预设方案 | 本地 + 服务端可选持久化 |

### 6.4 全息投影 — MVP Phase 7-8

| ID | 功能 | 描述 | 验收标准 |
|----|------|------|----------|
| F12 | 投影输出 | 全屏第二显示器 | 支持扩展屏/投影仪 |
| F13 | 虚实融合 | 抠图人像 + 实时背景 | 背景摄像头或视频叠加 |

---

## 7. 非功能需求

| 类别 | 指标 |
|------|------|
| 延迟 | LAN ≤200ms E2E；WAN ≤400ms（需 TURN） |
| 分辨率/帧率 | 推流 720p@30fps 默认，可调 480p/1080p |
| 并发 | 单 PC 4-6 路解码不卡顿（GPU 加速） |
| 稳定性 | 断线 5s 内自动重连，ICE restart |
| 安全 | 房间密码（可选）、WSS、管理员 Token |
| 易用性 | 扫码入房、一键投屏、向导配置 |
| 可维护性 | 模块化 monorepo，TypeScript 共享类型 |

---

## 8. 界面规格

### 8.1 手机端
- 主界面：开始投屏、接收列表、扫码入房
- 设置：人像抠图开关、角度指引罗盘
- 状态栏：延迟、房间号、连接状态

### 8.2 电脑端（普通用户）
- 左：设备列表（勾选订阅）
- 中：3D 视图（拖拽旋转/滚轮缩放）
- 右：缩略图 + 音量
- 顶：管理员模式、全息输出、保存场景

### 8.3 电脑端（管理员）
- 浮动面板：每设备 Yaw/Pitch/Roll 滑条
- 传感器数值覆盖显示
- 「发送角度预设到手机」按钮
- 场景方案下拉加载

---

## 9. 开发阶段与里程碑

| 阶段 | 内容 | 交付物 | 状态 |
|------|------|--------|------|
| P1 | 信令服务器 + 单路双向 WebRTC | server + 基础 client | ✅ 完成 |
| P2 | 多路接收 + 2D 网格 | client 多窗口 | ✅ 完成 |
| P3 | 手机端抠图 Alpha | Android MediaPipe + Web segmentation | ✅ 完成 |
| P4 | Three.js 3D 半圆排列 | 3D 场景模块 | ✅ 完成 |
| P5 | 管理员角度面板 | Admin UI + mapping API | ✅ 完成 |
| P6 | 手机角度指引 UI | 罗盘 + 信令 | ✅ 完成 |
| P7 | 性能优化 + 3D 特效 | 立体对、浮雕、点云 | ✅ 完成 |
| P8 | Electron EXE + 全息输出 | desktop 打包 | 🔄 配置完成 |

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 公网 NAT 穿透失败 | 无法 P2P | 部署 coturn TURN 服务 |
| 手机 GPU 抠图性能不足 | 帧率下降 | 降级 480p / 电脑端抠图 |
| 多路解码 CPU 瓶颈 | 卡顿 | 硬解 + 限制路数 + SFU |
| Unity 开发周期长 | 延期 | MVP 用 Three.js，后期可迁移 |
| 传感器精度不足 | 指引偏差 | 人工校准 + 容差配置 |

---

## 11. 测试策略

- **单元测试**：信令消息解析、场景配置序列化
- **集成测试**：双客户端加房、订阅、WebRTC 连通
- **性能测试**：4 路 720p 同时推流延迟与 CPU/GPU 占用
- **UAT**：演示脚本覆盖 F1-F11 主流程

---

## 12. 交付物清单

- [ ] `server/` — 信令服务器源码与 Docker 部署
- [ ] `client/` — Web/PC 客户端源码
- [ ] `android/` — Android APK 工程源码
- [ ] `desktop/` — Electron Windows 打包配置
- [ ] `docs/` — 需求、API、部署、用户手册
- [ ] 演示视频（多角度投屏、抠图、角度调节）

---

## 13. 术语表

| 术语 | 说明 |
|------|------|
| SFU | Selective Forwarding Unit，选择性转发单元 |
| ICE | Interactive Connectivity Establishment，WebRTC 连接建立 |
| TURN | 中继服务器，用于 NAT 穿透 |
| Alpha 通道 | 透明通道，用于抠图合成 |
| SBS | Side-by-Side，左右眼立体输出格式 |
| Yaw/Pitch/Roll | 偏航/俯仰/滚转，三维旋转角 |
