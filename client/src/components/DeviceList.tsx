import { DeviceInfo } from '../types';

interface DeviceListProps {
  devices: DeviceInfo[];
  localDeviceId: string | null;
  subscribed: Set<string>;
  publishingDevices: Set<string>;
  onSubscribe: (deviceId: string) => void;
  onUnsubscribe: (deviceId: string) => void;
}

export function DeviceList({
  devices,
  localDeviceId,
  subscribed,
  publishingDevices,
  onSubscribe,
  onUnsubscribe,
}: DeviceListProps) {
  const others = devices.filter((d) => d.id !== localDeviceId);

  return (
    <div className="device-list">
      <h3>在线设备 ({others.length})</h3>
      {others.length === 0 && (
        <p className="empty-hint">等待其他设备加入房间...</p>
      )}
      {others.map((device) => (
        <div key={device.id} className="device-item">
          <div className="device-info">
            <span className={`device-type ${device.type}`}>
              {device.type === 'mobile' ? '📱' : '💻'}
            </span>
            <div>
              <div className="device-name">{device.name}</div>
              <div className="device-id-hint">{device.id.slice(0, 8)}…</div>
              <div className="device-meta">
                {device.role === 'admin' && <span className="badge admin">管理员</span>}
                {device.hasAlpha && <span className="badge alpha">抠图</span>}
                {device.type === 'mobile' && publishingDevices.has(device.id) && (
                  <span className="badge publishing">投屏中</span>
                )}
                {device.type === 'mobile' && !publishingDevices.has(device.id) && (
                  <span className="badge waiting">待投屏</span>
                )}
              </div>
            </div>
          </div>
          {device.type === 'mobile' ? (
            <span className="auto-recv-label">
              {publishingDevices.has(device.id) ? '自动接收' : '等待投屏'}
            </span>
          ) : (
            <label className="toggle">
              <input
                type="checkbox"
                checked={subscribed.has(device.id)}
                onChange={(e) =>
                  e.target.checked ? onSubscribe(device.id) : onUnsubscribe(device.id)
                }
              />
              订阅
            </label>
          )}
        </div>
      ))}
    </div>
  );
}
