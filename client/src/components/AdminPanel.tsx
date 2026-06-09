import { DeviceInfo, StreamMapping, StreamType } from '../types';

interface AdminPanelProps {
  devices: DeviceInfo[];
  mappings: StreamMapping[];
  onMappingChange: (mapping: StreamMapping) => void;
  onSendAngleGuide: (deviceId: string, yaw: number, pitch: number) => void;
  onSaveScene: (name: string) => void;
  presets: { id: string; name: string }[];
  onLoadPreset: (presetId: string) => void;
}

function findMapping(mappings: StreamMapping[], deviceId: string, streamType: StreamType) {
  return mappings.find((m) => m.deviceId === deviceId && m.streamType === streamType);
}

export function AdminPanel({
  devices,
  mappings,
  onMappingChange,
  onSendAngleGuide,
  onSaveScene,
  presets,
  onLoadPreset,
}: AdminPanelProps) {
  const mobileDevices = devices.filter((d) => d.type === 'mobile' && d.online);

  return (
    <div className="admin-panel">
      <h3>管理员控制面板</h3>

      <div className="admin-section">
        <label>场景方案</label>
        <div className="row">
          <select onChange={(e) => e.target.value && onLoadPreset(e.target.value)} defaultValue="">
            <option value="" disabled>加载方案...</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button onClick={() => {
            const name = prompt('方案名称', `方案 ${new Date().toLocaleTimeString()}`);
            if (name) onSaveScene(name);
          }}>保存当前</button>
        </div>
      </div>

      {mobileDevices.map((device) => {
        const mapping = findMapping(mappings, device.id, 'camera');
        if (!mapping) return null;

        const update = (field: 'rotation' | 'position' | 'scale', key: string, value: number) => {
          const updated = { ...mapping };
          if (field === 'rotation') {
            updated.rotation = { ...mapping.rotation, [key]: value };
          } else if (field === 'position') {
            updated.position = { ...mapping.position, [key]: value };
          } else {
            updated.scale = value;
          }
          onMappingChange(updated);
        };

        return (
          <div key={device.id} className="device-control">
            <div className="device-control-header">
              <span>{device.name}</span>
              {device.sensor && (
                <span className="sensor-badge">
                  传感器 Y:{device.sensor.yaw.toFixed(0)}° P:{device.sensor.pitch.toFixed(0)}°
                </span>
              )}
            </div>

            <Slider label="Yaw (偏航)" value={mapping.rotation.yaw} min={-180} max={180}
              onChange={(v) => update('rotation', 'yaw', v)} />
            <Slider label="Pitch (俯仰)" value={mapping.rotation.pitch} min={-90} max={90}
              onChange={(v) => update('rotation', 'pitch', v)} />
            <Slider label="Roll (滚转)" value={mapping.rotation.roll} min={-45} max={45}
              onChange={(v) => update('rotation', 'roll', v)} />
            <Slider label="Scale (缩放)" value={mapping.scale} min={0.5} max={3} step={0.1}
              onChange={(v) => update('scale', '', v)} />
            <Slider label="Height (高度)" value={mapping.position.y} min={0} max={4} step={0.1}
              onChange={(v) => update('position', 'y', v)} />

            <button
              className="btn-secondary"
              onClick={() => onSendAngleGuide(device.id, mapping.rotation.yaw, mapping.rotation.pitch)}
            >
              发送角度指引到手机
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="slider-row">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">{value.toFixed(step < 1 ? 1 : 0)}</span>
    </div>
  );
}
