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
  readReleaseInfo,
  toPublicRelease,
} from './app-release.js';

const PORT = Number(process.env.PORT ?? 9876);
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
});
