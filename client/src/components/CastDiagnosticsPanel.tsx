import { clearCastLog, CastEvent, CastStep } from '../utils/castLog';
import { useCastLog } from '../hooks/useCastLog';

const STEP_LABEL: Record<CastStep, string> = {
  preview: '预览',
  publish_started: '发布',
  subscribe: '订阅',
  offer: 'Offer',
  answer: 'Answer',
  ice: 'ICE',
  ontrack: '画面',
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function CastDiagnosticsPanel() {
  const { events, hint } = useCastLog();

  return (
    <div className="cast-diag-panel">
      <div className="cast-diag-header">
        <h3>投屏诊断</h3>
        <button type="button" className="cast-diag-clear" onClick={() => clearCastLog()}>
          清空
        </button>
      </div>
      {hint && <p className="cast-diag-hint">{hint}</p>}
      {events.length === 0 ? (
        <p className="empty-hint">开始投屏后显示链路日志</p>
      ) : (
        <ul className="cast-diag-list">
          {[...events].reverse().slice(0, 12).map((e: CastEvent) => (
            <li key={e.id} className={`cast-diag-item ${e.level}`}>
              <span className="cast-diag-time">{fmtTime(e.ts)}</span>
              <span className="cast-diag-step">{STEP_LABEL[e.step]}</span>
              <span className="cast-diag-msg">{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
