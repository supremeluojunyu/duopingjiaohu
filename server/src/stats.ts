import { roomManager } from './room-manager.js';

const startedAt = Date.now();

export function getServerStats() {
  const { rooms, devices } = roomManager.getStats();
  return {
    uptime: Date.now() - startedAt,
    rooms,
    totalDevices: devices,
    timestamp: Date.now(),
  };
}
