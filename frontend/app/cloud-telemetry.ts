export type CloudSnapshot = {
  state: 'connected' | 'unreachable' | 'unconfigured';
  cluster: string;
  health_rtt_ms: number | null;
  sampled_at: number;
  detail: string;
};

// Emitted by the distributed comparison backend, not inferred from elapsed time.
export type ExecutionTelemetry = {
  location: 'edge' | 'cloud';
  cluster?: string;
  network_latency_ms?: number;
  latency_kind?: string;
};

export function measuredLatency(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
