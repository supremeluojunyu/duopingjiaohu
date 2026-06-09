import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { handleClose, handleMessage } from './message-handler.js';
import { getIceConfig } from './ice-config.js';
import { getServerStats } from './stats.js';
import { roomManager } from './room-manager.js';

const PORT = Number(process.env.PORT ?? 9876);
const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ...getServerStats() });
});

app.get('/config/ice', (_req, res) => {
  res.json(getIceConfig());
});

app.get('/stats', (_req, res) => {
  res.json(getServerStats());
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
});
