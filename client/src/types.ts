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

export interface RemoteStream {
  deviceId: string;
  streamType: StreamType;
  stream: MediaStream;
  hasAlpha: boolean;
}

export interface AppState {
  connected: boolean;
  roomId: string | null;
  device: DeviceInfo | null;
  devices: DeviceInfo[];
  mappings: StreamMapping[];
  presets: ScenePreset[];
  remoteStreams: Map<string, RemoteStream>;
  latency: number;
  isAdmin: boolean;
  angleGuide: AngleGuide | null;
  viewMode: '3d' | 'grid' | 'stereo' | 'relief' | 'pointcloud';
  segmentationEnabled: boolean;
}
