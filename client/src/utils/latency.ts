import { LATENCY_GOOD_MS, LATENCY_WARN_MS } from '../config';

export type LatencyLevel = 'latency-good' | 'latency-warn' | 'latency-bad';

export function getLatencyLevel(ms: number): LatencyLevel {
  if (ms < LATENCY_GOOD_MS) return 'latency-good';
  if (ms <= LATENCY_WARN_MS) return 'latency-warn';
  return 'latency-bad';
}
