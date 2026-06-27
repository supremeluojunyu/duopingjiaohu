import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { handleClose, handleMessage } from './message-handler.js';
import { getIceConfig } from './ice-config.js';
import { getServerStats } from './stats.js';
import { roomManager } from './room-manager.js';
import {
  ensureDownloadsDir,
  getDownloadsDir,
  publishExeFromBuffer,
  readDesktopReleaseInfo,
  readReleaseInfo,
  toPublicDesktopRelease,
  toPublicRelease,
} from './app-release.js';

const PORT = Number(process.env.PORT ?? 9876);
const PUBLISH_SECRET = process.env.PUBLISH_SECRET ?? '';
const app = express();

app.use(cors());
app.use(express.json());

ensureDownloadsDir();
app.use('/downloads', express.static(getDownloadsDir(), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.apk')) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="holographic.apk"');
    }
    if (filePath.endsWith('.exe')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="HolographicSystem.exe"');
    }
  },
}));

function getBaseUrl(req: express.Request): string {
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  const host = req.get('x-forwarded-host') ?? req.get('host') ?? `localhost:${PORT}`;
  return `${proto}://${host}`;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ...getServerStats() });
});

function sendIceConfig(_req: express.Request, res: express.Response): void {
  res.json(getIceConfig());
}

app.get('/config/ice', sendIceConfig);
app.get('/api/ice', sendIceConfig);

app.get('/stats', (_req, res) => {
  res.json(getServerStats());
});

app.get('/api/app/version', (req, res) => {
  const info = readReleaseInfo();
  res.json(toPublicRelease(info, getBaseUrl(req)));
});

app.get('/api/desktop/version', (req, res) => {
  const info = readDesktopReleaseInfo();
  res.json(toPublicDesktopRelease(info, getBaseUrl(req)));
});

app.post(
  '/api/admin/publish-exe',
  express.raw({ limit: '600mb', type: 'application/octet-stream' }),
  (req, res) => {
    const token = String(req.query.token ?? '');
    if (PUBLISH_SECRET && token !== PUBLISH_SECRET) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const version = String(req.query.version ?? '');
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
      res.status(400).json({ error: 'invalid version, expected x.y.z.w' });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 1024) {
      res.status(400).json({ error: 'empty exe body' });
      return;
    }
    const notes = String(req.query.notes ?? `桌面端 v${version}`);
    const info = publishExeFromBuffer(req.body, { versionName: version, releaseNotes: notes });
    console.log(`[Publish] EXE v${info.versionName} (${info.fileSize} bytes)`);
    res.json(toPublicDesktopRelease(info, getBaseUrl(req)));
  }
);

app.post('/rooms', (_req, res) => {
  const room = roomManager.createRoom();
  res.json({ roomId: room.id });
});

app.get('/rooms/:id', (req, res) => {
  const room = roomManager.getRoom(req.params.id);
  if (!room) {
    res.status(404).json({ error: '房间不存在' });
    return;
  }
  res.json({
    id: room.id,
    deviceCount: room.devices.length,
    devices: room.devices.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      online: d.online,
    })),
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.on('message', (data) => handleMessage(ws, data));
  ws.on('close', () => handleClose(ws));
  ws.on('error', () => handleClose(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Holographic Signaling] HTTP + WebSocket on http://0.0.0.0:${PORT}`);
  console.log(`  WebSocket: ws://0.0.0.0:${PORT}/ws`);
  console.log(`  APK 版本: http://0.0.0.0:${PORT}/api/app/version`);
  console.log(`  APK 下载: http://0.0.0.0:${PORT}/downloads/app-latest.apk`);
  console.log(`  EXE 版本: http://0.0.0.0:${PORT}/api/desktop/version`);
  console.log(`  EXE 下载: http://0.0.0.0:${PORT}/downloads/app-latest.exe`);
});
