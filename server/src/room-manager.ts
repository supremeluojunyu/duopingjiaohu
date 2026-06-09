import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  AngleGuide,
  DeviceInfo,
  DeviceRole,
  DeviceType,
  ROOM_LIMITS,
  RoomState,
  ScenePreset,
  SignalingMessage,
  StreamMapping,
  StreamType,
  createDefaultMapping,
  generateRoomCode,
} from './types.js';

interface ConnectedClient {
  ws: WebSocket;
  deviceId: string;
  roomId: string;
}

export class RoomManager {
  private rooms = new Map<string, RoomState>();
  private clients = new Map<WebSocket, ConnectedClient>();
  private deviceSockets = new Map<string, WebSocket>();

  createRoom(password?: string): RoomState {
    let id = generateRoomCode();
    while (this.rooms.has(id)) {
      id = generateRoomCode();
    }
    const room: RoomState = {
      id,
      password,
      devices: [],
      mappings: [],
      presets: [],
      createdAt: Date.now(),
    };
    this.rooms.set(id, room);
    return room;
  }

  getRoom(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId.toUpperCase());
  }

  getOrCreateRoom(roomId?: string, password?: string): RoomState {
    if (roomId) {
      const existing = this.getRoom(roomId);
      if (existing) {
        if (existing.password && existing.password !== password) {
          throw new Error('房间密码错误');
        }
        return existing;
      }
    }
    return this.createRoom(password);
  }

  registerClient(ws: WebSocket, roomId: string, deviceId: string): void {
    this.clients.set(ws, { ws, deviceId, roomId });
    this.deviceSockets.set(deviceId, ws);
  }

  unregisterClient(ws: WebSocket): ConnectedClient | undefined {
    const client = this.clients.get(ws);
    if (!client) return undefined;

    this.clients.delete(ws);
    this.deviceSockets.delete(client.deviceId);

    const room = this.getRoom(client.roomId);
    if (room) {
      room.devices = room.devices.filter((d) => d.id !== client.deviceId);
      room.mappings = room.mappings.filter((m) => m.deviceId !== client.deviceId);
      if (room.devices.length === 0) {
        this.rooms.delete(room.id);
      }
    }
    return client;
  }

  joinRoom(
    ws: WebSocket,
    roomId: string | undefined,
    device: {
      name: string;
      type: DeviceType;
      role?: DeviceRole;
      streamTypes?: StreamType[];
      hasAlpha?: boolean;
    },
    password?: string,
    requestedRoomId?: string
  ): { room: RoomState; device: DeviceInfo } {
    const room = requestedRoomId
      ? this.getOrCreateRoom(requestedRoomId, password)
      : roomId
        ? this.getOrCreateRoom(roomId, password)
        : this.createRoom(password);

    const mobileCount = room.devices.filter((d) => d.type === 'mobile').length;
    const desktopCount = room.devices.filter((d) => d.type === 'desktop').length;

    if (device.type === 'mobile' && mobileCount >= ROOM_LIMITS.maxMobile) {
      throw new Error(`房间手机设备已达上限 (${ROOM_LIMITS.maxMobile})`);
    }
    if (device.type === 'desktop' && desktopCount >= ROOM_LIMITS.maxDesktop) {
      throw new Error(`房间电脑设备已达上限 (${ROOM_LIMITS.maxDesktop})`);
    }

    const deviceInfo: DeviceInfo = {
      id: uuidv4(),
      name: device.name,
      type: device.type,
      role: device.role ?? 'user',
      streamTypes: device.streamTypes ?? ['camera'],
      hasAlpha: device.hasAlpha ?? false,
      online: true,
      joinedAt: Date.now(),
    };

    room.devices.push(deviceInfo);

    for (const streamType of deviceInfo.streamTypes) {
      const existingMappings = room.mappings.filter((m) => m.visible);
      room.mappings.push(
        createDefaultMapping(deviceInfo.id, streamType, existingMappings.length, existingMappings.length + 1)
      );
    }

    this.registerClient(ws, room.id, deviceInfo.id);
    return { room, device: deviceInfo };
  }

  updateMapping(roomId: string, mapping: StreamMapping): StreamMapping[] {
    const room = this.getRoom(roomId);
    if (!room) throw new Error('房间不存在');

    const idx = room.mappings.findIndex(
      (m) => m.deviceId === mapping.deviceId && m.streamType === mapping.streamType
    );
    if (idx >= 0) {
      room.mappings[idx] = mapping;
    } else {
      room.mappings.push(mapping);
    }
    return room.mappings;
  }

  savePreset(roomId: string, preset: Omit<ScenePreset, 'id' | 'createdAt'>): ScenePreset {
    const room = this.getRoom(roomId);
    if (!room) throw new Error('房间不存在');

    const full: ScenePreset = {
      ...preset,
      id: uuidv4(),
      createdAt: Date.now(),
    };
    room.presets.push(full);
    return full;
  }

  loadPreset(roomId: string, presetId: string): ScenePreset {
    const room = this.getRoom(roomId);
    if (!room) throw new Error('房间不存在');

    const preset = room.presets.find((p) => p.id === presetId);
    if (!preset) throw new Error('场景方案不存在');

    room.mappings = [...preset.mappings];
    return preset;
  }

  updateSensor(roomId: string, deviceId: string, sensor: { yaw: number; pitch: number; roll: number }): void {
    const room = this.getRoom(roomId);
    if (!room) return;
    const device = room.devices.find((d) => d.id === deviceId);
    if (device) device.sensor = sensor;
  }

  broadcast(roomId: string, message: SignalingMessage, excludeDeviceId?: string): void {
    for (const [, client] of this.clients) {
      if (client.roomId !== roomId) continue;
      if (excludeDeviceId && client.deviceId === excludeDeviceId) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    }
  }

  sendToDevice(deviceId: string, message: SignalingMessage): boolean {
    const ws = this.deviceSockets.get(deviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  sendToClient(ws: WebSocket, message: SignalingMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  getClientByWs(ws: WebSocket): ConnectedClient | undefined {
    return this.clients.get(ws);
  }

  isAdmin(roomId: string, deviceId: string): boolean {
    const room = this.getRoom(roomId);
    const device = room?.devices.find((d) => d.id === deviceId);
    return device?.role === 'admin';
  }

  setRole(roomId: string, deviceId: string, role: DeviceRole): DeviceInfo | undefined {
    const room = this.getRoom(roomId);
    const device = room?.devices.find((d) => d.id === deviceId);
    if (device) device.role = role;
    return device;
  }

  sendAngleGuide(roomId: string, guide: AngleGuide, from: string): void {
    this.sendToDevice(guide.targetDeviceId, {
      type: 'angle_guide',
      payload: guide as unknown as Record<string, unknown>,
      timestamp: Date.now(),
      from,
    });
  }

  getStats(): { rooms: number; devices: number } {
    let devices = 0;
    for (const room of this.rooms.values()) {
      devices += room.devices.length;
    }
    return { rooms: this.rooms.size, devices };
  }
}

export const roomManager = new RoomManager();
