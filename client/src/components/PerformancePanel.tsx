import { StreamStats } from '../hooks/useWebRTCStats';

interface PerformancePanelProps {
  stats: StreamStats[];
  latency: number;
  roomDeviceCount: number;
  qualityReduced: boolean;
}

export function PerformancePanel({
  stats,
  latency,
  roomDeviceCount,
  qualityReduced,
}: PerformancePanelProps) {
  return (
    <div className="perf-panel">
      <h3>性能监控</h3>
      <div className="perf-summary">
        <span>信令延迟 <b>{latency}ms</b></span>
        <span>在线设备 <b>{roomDeviceCount}</b></span>
        {qualityReduced && <span className="perf-warn">已自动降质</span>}
      </div>
      {stats.length === 0 ? (
        <p className="empty-hint">订阅画面后显示流统计</p>
      ) : (
        <table className="perf-table">
          <thead>
            <tr>
              <th>设备</th>
              <th>码率</th>
              <th>FPS</th>
              <th>分辨率</th>
              <th>丢包</th>
              <th>抖动</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={`${s.deviceId}:${s.streamType}`} className={s.packetsLost > 10 ? 'warn' : ''}>
                <td>{s.deviceId.slice(0, 8)}</td>
                <td>{s.bitrateKbps} kbps</td>
                <td>{s.fps}</td>
                <td>{s.resolution}</td>
                <td>{s.packetsLost}</td>
                <td>{s.jitterMs}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
