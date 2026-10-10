import type { CloudSnapshot } from './cloud-telemetry';

export async function probeCloud(): Promise<CloudSnapshot> {
  const snapshot: CloudSnapshot = { state: 'unconfigured', cluster: 'Outshift cluster', health_rtt_ms: null, sampled_at: Date.now(), detail: 'Outshift endpoint not configured' };
  const base = process.env.SYNAPSE_CLOUD_API_URL;
  if (!base) return snapshot;
  try {
    const endpoint = new URL(base.endsWith('/') ? base : base + '/');
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Invalid protocol');
    const health = new URL((process.env.SYNAPSE_CLOUD_HEALTH_PATH || 'health').replace(/^\//, ''), endpoint);
    const started = performance.now();
    const response = await fetch(health, { cache: 'no-store', signal: AbortSignal.timeout(4000), headers: cloudHeaders(), redirect: 'error' });
    await response.arrayBuffer();
    snapshot.sampled_at = Date.now();
    if (response.status !== 200) return { ...snapshot, state: 'unreachable', detail: `Outshift health check returned HTTP ${response.status}` };
    return { ...snapshot, state: 'connected', health_rtt_ms: Number((performance.now() - started).toFixed(1)), detail: 'Measured edge gateway ⇄ cluster health round trip, including health response handling' };
  } catch {
    return { ...snapshot, sampled_at: Date.now(), state: 'unreachable', detail: 'Outshift health check failed or timed out' };
  }
}

export function cloudHeaders(): Record<string, string> {
  return { Accept: 'application/json' };
}
