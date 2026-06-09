import { AngleGuide } from '../types';

interface AngleGuideOverlayProps {
  guide: AngleGuide | null;
  currentSensor?: { yaw: number; pitch: number; roll: number };
}

export function AngleGuideOverlay({ guide, currentSensor }: AngleGuideOverlayProps) {
  if (!guide) return null;

  const deltaYaw = currentSensor ? guide.targetYaw - currentSensor.yaw : 0;
  const deltaPitch = currentSensor ? guide.targetPitch - currentSensor.pitch : 0;
  const aligned =
    currentSensor &&
    Math.abs(deltaYaw) <= guide.tolerance &&
    Math.abs(deltaPitch) <= guide.tolerance;

  return (
    <div className={`angle-guide-overlay ${aligned ? 'aligned' : ''}`}>
      <div className="compass">
        <div
          className="compass-arrow"
          style={{ transform: `rotate(${deltaYaw}deg)` }}
        />
        <div className="compass-ring" />
      </div>
      <div className="guide-text">
        {guide.message ?? '请调整手机角度'}
        <div className="guide-deltas">
          偏航: {deltaYaw > 0 ? '→' : '←'} {Math.abs(deltaYaw).toFixed(0)}°
          {' · '}
          俯仰: {deltaPitch > 0 ? '↑' : '↓'} {Math.abs(deltaPitch).toFixed(0)}°
        </div>
        {aligned && <div className="aligned-badge">✓ 角度已对齐</div>}
      </div>
    </div>
  );
}
