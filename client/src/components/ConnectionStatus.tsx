import { getLatencyLevel } from '../utils/latency';

export type ConnectionVisualState = 'connecting' | 'connected' | 'disconnected';

interface ConnectionStatusProps {
  state: ConnectionVisualState;
  latency?: number;
  /** 覆盖默认文案，如加入页的「正在连接信令服务器...」 */
  label?: string;
  className?: string;
}

function statusLabel(state: ConnectionVisualState, latency: number, label?: string): string {
  if (label) return label;
  if (state === 'connecting') return '连接中...';
  if (state === 'disconnected') return '已断开';
  return latency > 0 ? `${latency}ms` : '已连接';
}

export function ConnectionStatus({
  state,
  latency = 0,
  label,
  className = '',
}: ConnectionStatusProps) {
  const text = statusLabel(state, latency, label);
  const latencyLevel =
    state === 'connected' && latency > 0 ? getLatencyLevel(latency) : '';

  return (
    <span
      className={`connection-status ${state} ${latencyLevel} ${className}`.trim()}
      role="status"
    >
      {state === 'connecting' && <span className="connection-spinner" aria-hidden />}
      {state === 'connected' && <span className="connection-icon" aria-hidden>✓</span>}
      {state === 'disconnected' && <span className="connection-icon" aria-hidden>✕</span>}
      <span>{text}</span>
    </span>
  );
}
