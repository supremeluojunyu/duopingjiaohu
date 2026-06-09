# 演示指南

## 5 分钟快速演示脚本

### 准备

```bash
chmod +x scripts/start-all.sh
./scripts/start-all.sh https   # 手机测试用 HTTPS
# 或
./scripts/start-all.sh http    # 仅电脑本地测试
```

### 演示流程（建议录制顺序）

#### 第一幕：创建房间（30 秒）

1. 电脑浏览器打开 `https://localhost:5173`
2. 设备类型选「电脑」，勾选「管理员」和「人像抠图」
3. 点击「进入房间」，记下左侧 **二维码** 和 **房间号**

#### 第二幕：手机加入（30 秒）

4. 手机浏览器扫描 QR 码（或 Android APK 输入房间号）
5. 手机勾选「人像抠图」→「开始投屏」
6. 电脑端设备列表勾选「订阅」手机

#### 第三幕：3D 合成（1 分钟）

7. 电脑切换视图：**3D** → **浮雕** → **点云**
8. 鼠标拖拽旋转 3D 视角，滚轮缩放
9. 点击「虚实融合」叠加背景摄像头

#### 第四幕：管理员控制（1 分钟）

10. 点击「管理员模式」，底部出现控制面板
11. 调节某手机的 Yaw / Pitch / Roll 滑条，观察 3D 实时变化
12. 点击「发送角度指引到手机」→ 手机显示罗盘箭头
13. 「保存当前」场景方案 → 下拉加载验证

#### 第五幕：多设备与全息输出（1 分钟）

14. 再开 1～2 个浏览器窗口模拟第二、第三台手机
15. 全部订阅，观察 3D 半圆排列
16. 切换「立体对」模式
17. 点击「全息输出」→ 新窗口全屏到第二显示器/投影仪

#### 第六幕：性能监控（30 秒）

18. 右侧「性能监控」面板查看码率、FPS、丢包
19. 模拟弱网（Chrome DevTools → Network → Slow 3G）观察自动降质

---

## Docker 生产部署演示

```bash
cp deploy/.env.example .env
# 编辑 .env 填入公网 IP 和 TURN 密码

docker compose up -d signaling
docker compose --profile turn up -d   # 含 TURN

curl http://YOUR_IP:8765/config/ice  # 验证 TURN 配置下发
```

---

## 桌面 EXE 演示

**Windows 构建（GitHub Actions）：**

```bash
git tag v0.1.0 && git push origin v0.1.0
# Actions 自动构建，Artifacts 下载 .exe
```

**本地 Linux 构建：**

```bash
cd desktop
npm install
npm run build:linux
# 输出: dist/全息投影系统-0.1.0.AppImage
```

**运行：**

```bash
HOLO_SIGNALING_URL=http://192.168.1.100:8765 ./HolographicSystem-Portable-0.1.0.exe
# 或全息模式
electron . --hologram
```

---

## 压测

```bash
# 信令层 10 客户端并发加入
cd server && npx tsx ../scripts/benchmark-cli.ts DEMO01 10
```

---

## 录制建议

| 工具 | 说明 |
|------|------|
| OBS Studio | 录制电脑端 3D 画面 + 手机画中画 |
| 手机录屏 | 录制角度指引罗盘效果 |
| 分屏 | 左：管理员面板，右：3D 视图 |

推荐输出：2～3 分钟精华版 + 5 分钟完整版。
