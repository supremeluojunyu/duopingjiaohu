# 部署指南

## 局域网部署（推荐演示）

### 信令服务器

```bash
cd server
npm install
npm run dev
# 或生产模式
npm run build && npm start
```

服务器监听 `0.0.0.0:8765`，局域网内其他设备可通过本机 IP 访问。

### Web 客户端

```bash
cd client
npm install
VITE_SIGNALING_URL=http://192.168.1.100:8765 npm run dev
```

手机浏览器访问 `http://192.168.1.100:5173`（需 HTTPS 才能使用摄像头，见下方）。

### HTTPS 要求

WebRTC 的 `getUserMedia` 在非 localhost 环境需要 HTTPS：

**开发快速方案** — 使用 mkcert：

```bash
mkcert -install
mkcert localhost 192.168.1.100
# 配置 vite 或使用 nginx 反向代理挂载证书
```

**生产方案** — nginx + Let's Encrypt 或内网 CA。

---

## Docker 部署信令服务

```bash
docker build -t holographic-signaling ./server
docker run -d -p 8765:8765 --name signaling holographic-signaling
```

---

## TURN 服务器（公网穿透）

局域网外或复杂 NAT 环境需部署 [coturn](https://github.com/coturn/coturn)：

```bash
# /etc/turnserver.conf 示例
listening-port=3478
fingerprint
lt-cred-mech
user=holo:yourpassword
realm=holographic.local
```

客户端 ICE 配置中添加：

```javascript
{
  urls: 'turn:your-turn-server:3478',
  username: 'holo',
  credential: 'yourpassword'
}
```

---

## Windows EXE 打包

```bash
cd desktop
npm install
npm run build:win
# 输出 dist/HolographicSystem-Setup.exe
```

---

## Android APK

1. 安装 Android Studio
2. 打开 `android/` 目录
3. 修改 `SignalingConfig.kt` 中的服务器地址
4. Build → Build APK

---

## 性能建议

| 场景 | 建议 |
|------|------|
| 4 路 720p | 电脑需独立 GPU，关闭多余订阅 |
| 抠图 | 手机端优先，降级 480p |
| 投影输出 | 使用第二显示器全屏，立体对模式 |
| 公网 | 必须 TURN + 限制码率 1.5Mbps/路 |

---

## 防火墙端口

| 端口 | 协议 | 用途 |
|------|------|------|
| 8765 | TCP | 信令 HTTP/WebSocket |
| 3478 | UDP/TCP | TURN（可选） |
| 49152-65535 | UDP | WebRTC 媒体 |
