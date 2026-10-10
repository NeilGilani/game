'use client';

import { useEffect, useRef, useState } from 'react';
import type { FusionMode, NetworkSnapshot } from './network-status';

export type WeightFrame = {
  event: string; request_id?: number; weights: Record<string, number>;
  evidence: Record<string, string[]>; active_experts: string[];
  excluded?: Record<string, string>; message?: string;
  intent_weights?: Record<string, number>; ideal_weights?: Record<string, number>; network_cap?: number; network?: NetworkSnapshot; fusion_mode?: FusionMode;
};

export function useWeightStream(payload: string | null, onFrame: (frame: WeightFrame) => void) {
  const [status, setStatus] = useState('connecting');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState('');
  const callback = useRef(onFrame);
  const latest = useRef(payload);
  const socket = useRef<WebSocket | null>(null);
  const sequence = useRef(0);
  callback.current = onFrame;
  latest.current = payload;

  function send() {
    if (socket.current?.readyState === WebSocket.OPEN && latest.current) {
      socket.current.send(JSON.stringify({ ...JSON.parse(latest.current), request_id: ++sequence.current }));
    }
  }

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout>;
    let responseTimeout: ReturnType<typeof setTimeout>;
    let attempts = 0;
    function connect() {
      if (disposed) return;
      // Next's external rewrite forwards WebSocket upgrades to the local kernel.
      const url = process.env.NEXT_PUBLIC_SYNAPSE_WS_URL ||
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/kernel/ws/weights`;
      const ws = new WebSocket(url);
      socket.current = ws;
      responseTimeout = setTimeout(() => {
        if (!disposed) { setStatus('reconnecting'); ws.close(); }
      }, 8000);
      ws.onopen = () => { attempts = 0; setStatus('awaiting weights'); send(); };
      ws.onmessage = event => {
        try {
          const frame: WeightFrame = JSON.parse(event.data);
          if (frame.request_id !== sequence.current || !latest.current) return;
          if (frame.event === 'weights') { clearTimeout(responseTimeout); setError(''); setStatus('live'); setUpdatedAt(Date.now()); callback.current(frame); }
          if (frame.event === 'error') { setStatus('rejected'); setError(frame.message || 'The Sifter rejected the weight request.'); }
        } catch { setStatus('invalid frame'); }
      };
      ws.onerror = () => { if (!disposed) setStatus('reconnecting'); };
      ws.onclose = () => {
        clearTimeout(responseTimeout);
        if (disposed) return;
        setStatus('reconnecting');
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10000));
      };
    }
    connect();
    return () => { disposed = true; clearTimeout(retry); clearTimeout(responseTimeout); socket.current?.close(); };
  }, []);

  useEffect(() => {
    // Invalidate an in-flight response immediately, before the debounce fires.
    ++sequence.current;
    setError('');
    const debounce = setTimeout(send, 150);
    return () => clearTimeout(debounce);
  }, [payload]);
  return { status, updatedAt, error };
}
