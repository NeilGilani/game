'use client';

import { useEffect, useRef, useState } from 'react';

export type NetworkSnapshot = { state: 'OPTIMAL' | 'CONGESTED' | 'CRITICAL' | 'OFFLINE'; network_cap: number; source: 'mock' | 'restconf'; revision: number; utilization: number | null; latency_ms: number | null; sampled_at: number; detail: string; latency_kind: string };
export type FusionMode = 'Ultra-Fusion' | 'Lean-Fusion' | 'Critical-Fusion' | 'Safe-Mode';

export default function NetworkStatus({ network, mode, busy, onUpdate }: { network: NetworkSnapshot | null; mode: FusionMode; busy: boolean; onUpdate: (network: NetworkSnapshot) => void }) {
  const callback = useRef(onUpdate);
  callback.current = onUpdate;
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    let disposed = false;
    let request: AbortController | null = null;
    async function poll() {
      if (request) return;
      const controller = new AbortController();
      request = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('/kernel/network', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Network telemetry API unavailable');
        const snapshot: NetworkSnapshot = await response.json();
        if (!disposed) { callback.current(snapshot); setError(''); }
      } catch { if (!disposed) setError('Network telemetry API unavailable; reconnecting…'); }
      finally { clearTimeout(timeout); request = null; }
    }
    void poll();
    const interval = setInterval(() => void poll(), 2000);
    return () => { disposed = true; clearInterval(interval); request?.abort(); };
  }, []);

  async function simulate(state: NetworkSnapshot['state']) {
    setChanging(true);
    try {
      const response = await fetch('/kernel/network/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }) });
      if (!response.ok) throw new Error('Could not change demo network state');
      callback.current(await response.json()); setError('');
    } catch (error) { setError(error instanceof Error ? error.message : 'Network control failed'); }
    finally { setChanging(false); }
  }

  return <section className={`network-panel network-${network?.state.toLowerCase() || 'unknown'}`} aria-label="Cisco network telemetry">
    <div><div className="eyebrow">SENSE → REASON → FUSE</div><h2><i />Cisco Network <strong className="network-state">{error ? 'UNAVAILABLE' : network?.state || 'CHECKING'}</strong></h2><p>{network?.source === 'mock' ? 'MOCK TELEMETRY · manual demo controls' : 'IOS XE · RESTCONF TELEMETRY'}</p></div>
    <div className="network-metrics"><span>LINK UTILIZATION<strong>{network?.utilization !== null && network?.utilization !== undefined ? `${(network.utilization * 100).toFixed(1)}%` : '—'}</strong></span><span title={network?.latency_kind}>MANAGEMENT LATENCY<strong>{network?.latency_ms !== null && network?.latency_ms !== undefined ? `${network.latency_ms.toFixed(0)} ms` : '—'}</strong></span><span>NETWORK CAP<strong className="network-cap">{network?.network_cap.toFixed(2) || '—'}</strong></span><span>APPLIED POLICY<strong className="fusion-mode">{mode}</strong></span></div>
    {network?.source === 'mock' && <div className="network-controls" aria-label="Demo network controls">{(['OPTIMAL', 'CONGESTED', 'CRITICAL', 'OFFLINE'] as const).map(state => <button key={state} aria-pressed={network.state === state} disabled={changing} onClick={() => void simulate(state)}>{state === 'OPTIMAL' ? 'Restore network' : state === 'CONGESTED' ? 'Trigger congestion' : state === 'CRITICAL' ? 'Trigger critical' : 'Disconnect network'}</button>)}</div>}
    <p className="network-detail">{error || network?.detail}{busy ? ' · Changes apply before the next token forward pass.' : ' · The network sets the budget; the Sifter allocates it per token.'}</p>
  </section>;
}
