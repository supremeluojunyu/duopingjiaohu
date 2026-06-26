import { WebSocket } from 'ws';
import { roomManager } from './room-manager.js';
import { SignalingMessage } from './types.js';

function parseMessage(data: WebSocket.RawData): SignalingMessage | null {
  try {
    return JSON.parse(data.toString()) as SignalingMessage;
  } catch {
    return null;
  }
}

function error(ws: WebSocket, message: string): void {
  roomManager.sendToClient(ws, {
    type: 'error',
    payload: { message },
    timestamp: Date.now(),
  });
}

export function handleMessage(ws: WebSocket, raw: WebSocket.RawData): void {
  const msg = parseMessage(raw);
  if (!msg) {
    error(ws, '无效的消息格式');
    return;
  }

  const client = roomManager.getClientByWs(ws);

  switch (msg.type) {
    case 'join': {
      try {
        const existing = roomManager.getClientByWs(ws);
        if (existing) {
          roomManager.unregisterClient(ws);
          roomManager.broadcast(existing.roomId, {
            type: 'peer_left',
            payload: { deviceId: existing.deviceId },
            timestamp: Date.now(),
            from: existing.deviceId,
          });
        }

        const { roomId, password, device } = msg.payload as {
          roomId?: string;
          password?: string;
          device: {
            name: string;
            type: 'mobile' | 'desktop';
            role?: 'user' | 'admin';
            streamTypes?: ('camera' | 'screen')[];
            hasAlpha?: boolean;
          };
        };

        const { room, device: deviceInfo } = roomManager.joinRoom(
          ws,
          roomId,
          device,
          password
        );

        roomManager.sendToClient(ws, {
          type: 'joined',
          payload: {
            roomId: room.id,
            device: deviceInfo,
            devices: room.devices,
            mappings: room.mappings,
            presets: room.presets,
          },
          timestamp: Date.now(),
        });

        roomManager.sendRoomStateSync(ws, room.id, deviceInfo.id);

        roomManager.broadcast(
          room.id,
          {
            type: 'mapping_sync',
            payload: { mappings: room.mappings },
            timestamp: Date.now(),
          },
          deviceInfo.id
        );

        roomManager.broadcast(
          room.id,
          {
            type: 'peer_joined',
            payload: { device: deviceInfo },
            timestamp: Date.now(),
            from: deviceInfo.id,
          },
          deviceInfo.id
        );
      } catch (e) {
        error(ws, e instanceof Error ? e.message : '加入房间失败');
      }
      break;
    }

    case 'offer':
    case 'answer':
    case 'ice': {
      if (!client) {
        error(ws, '请先加入房间');
        return;
      }
      const to = msg.to ?? (msg.payload.targetId as string | undefined);
      if (!to) {
        error(ws, '缺少目标设备 ID');
        return;
      }
      const sent = roomManager.sendToDeviceInRoom(client.roomId, to, {
        ...msg,
        from: client.deviceId,
        timestamp: Date.now(),
      });
      if (!sent) {
        console.warn(
          `[signaling] ${msg.type} 投递失败: ${client.deviceId} -> ${to}`
        );
        error(ws, `目标设备不可达 (${to})，对方可能已离线`);
      }
      break;
    }

    case 'subscribe':
    case 'unsubscribe': {
      if (!client) {
        error(ws, '请先加入房间');
        return;
      }
      const message: SignalingMessage = {
        type: msg.type,
        payload: {
          ...msg.payload,
          subscriberId: client.deviceId,
        },
        timestamp: Date.now(),
        from: client.deviceId,
      };
      const to = msg.to ?? (msg.payload.publisherId as string | undefined);
      if (to) {
        const sent = roomManager.sendToDeviceInRoom(client.roomId, to, message);
        if (!sent) {
          console.warn(
            `[signaling] ${msg.type} 投递失败: ${client.deviceId} -> ${to}`
          );
          error(ws, `目标设备不可达 (${to})，对方可能已离线`);
        }
      } else {
        roomManager.broadcast(client.roomId, message, client.deviceId);
      }
      break;
    }

    case 'mapping_update': {
      if (!client || !roomManager.isAdmin(client.roomId, client.deviceId)) {
        error(ws, '需要管理员权限');
        return;
      }
      try {
        const mapping = msg.payload.mapping as import('./types.js').StreamMapping;
        const mappings = roomManager.updateMapping(client.roomId, mapping);
        roomManager.broadcast(client.roomId, {
          type: 'mapping_sync',
          payload: { mappings },
          timestamp: Date.now(),
          from: client.deviceId,
        });
      } catch (e) {
        error(ws, e instanceof Error ? e.message : '更新映射失败');
      }
      break;
    }

    case 'scene_save': {
      if (!client || !roomManager.isAdmin(client.roomId, client.deviceId)) {
        error(ws, '需要管理员权限');
        return;
      }
      try {
        const preset = roomManager.savePreset(client.roomId, msg.payload as Parameters<typeof roomManager.savePreset>[1]);
        roomManager.sendToClient(ws, {
          type: 'scene_save',
          payload: { preset },
          timestamp: Date.now(),
        });
      } catch (e) {
        error(ws, e instanceof Error ? e.message : '保存场景失败');
      }
      break;
    }

    case 'scene_load': {
      if (!client || !roomManager.isAdmin(client.roomId, client.deviceId)) {
        error(ws, '需要管理员权限');
        return;
      }
      try {
        const presetId = msg.payload.presetId as string;
        const preset = roomManager.loadPreset(client.roomId, presetId);
        roomManager.broadcast(client.roomId, {
          type: 'mapping_sync',
          payload: { mappings: preset.mappings, preset },
          timestamp: Date.now(),
          from: client.deviceId,
        });
      } catch (e) {
        error(ws, e instanceof Error ? e.message : '加载场景失败');
      }
      break;
    }

    case 'angle_guide': {
      if (!client || !roomManager.isAdmin(client.roomId, client.deviceId)) {
        error(ws, '需要管理员权限');
        return;
      }
      roomManager.sendAngleGuide(
        client.roomId,
        msg.payload as unknown as import('./types.js').AngleGuide,
        client.deviceId
      );
      break;
    }

    case 'sensor_report': {
      if (!client) return;
      const sensor = msg.payload.sensor as { yaw: number; pitch: number; roll: number };
      roomManager.updateSensor(client.roomId, client.deviceId, sensor);
      roomManager.broadcast(
        client.roomId,
        {
          type: 'sensor_report',
          payload: { deviceId: client.deviceId, sensor },
          timestamp: Date.now(),
          from: client.deviceId,
        },
        client.deviceId
      );
      break;
    }

    case 'device_update': {
      if (!client) return;
      const hasAlpha = msg.payload.hasAlpha as boolean | undefined;
      const updated = roomManager.updateDeviceFlags(client.roomId, client.deviceId, { hasAlpha });
      if (updated) {
        roomManager.broadcast(client.roomId, {
          type: 'device_update',
          payload: { device: updated },
          timestamp: Date.now(),
          from: client.deviceId,
        });
      }
      break;
    }

    case 'publish_started': {
      if (!client) return;
      roomManager.setPublishing(
        client.roomId,
        client.deviceId,
        Boolean(msg.payload.hasAlpha)
      );
      roomManager.broadcast(
        client.roomId,
        {
          type: 'publish_started',
          payload: {
            deviceId: client.deviceId,
            hasAlpha: Boolean(msg.payload.hasAlpha),
          },
          timestamp: Date.now(),
          from: client.deviceId,
        },
        client.deviceId
      );
      break;
    }

    case 'publish_stopped': {
      if (!client) return;
      roomManager.clearPublishing(client.roomId, client.deviceId);
      roomManager.broadcast(
        client.roomId,
        {
          type: 'publish_stopped',
          payload: { deviceId: client.deviceId },
          timestamp: Date.now(),
          from: client.deviceId,
        },
        client.deviceId
      );
      break;
    }

    case 'sync_room_state': {
      if (!client) {
        error(ws, '请先加入房间');
        return;
      }
      roomManager.sendRoomStateSync(ws, client.roomId, client.deviceId);
      break;
    }

    case 'role_change': {
      if (!client || !roomManager.isAdmin(client.roomId, client.deviceId)) {
        error(ws, '需要管理员权限');
        return;
      }
      const targetId = msg.payload.deviceId as string;
      const role = msg.payload.role as 'user' | 'admin';
      const updated = roomManager.setRole(client.roomId, targetId, role);
      if (updated) {
        roomManager.broadcast(client.roomId, {
          type: 'role_change',
          payload: { device: updated },
          timestamp: Date.now(),
          from: client.deviceId,
        });
      }
      break;
    }

    case 'ping': {
      roomManager.sendToClient(ws, {
        type: 'pong',
        payload: { sentAt: msg.timestamp },
        timestamp: Date.now(),
      });
      break;
    }

    default:
      error(ws, `未知消息类型: ${msg.type}`);
  }
}

export function handleClose(ws: WebSocket): void {
  const client = roomManager.getClientByWs(ws);
  if (!client) return;

  const wasPublishing = roomManager.isPublishing(client.roomId, client.deviceId);
  roomManager.unregisterClient(ws);

  if (wasPublishing) {
    roomManager.broadcast(client.roomId, {
      type: 'publish_stopped',
      payload: { deviceId: client.deviceId },
      timestamp: Date.now(),
      from: client.deviceId,
    });
  }

  roomManager.broadcast(client.roomId, {
    type: 'peer_left',
    payload: { deviceId: client.deviceId },
    timestamp: Date.now(),
    from: client.deviceId,
  });
}
