export type DeviceType = 'mobile' | 'desktop';
export type DeviceRole = 'user' | 'admin';
export type StreamType = 'camera' | 'screen';

export interface DeviceInfo {
  id: string;
  name: string;
  type: DeviceType;
  role: DeviceRole;
  streamTypes: StreamType[];
  hasAlpha: boolean;
  sensor?: { yaw: number; pitch: number; roll: number };
  online: boolean;
  joinedAt: number;
}

export interface StreamMapping {
  deviceId: string;
  streamType: StreamType;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number; roll: number };
  scale: number;
  visible: boolean;
}

export interface ScenePreset {
  id: string;
  name: string;
  layout: 'semicircle' | 'grid' | 'custom';
  mappings: StreamMapping[];
  cameraView?: { yaw: number; pitch: number; distance: number };
  createdAt: number;
}

export interface AngleGuide {
  targetDeviceId: string;
  targetYaw: number;
  targetPitch: number;
  tolerance: number;
  message?: string;
}

export interface RoomState {
  id: string;
  password?: string;
  devices: DeviceInfo[];
  mappings: StreamMapping[];
  presets: ScenePreset[];
  createdAt: number;
}

export type MessageType =
  | 'join'
  | 'joined'
  | 'peer_joined'
  | 'peer_left'
  | 'offer'
  | 'answer'
  | 'ice'
  | 'subscribe'
  | 'unsubscribe'
  | 'mapping_update'
  | 'mapping_sync'
  | 'angle_guide'
  | 'sensor_report'
  | 'scene_save'
  | 'scene_load'
  | 'ping'
  | 'pong'
  | 'error'
  | 'role_change'
  | 'device_update';

export interface SignalingMessage {
  type: MessageType;
  payload: Record<string, unknown>;
  timestamp: number;
  from?: string;
  to?: string;
}

export const ROOM_LIMITS = {
  maxMobile: 8,
  maxDesktop: 3,
} as const;

export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function createDefaultMapping(
  deviceId: string,
  streamType: StreamType,
  index: number,
  total: number
): StreamMapping {
  const angleStep = 30;
  const startAngle = -((total - 1) * angleStep) / 2;
  const yaw = startAngle + index * angleStep;
  const rad = (yaw * Math.PI) / 180;
  const radius = 3;

  return {
    deviceId,
    streamType,
    position: {
      x: Math.sin(rad) * radius,
      y: 1.5,
      z: Math.cos(rad) * radius,
    },
    rotation: { yaw, pitch: 0, roll: 0 },
    scale: 1.6,
    visible: true,
  };
}
