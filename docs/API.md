# 信令服务器 API

Base URL: `http://<host>:8765`

## REST 接口

### GET /health

健康检查。

**响应**
```json
{ "status": "ok", "timestamp": 1710000000000 }
```

### GET /config/ice

获取 WebRTC ICE 服务器配置（含 TURN，由服务端环境变量注入）。

**响应**
```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": "turn:your-ip:3478", "username": "holo", "credential": "secret" }
  ]
}
```

### GET /stats

服务运行统计。

**响应**
```json
{ "uptime": 3600000, "rooms": 2, "totalDevices": 5, "timestamp": 1710000000000 }
```

### POST /rooms

创建新房间。

**响应**
```json
{ "roomId": "ABC123" }
```

### GET /rooms/:id

查询房间状态（不含 WebRTC 细节）。

**响应**
```json
{
  "id": "ABC123",
  "deviceCount": 2,
  "devices": [
    { "id": "uuid", "name": "手机1", "type": "mobile", "online": true }
  ]
}
```

---

## WebSocket 信令

**连接**: `ws://<host>:8765/ws`

所有消息为 JSON，格式：

```json
{
  "type": "message_type",
  "payload": {},
  "timestamp": 1710000000000,
  "from": "device-uuid",
  "to": "target-device-uuid"
}
```

### join

客户端加入房间。

**请求 payload**
```json
{
  "roomId": "ABC123",
  "password": "optional",
  "device": {
    "name": "我的手机",
    "type": "mobile",
    "role": "user",
    "streamTypes": ["camera"],
    "hasAlpha": false
  }
}
```

**响应 joined**
```json
{
  "roomId": "ABC123",
  "device": { "id": "...", "name": "...", ... },
  "devices": [...],
  "mappings": [...],
  "presets": [...]
}
```

### offer / answer / ice

标准 WebRTC 信令，需设置 `to` 为目标设备 ID。

**offer payload**
```json
{
  "sdp": { "type": "offer", "sdp": "..." },
  "streamType": "camera",
  "targetId": "publisher-device-id"
}
```

### mapping_update (管理员)

更新某路画面在 3D 场景中的映射。

**payload**
```json
{
  "mapping": {
    "deviceId": "...",
    "streamType": "camera",
    "position": { "x": 0, "y": 1.5, "z": 3 },
    "rotation": { "yaw": 30, "pitch": 0, "roll": 0 },
    "scale": 1.6,
    "visible": true
  }
}
```

### angle_guide (管理员 → 手机)

**payload**
```json
{
  "targetDeviceId": "...",
  "targetYaw": 15,
  "targetPitch": -5,
  "tolerance": 5,
  "message": "请将手机向右转 15°"
}
```

### scene_save / scene_load

保存/加载场景预设方案（见 REQUIREMENTS.md 数据模型）。

### sensor_report (手机 → 管理员)

**payload**
```json
{
  "sensor": { "yaw": 12.5, "pitch": -3.2, "roll": 0.1 }
}
```

### ping / pong

心跳与延迟测量。

---

## 错误码

`error` 消息 payload:

```json
{ "message": "房间密码错误" }
```

常见错误：
- 房间不存在
- 房间密码错误
- 设备数量超限（8 手机 + 3 电脑）
- 需要管理员权限
