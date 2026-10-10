'use client';

import { useEffect, useState } from 'react';
import type { CloudSnapshot } from './cloud-telemetry';

export function useCloudStatus() {
  const [snapshot, setSnapshot] = useState<CloudSnapshot | null>(null);
  useEffect(() => {
    let disposed = false;
    let request: AbortController | null = null;
    async function poll() {
      if (request) return;
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetch('/api/cloud-status', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]) });
        if (!response.ok) throw new Error('Cloud status unavailable');
        const data: CloudSnapshot = await response.json();
        if (!disposed) setSnapshot(data);
      } catch {
        if (!disposed) setSnapshot({ state: 'unreachable', cluster: 'Outshift cluster', health_rtt_ms: null, sampled_at: Date.now(), detail: 'Cloud status unavailable; retrying' });
      } finally { request = null; }
    }
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    window.addEventListener('online', poll);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('online', poll); request?.abort(); };
  }, []);
  return snapshot;
}

export default function CloudStatus({ snapshot }: { snapshot: CloudSnapshot | null }) {
  const state = snapshot?.state || 'checking';
  return <section className={`cloud-status cloud-${state}`} aria-label="Cloud Status">
    <div><div className="eyebrow">DISTRIBUTED ARCHITECTURE / CLOUD TO EDGE</div><h2>Cloud Status <span className="cloud-state" role="status"><i />{state === 'connected' ? 'Connected' : state === 'unreachable' ? 'Disconnected' : state === 'unconfigured' ? 'Not configured' : 'Checking'}</span></h2><p>{snapshot?.cluster || 'Outshift cluster'} · Edge laptop ⇄ Cloud server</p></div>
    <div className="cloud-rtt"><span>CLOUD HEALTH ROUND TRIP</span><strong>{snapshot?.health_rtt_ms !== null && snapshot?.health_rtt_ms !== undefined ? `${snapshot.health_rtt_ms.toFixed(1)} ms` : '—'}</strong><small>{snapshot?.detail || 'Waiting for a cluster health response'}</small></div>
  </section>;
}
