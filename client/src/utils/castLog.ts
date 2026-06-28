/** 投屏链路诊断日志 — 对应排查清单各节点 */
export type CastStep =
  | 'preview'
  | 'publish_started'
  | 'subscribe'
  | 'offer'
  | 'answer'
  | 'ice'
  | 'ontrack';

export type CastLevel = 'ok' | 'warn' | 'err' | 'info';

export interface CastEvent {
  id: number;
  ts: number;
  step: CastStep;
  level: CastLevel;
  message: string;
  detail?: string;
}

const MAX_EVENTS = 80;
let seq = 0;
let events: CastEvent[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function castLog(
  step: CastStep,
  message: string,
  level: CastLevel = 'info',
  detail?: string
): void {
  const entry: CastEvent = {
    id: ++seq,
    ts: Date.now(),
    step,
    level,
    message,
    detail,
  };
  events = [...events.slice(-(MAX_EVENTS - 1)), entry];
  const tag = `[cast:${step}]`;
  if (level === 'err') console.error(tag, message, detail ?? '');
  else if (level === 'warn') console.warn(tag, message, detail ?? '');
  else console.info(tag, message, detail ?? '');
  emit();
}

export function getCastEvents(): CastEvent[] {
  return events;
}

export function clearCastLog(): void {
  events = [];
  emit();
}

export function subscribeCastLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** ICE 是否已连通（避免 "connecting"/"disconnected" 误匹配 "connected"） */
function iceIsConnected(recent: CastEvent[]): boolean {
  return recent.some(
    (e) =>
      e.step === 'ice' &&
      e.level === 'ok' &&
      (/: connected$/.test(e.message) || /: completed$/.test(e.message))
  );
}

function hasRelayCandidate(recent: CastEvent[]): boolean {
  return recent.some((e) => e.message.includes('relay'));
}

/** 排查清单：根据最近事件给出可能原因 */
export function castDiagnosisHint(): string | null {
  const recent = events.slice(-20);
  const has = (step: CastStep, substr?: string) =>
    recent.some(
      (e) =>
        e.step === step &&
        (substr ? e.message.includes(substr) : true) &&
        e.level !== 'err'
    );
  const err = (step: CastStep) => recent.find((e) => e.step === step && e.level === 'err');

  if (err('preview')) return '手机本地预览失败：检查摄像头权限与 startPublishing 日志';
  if (!has('publish_started')) return '未收到 publish_started：检查信令连接与服务器 [cast] 日志';
  if (has('publish_started') && !has('subscribe')) return '未发 subscribe：检查 applyPublisherSync / webrtc 是否就绪';
  if (has('subscribe', '已发送') && !has('offer')) return '手机未发 offer：检查 localVideoTrack 与 subscribe 是否到达手机';
  if (has('offer') && !has('answer')) return 'answer 未发出：检查 SDP 协商与 transceiver 方向';

  const waitingIce = recent.find(
    (e) => e.step === 'ontrack' && e.level === 'warn' && e.message.includes('等待 ICE')
  );
  const iceOk = iceIsConnected(recent);

  if (waitingIce && !iceOk) {
    if (has('ice', 'relay-only') || has('ice', '无 TURN')) {
      return '已切换 relay-only 但仍未连通：请在 124.220.4.69 启动 coturn 并放行 UDP 3478';
    }
    if (!hasRelayCandidate(recent)) {
      return 'ICE 未连通且无 relay 候选：请启动 coturn（scripts/enable-coturn.sh）';
    }
    return 'SDP 已协商但 ICE 未连通：检查 NAT/防火墙，建议同一 WiFi';
  }

  const iceWarn = recent.find(
    (e) => e.step === 'ice' && e.message.includes('checking') && e.level === 'warn'
  );
  if (iceWarn && !iceOk) return 'ICE 长时间 checking：检查 STUN/TURN，建议启动 coturn';

  const hasReadyTrack = recent.some(
    (e) => e.step === 'ontrack' && e.level === 'ok' && e.message.includes('画面就绪')
  );

  if (iceOk && !has('ontrack')) return 'ICE 已连通但无 ontrack：检查手机是否推流';
  if (iceOk && !hasReadyTrack) return 'ICE 已连通，等待画面就绪（若持续无画面请检查手机摄像头推流）';
  return null;
}
