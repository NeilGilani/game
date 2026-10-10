'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import CloudLibrary from './cloud-library';
import FusionCore, { expertColors } from './fusion-core';
import { useWeightStream } from './use-weight-stream';
import type { CSSProperties } from 'react';
import { defaultPrompt } from './demo-prompt';
import CloudStatus, { useCloudStatus } from './cloud-status';
import { measuredLatency, type ExecutionTelemetry } from './cloud-telemetry';
import NetworkStatus, { type NetworkSnapshot, type FusionMode } from './network-status';
import FusionBudget, { type TokenBudget } from './fusion-budget';

type Expert = string;
type Weights = Record<Expert, number>;
export type Health = { status: string; device: string; base_model: string; network?: NetworkSnapshot; safe_mode_ready?: boolean; vault: { name: Expert; label: string; source: string; repo_id?: string; expertise?: string; reserved_for_safe_mode?: boolean; available: boolean; loaded: boolean; missing_files?: string[]; metadata: { rank: number; steps?: number } | null }[] };
export type Intent = { weights: Weights; ideal_weights?: Weights; network_cap?: number; intent_weights?: Weights; evidence: Partial<Record<Expert, string[]>>; active_experts: Expert[]; excluded?: Record<string, string>; network?: NetworkSnapshot; fusion_mode?: FusionMode };
type Proof = { id: string; prompt: string; rubric: string[]; domains: string[] };
type Output = { execution?: ExecutionTelemetry; measurement?: string; text: string; tokens: number; generation_ms: number; total_ms?: number; tokens_per_second?: number; ready_after_ms?: number };
type Timing = { baseline_total_ms: number; fused_total_ms: number; intent_ms: number; fusion_ms: number; restore_ms: number; shared_setup_ms: number; queue_wait_ms: number; comparison_wall_ms: number; timing_note: string };
type Audit = { weights: Weights; ideal_weights?: Weights; network_cap?: number; token_index?: number; fusion_mode?: FusionMode; network?: NetworkSnapshot; compute_dtype: string; base_dtype: string; loaded_adapters: string[]; peak_workspace_bytes: number; device: string; fusion_ms: number; layer_count: number; snapshot_bytes: number; matrix_sample?: {module: string; base: number[][]; fused: number[][]; contributions: Partial<Record<Expert, number[][]>> }; layers: { module: string; shape: number[]; delta_norms: Partial<Weights> }[] };
const defaultExperts: Expert[] = ['coding', 'medical', 'legal'];
const defaultLabels: Record<string, string> = { coding: 'Code', medical: 'Clinical', legal: 'Legal' };
export default function Home({ initialHealth, initialIntent, initialHealthError, initialIntentError, kernelLocation }: { initialHealth: Health | null; initialIntent: Intent | null; initialHealthError: string; initialIntentError: string; kernelLocation: 'edge' | 'cloud' }) {
  const cloud = useCloudStatus();
  const [runProbeRtt, setRunProbeRtt] = useState<number | null>(null);
  const [runExecution, setRunExecution] = useState<ExecutionTelemetry | null>(null);
  const [experts, setExperts] = useState<Expert[]>(initialIntent?.active_experts || defaultExperts);
  const [health, setHealth] = useState<Health | null>(initialHealth);
  const [healthError, setHealthError] = useState(initialHealthError);
  const healthRequest = useRef<AbortController | null>(null);
  const [proof, setProof] = useState<Proof[]>([]);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [weights, setWeights] = useState<Weights>(initialIntent?.weights || {});
  const [weightError, setWeightError] = useState(initialIntentError);
  const [weightUpdatedAt, setWeightUpdatedAt] = useState<number | null>(initialIntent ? 0 : null);
  const [evidence, setEvidence] = useState<Partial<Record<Expert, string[]>>>(initialIntent?.evidence || {});
  const [manual, setManual] = useState(false);
  const [manualExperts, setManualExperts] = useState<Expert[]>(defaultExperts);
  const [manualWeights, setManualWeights] = useState<Weights>({});
  const [intentWeights, setIntentWeights] = useState<Weights>(initialIntent?.intent_weights || initialIntent?.weights || {});
  const [idealWeights, setIdealWeights] = useState<Weights>(initialIntent?.ideal_weights || initialIntent?.intent_weights || initialIntent?.weights || {});
  const [networkCap, setNetworkCap] = useState(initialIntent?.network_cap ?? 1);
  const [tokenStep, setTokenStep] = useState<TokenBudget | null>(null);
  const [tokenHistory, setTokenHistory] = useState<TokenBudget[]>([]);
  const [network, setNetwork] = useState<NetworkSnapshot | null>(initialIntent?.network || initialHealth?.network || null);
  const [fusionMode, setFusionMode] = useState<FusionMode>(initialIntent?.fusion_mode || 'Ultra-Fusion');
  const [vaultVersion, setVaultVersion] = useState(0);
  const [excluded, setExcluded] = useState<Record<string, string>>(initialIntent?.excluded || {});
  const [timing, setTiming] = useState<Timing | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const requestStarted = useRef(0);

  const [phase, setPhase] = useState('Ready to fuse');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setElapsed((performance.now() - requestStarted.current) / 1000), 100);
    return () => clearInterval(timer);
  }, [busy]);
  const [baseline, setBaseline] = useState<Output | null>(null);
  const [fused, setFused] = useState<Output | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [error, setError] = useState('');
  const [tokens, setTokens] = useState(64);
  const [selectedCase, setSelectedCase] = useState('health-audit');
  const [restored, setRestored] = useState(false);

  const weightPayload = busy || !prompt.trim() ? null : JSON.stringify({ prompt, vault_version: vaultVersion, network_version: network?.revision, ...(manual ? { experts: manualExperts, weights: manualWeights } : {}) });
  const stream = useWeightStream(weightPayload, frame => {
    setTokenStep(null); // This is a prompt preview; the completed ledger stays.
    setWeights(frame.weights); setEvidence(frame.evidence); setExperts(manual && frame.fusion_mode === 'Ultra-Fusion' ? manualExperts : frame.active_experts); setExcluded(frame.excluded || {}); setWeightError(''); setWeightUpdatedAt(Date.now());
    if (frame.intent_weights && Object.keys(frame.intent_weights).length) setIntentWeights(frame.intent_weights);
    if (frame.ideal_weights) setIdealWeights(frame.ideal_weights);
    if (frame.network_cap !== undefined) setNetworkCap(frame.network_cap);
    if (frame.network) setNetwork(frame.network);
    if (frame.fusion_mode) setFusionMode(frame.fusion_mode);
  });

  const labels: Record<string, string> = { ...defaultLabels, ...Object.fromEntries((health?.vault || []).map(v => [v.name, v.label])) };

  const refresh = useCallback(async () => {
    if (healthRequest.current) return;
    const controller = new AbortController();
    healthRequest.current = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/kernel/health', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Kernel health check failed (${response.status}).`);
      const data: Health = await response.json();
      // A cold kernel is reachable and loads the base model on the first run.
      if (!['ready', 'cold'].includes(data.status)) throw new Error('Kernel is not ready yet.');
      setHealth(data);
      if (data.network) setNetwork(data.network);
      setHealthError('');
    } catch {
      if (healthRequest.current !== controller) return;
      setHealth(null);
      setHealthError('Cannot reach the Python kernel through /kernel/health. Retrying automatically every 5 seconds.');
    } finally {
      clearTimeout(timeout);
      if (healthRequest.current === controller) healthRequest.current = null;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const reconnect = () => void refresh();
    window.addEventListener('online', reconnect);
    window.addEventListener('focus', reconnect);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('focus', reconnect);
      const request = healthRequest.current;
      healthRequest.current = null;
      request?.abort();
    };
  }, [refresh]);
  const connected = health !== null;
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    fetch('/kernel/proof', { signal: controller.signal }).then(r => r.ok ? r.json() : []).then(setProof).catch(() => {});
    return () => controller.abort();
  }, [connected]);
  useEffect(() => {
    if (stream.status === 'live' || busy || !prompt.trim()) return;
    const controller = new AbortController();
    setWeightError('');
    const timer = setTimeout(async () => {
      try {
        const r = await fetch('/kernel/intent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, ...(manual ? { experts: manualExperts, weights: manualWeights } : {}) }), signal: controller.signal });
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || `Sifter request failed (${r.status}).`);
        if (!controller.signal.aborted) { setTokenStep(null); setWeights(data.weights); setEvidence(data.evidence); setExperts(manual && data.fusion_mode === 'Ultra-Fusion' ? manualExperts : data.active_experts); setExcluded(data.excluded || {}); setWeightError(''); setWeightUpdatedAt(Date.now()); if (data.intent_weights && Object.keys(data.intent_weights).length) setIntentWeights(data.intent_weights); if (data.network) setNetwork(data.network); if (data.fusion_mode) setFusionMode(data.fusion_mode); if (data.ideal_weights) setIdealWeights(data.ideal_weights); if (data.network_cap !== undefined) setNetworkCap(data.network_cap); }
      } catch (e) {
        if (!controller.signal.aborted) setWeightError(e instanceof Error ? e.message : 'Could not update intent weights.');
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [prompt, manual, manualExperts, manualWeights, busy, vaultVersion, stream.status, network?.revision]);

  function toggleManual(enabled: boolean) {
    resetRun(); setWeightError(''); setManual(enabled);
    if (!enabled) return;
    // Keep zero-weight experts selectable, including when routing is unavailable.
    const available = health?.vault.filter(v => v.available && !v.reserved_for_safe_mode).map(v => v.name) || defaultExperts;
    const next = [...new Set([...experts.filter(e => available.includes(e)), ...available.filter(e => defaultExperts.includes(e))])].slice(0, 8);
    for (const name of available) if (next.length < 2 && !next.includes(name)) next.push(name);
    const total = next.reduce((sum, e) => sum + (intentWeights[e] || 0), 0);
    const mixture = Object.fromEntries(next.map(e => [e, total > 0 ? (intentWeights[e] || 0) / total : 1 / next.length]));
    setManualExperts(next); setManualWeights(mixture); setIdealWeights(mixture);
    if (network?.state === 'OPTIMAL') { setExperts(next); setWeights(mixture); }
    setWeightUpdatedAt(Date.now());
  }

  function adjust(expert: Expert, value: number) {
    resetRun();
    const others = manualExperts.filter(e => e !== expert);
    const remainder = 1-value;
    const old = others.reduce((sum, e) => sum+(manualWeights[e] || 0), 0);
    const mixture = Object.fromEntries(manualExperts.map(e => [e, e === expert ? value : old ? remainder * (manualWeights[e] || 0) / old : remainder / others.length]));
    setManualWeights(mixture); setWeights(mixture); setIdealWeights(mixture);
    setWeightUpdatedAt(Date.now());

  }

  function resetRun() {
    setRunProbeRtt(null); setRunExecution(null); setBaseline(null); setFused(null); setAudit(null); setTiming(null); setElapsed(0); setRestored(false); setPhase('Ready to fuse'); setTokenStep(null); setTokenHistory([]);
  }

  async function run() {
    requestStarted.current = performance.now(); setElapsed(0); setTiming(null);
    setRunProbeRtt(null); setRunExecution(null); setBusy(true); setError(''); setBaseline(null); setFused(null); setAudit(null); setRestored(false); setTokenStep(null); setTokenHistory([]);
    setPhase('Classifying prompt');
    try {
      const r = await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, max_new_tokens: tokens, ...(manual ? { experts: manualExperts, weights: manualWeights } : {}) }) });
      if (!r.ok || !r.body) throw new Error(`Kernel request failed (${r.status}).`);
      const reader = r.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let completed = false;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.event === 'cloud_probe') setRunProbeRtt(measuredLatency(event.health_rtt_ms));
          if (event.execution && (event.execution.location === 'cloud' || event.execution.location === 'edge')) setRunExecution(event.execution);
          if (event.event === 'error') throw new Error(event.message);
          if (event.event === 'network') { setNetwork(event.network); setFusionMode(event.fusion_mode); setPhase('Network sensed'); }
          if (event.event === 'intent') { if (event.ideal_weights) setIdealWeights(event.ideal_weights); if (event.network_cap !== undefined) setNetworkCap(event.network_cap); setWeights(event.weights); setEvidence(event.evidence); setExperts(manual && event.fusion_mode === 'Ultra-Fusion' ? manualExperts : event.active_experts); setExcluded(event.excluded || {}); setPhase(`${event.fusion_mode || 'Intent mapped'} · coefficients ready`); }
          if (event.event === 'loading') setPhase(event.base_cold ? 'Loading base, then running baseline' : 'Running standard model');
          if (event.event === 'baseline') { setBaseline(event); setPhase('Fusing matrices'); }
          if (event.event === 'fusion') { setAudit(event); setPhase('Generating with fused weights'); }
          if (event.event === 'token_fusion') {
            setTokenStep(event); setTokenHistory(previous => [...previous, event]);
            setWeights(event.weights); setIdealWeights(event.ideal_weights); setNetworkCap(event.network_cap);
            if (event.evidence) setEvidence(event.evidence);
            setExperts(event.active_experts); setExcluded(event.excluded || {});
            setNetwork(event.network); setFusionMode(event.fusion_mode); setWeightUpdatedAt(Date.now());
            setPhase(`Token ${event.token_index + 1} · ${event.fusion_mode}`);
          }
          if (event.event === 'token') setFused(event);
          if (event.event === 'cloud_status') {
            setPhase(`Cloud reconnect ${event.attempt} · ${event.fusion_mode}`);
            setFusionMode(event.fusion_mode); setWeights(event.weights); setNetworkCap(event.network_cap);
          }
          if (event.event === 'fused') { setFused(event); if (event.final_audit) setAudit(event.final_audit); }
          if (event.event === 'complete') {
            const total = event.timing?.comparison_wall_ms ?? event.edge_total_ms;
            setPhase('Comparison complete'); setRestored(event.base_restored === true); setTiming(event.timing || null);
            setFused(previous => previous ? { ...previous, total_ms: event.timing?.fused_total_ms ?? total, ready_after_ms: total } : previous);
            if (typeof total === 'number') setElapsed(total / 1000);
            completed = true;
          }
        }
        if (done) break;
      }
      if (!completed) throw new Error('The stream ended before the kernel confirmed completion.');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Fusion failed.'); setPhase('Run interrupted'); }
    finally { setBusy(false); }
  }

  const ready = health && Object.values(weights).some(w => w > 0) && !weightError && !stream.error && weightUpdatedAt !== null && experts.every(e => health.vault.some(v => v.name === e && v.available));
  function selectExpert(name: string, checked: boolean) {
    const next = checked ? [...manualExperts, name] : manualExperts.filter(e => e !== name);
    if (next.length < 2 || next.length > 8) { setError('Select 2–8 experts for a fusion.'); return; }
    resetRun(); setError(''); setExperts(next); setManualExperts(next); setManual(true);
    const mixture = Object.fromEntries(next.map(e => [e, 1 / next.length]));
    setWeights(mixture); setManualWeights(mixture); setIdealWeights(mixture);
  }
  const chosen = proof.find(p => p.id === selectedCase);
  const previewVerified = audit && audit.fusion_mode === fusionMode && Object.keys({ ...weights, ...audit.weights }).every(name => Math.abs((weights[name] || 0) - (audit.weights[name] || 0)) < 1e-6);
  const cells = previewVerified ? audit.matrix_sample?.fused.flat() : undefined;
  const auditedExperts = audit ? Object.entries(audit.weights).filter(([, weight]) => weight > 0).map(([name]) => name) : experts;
  const execution = fused?.execution || runExecution;
  const backendNetworkLatency = measuredLatency(execution?.network_latency_ms);
  const runNetworkLatency = backendNetworkLatency ?? runProbeRtt;
  const isCloudOutput = execution?.location === 'cloud';
  return <main>
    <header><a className="brand" href="/" aria-label="Synapse Mesh home"><span className="brand-icon">✳</span> SYNAPSE<span className="brand-mesh">MESH</span><span className="tag">GOD VIEW</span></a><div className="connection"><i className={cloud?.state === 'connected' ? 'online' : ''} /><span role="status">{cloud?.state === 'connected' ? 'ONLINE · OUTSHIFT CLUSTER' : cloud?.state === 'unreachable' ? 'CLOUD OFFLINE' : 'CONNECTING TO KERNEL'}</span><small className="kernel-status">{health ? `${health.device.toUpperCase()} · ${kernelLocation === "cloud" ? "REMOTE KERNEL" : "LOCAL KERNEL"}` : healthError ? "KERNEL OFFLINE" : "Checking compute"}</small><button className="refresh" onClick={refresh} aria-label="Refresh kernel status">↻</button></div></header>
    <section className="intro"><div><div className="eyebrow">SYNAPSE CONTROL / LIVE INTELLIGENCE</div><h1>Neural Fusion<br /><span>Dashboard.</span></h1><p>From your laptop to the Outshift cluster and back.<br className="desktop" /> Follow the packets. Inspect the fusion.</p></div><div className="model-label"><span>BASE MODEL</span><strong>{health?.base_model.split('/')[1] || 'Qwen2.5-1.5B-Instruct'}</strong><small>Same prompt · greedy decoding · real LoRA deltas</small></div></section>
    <CloudStatus snapshot={cloud} />
    <NetworkStatus network={network} mode={fusionMode} busy={busy} onUpdate={setNetwork} />
    {(error || healthError) && <div className="error" role="alert">{error || healthError}</div>}
    {!manual && (weightError || stream.error) && <div className="error" role="alert">{weightError || stream.error} Enable manual weights to choose the mixture.</div>}
    <div className="telemetry-strip grid grid-cols-2 gap-4 md:grid-cols-4"><div><span>WEIGHT STREAM</span><strong className={stream.status === "live" ? "text-emerald-300" : "text-amber-200"}>{stream.status === "live" ? "● WebSocket live" : manual ? "○ Local preview" : weightUpdatedAt !== null ? "○ Kernel weights loaded · connecting stream" : "○ HTTP fallback · " + stream.status}</strong></div><div><span>ACTIVE ADAPTERS</span><strong>{Object.values(weights).filter(w => w > 0).length} <small>/ {health?.vault.length || 3} installed</small></strong></div><div><span>VECTOR TOTAL</span><strong>{Object.values(weights).reduce((a, b) => a + b, 0).toFixed(3)} <small>applied / {networkCap.toFixed(2)} cap</small></strong></div><div><span>LAST VECTOR</span><strong>{weightUpdatedAt === 0 ? "Loaded from kernel" : weightUpdatedAt ? new Date(weightUpdatedAt).toLocaleTimeString() : "Awaiting Sifter"}</strong></div></div>
    <div className="workspace">
      <aside><div className="section-title"><span>01 / FUSION VAULT</span><small>{health?.vault.length || 3} INSTALLED</small></div><h2>Adapter mesh</h2><p className="subtle">{Object.values(weights).filter(w => w > 0).length} contributing · {manual ? 'manual mixture' : 'automatic intent weights'}.</p>
        <div className="vault-cards">{(health?.vault || defaultExperts.map(name => ({ name, label: defaultLabels[name], source: 'local', available: false, loaded: false, metadata: null, repo_id: '', expertise: '', reserved_for_safe_mode: false }))).map((v, i) => <div className={`expert-card ${v.name} ${(weights[v.name] || 0) > 0 ? "adapter-active" : "adapter-idle"}`} style={{ "--adapter-color": expertColors[i % expertColors.length], "--adapter-glow": (weights[v.name] || 0) * .2 } as CSSProperties} key={v.name}><div className="expert-top"><span className="expert-symbol">{['⌘','✚','§'][i] || '✳'}</span><input type="checkbox" aria-label={`Include ${v.label} in fusion`} checked={experts.includes(v.name)} disabled={busy || !v.available || !manual || v.reserved_for_safe_mode || network?.state !== 'OPTIMAL'} onChange={e => selectExpert(v.name, e.target.checked)} /></div><h3 title={v.label}>{v.label}</h3><div className={experts.includes(v.name) ? 'expert-relevance participating' : 'expert-relevance'}>{experts.includes(v.name) ? `${((weights[v.name] || 0) * 100).toFixed(1)}% contribution` : excluded[v.name] || 'Not participating'}</div><div className="adapter-weight-track"><span style={{ width: `${(weights[v.name] || 0) * 100}%` }} /></div><p>{v.expertise || ({ coding: 'Logic, implementation & software systems', medical: 'Clinical context & human review', legal: 'License scope, privacy & obligations' } as Record<string, string>)[v.name]}</p><div className="expert-bottom"><span><i className={v.available ? 'online' : ''} />{!health ? 'CHECKING FILES' : !v.available ? 'FILES MISSING' : v.loaded ? 'FACTORS CACHED' : v.source === 'huggingface' ? 'CLOUD / ON DISK' : 'LOCAL / ON DISK'}</span><small>{!health ? (healthError ? 'Kernel offline' : 'Checking adapters…') : !v.available ? 'Missing adapter files' : v.metadata?.rank ? `r${v.metadata.rank}${v.metadata.steps ? ` / ${v.metadata.steps} steps` : ''}` : 'Adapter ready'}</small></div></div>)}</div>
        <div className="vault-note">Ultra-Fusion spends up to 1.0. Lean-Fusion keeps the mixture within 0.4. Critical-Fusion spends 0.1 on the strongest expert. Offline Safe-Mode spends 0.1 on the cached generalist. Manual mixtures remain subject to network policy. Factor pairs load only when their coefficient is nonzero.</div>
      </aside>
      <div className="lab"><section className="prompt-panel"><div className="section-title"><span>02 / PROMPT INTENT</span><small>CROSS-DOMAIN INPUT</small></div><label className="prompt-label" htmlFor="prompt">Give the model a problem that crosses disciplines.</label><textarea id="prompt" value={prompt} maxLength={8000} disabled={busy} onChange={e => { resetRun(); setPrompt(e.target.value); setSelectedCase(''); }} /><div className="prompt-footer"><span>{prompt.length} / 8000</span><label>Proof prompt <select aria-label="Choose a proof prompt" value={selectedCase} disabled={busy} onChange={e => { const p = proof.find(p => p.id === e.target.value); if(p) { resetRun(); setPrompt(p.prompt); setSelectedCase(p.id); } }}><option value="">Custom prompt</option>{proof.map(p => <option key={p.id} value={p.id}>{p.id.replaceAll('-', ' ')}</option>)}</select></label></div></section>
      <section className="fusion-panel"><div className="section-title"><span>03 / FUSION MATRIX</span><label className="manual"><input type="checkbox" checked={manual} disabled={busy} onChange={e => toggleManual(e.target.checked)} />Manual weights</label></div>
        <FusionBudget ideal={idealWeights} actual={weights} cap={networkCap} mode={fusionMode} labels={labels} step={tokenStep} history={tokenHistory} />
        <FusionCore weights={weights} labels={labels} names={(health?.vault || defaultExperts.map(name => ({ name }))).map(v => v.name)} busy={busy} cells={cells} layers={previewVerified ? audit.layer_count : undefined} cloudConnected={cloud?.state === 'connected'} cloudRttMs={cloud?.health_rtt_ms} cloudExecution={isCloudOutput} />
        <div className="formula"><span>W<sub>final</sub></span> = W<sub>base</sub>{experts.map(e => <span key={e} className={e}> + {(weights[e] || 0).toFixed(2)} ΔW<sub>{labels[e]}</sub></span>)}</div>
        <p className="subtle" aria-live="polite">{manual ? 'Sliders update the mixture immediately. Click Fuse & compare to generate output with these weights.' : weightUpdatedAt ? 'The Sifter re-evaluates the generated prefix before every token. Network controls remain live during generation.' : 'Waiting for intent weights from the Sifter…'}</p>
        <div className="weight-controls">{experts.map(e => <label key={e} className={e}><span>{labels[e]} <small title={(evidence[e] || []).join(', ')}>{manual ? 'manual' : `${(evidence[e] || []).length} signals`}</small></span><input type="range" aria-label={`${labels[e]} weight`} min="0" max="1" step="any" title={`Exact coefficient: ${weights[e] || 0}`} value={weights[e] || 0} disabled={!manual || busy || network?.state !== 'OPTIMAL'} onChange={ev => adjust(e, Number(ev.target.value))} /></label>)}</div>
        <div className="run-bar"><div className="phase" aria-live="polite"><i className={busy ? 'pulse' : audit ? 'online' : ''} />{phase}{(busy || timing) && <span className="elapsed">{elapsed.toFixed(1)} s elapsed</span>}<small>{audit ? `${audit.fusion_ms.toFixed(1)} ms last fusion update · ${audit.compute_dtype.toUpperCase()} · ${audit.device}` : 'ΔW = scale × (B @ A) · no disk merge'}</small></div><select aria-label="Generation token limit" value={tokens} disabled={busy} onChange={e => setTokens(Number(e.target.value))}><option value={16}>16 tokens</option><option value={32}>32 tokens</option><option value={64}>64 tokens</option><option value={128}>128 tokens</option><option value={256}>256 tokens</option><option value={512}>512 tokens</option></select><button className="run" disabled={busy || !ready || !prompt.trim()} onClick={run}>{busy ? 'Fusion in progress…' : 'Fuse & compare'}<span>↗</span></button></div>
      </section></div>
    </div>
    <section className="comparison"><p className="comparison-note">Baseline runs first, then network-constrained tensor fusion before each token. This is a quality comparison; fusion adds work and is not promised to be faster.</p><div className="comparison-heading"><div><div className="section-title">04 / OBSERVE THE DIFFERENCE</div><h2>Same question. Different weights.</h2></div><span className="status-tag">{restored ? '✓ BASE WEIGHTS RESTORED' : 'CONTROLLED COMPARISON'}</span></div><div className="output-grid">{[{name:'Standard AI',caption:'BASE CHECKPOINT / ADAPTERS DISABLED',output:baseline},{name:'Fused AI',caption:`BASE CHECKPOINT + WEIGHTED LORA DELTAS · ${audit?.fusion_mode || fusionMode}`,output:fused}].map((item,i)=><article className={`output ${i ? 'mesh-output' : ''}`} key={item.name}><div className="output-title"><h3>{item.name}</h3><span>{i ? isCloudOutput ? 'Cloud-Accelerated' : item.output ? execution?.location === 'edge' ? 'EDGE / LOCAL FALLBACK' : 'EXECUTION UNVERIFIED' : 'Cloud-Accelerated · awaiting run' : 'BASELINE'}</span></div><small>{item.caption}</small>{i === 1 && <div className="comparison-network"><span>{backendNetworkLatency !== null ? "Network latency" : "Network latency (health RTT)"}</span><strong>{isCloudOutput && runNetworkLatency !== null ? `${runNetworkLatency.toFixed(1)} ms` : "—"}</strong><small>{isCloudOutput ? runNetworkLatency !== null ? backendNetworkLatency !== null ? execution?.latency_kind || "Measured network latency reported by the execution backend" : "Pre-run edge ⇄ cloud health round trip; includes health response handling" : "Awaiting latency measurement from the cloud backend" : item.output ? "This output has no confirmed cloud execution" : "Cloud-Accelerated execution pending"}</small>{cloud?.health_rtt_ms !== null && cloud?.health_rtt_ms !== undefined && <small>Latest cloud health RTT: {cloud.health_rtt_ms.toFixed(1)} ms</small>}</div>}{item.output ? <><pre>{item.output.text}</pre><div className="output-stats"><span>{item.output.tokens} tokens · {item.output.tokens_per_second?.toFixed(1)} tokens/s</span><strong>{item.output.total_ms !== undefined ? `${(item.output.total_ms/1000).toFixed(2)} s pipeline` : 'Finalizing pipeline…'}</strong></div><div className="output-breakdown">{item.output.ready_after_ms !== undefined ? `Ready ${(item.output.ready_after_ms/1000).toFixed(2)} s after Run · ` : ''}{item.output.measurement ? 'Edge elapsed' : 'Generation'} {(item.output.generation_ms/1000).toFixed(2)} s{i && audit ? ` · Fusion overhead ${((timing?.fusion_ms ?? audit.fusion_ms)/1000).toFixed(2)} s` : ''}{i && timing ? ` · Restore ${(timing.restore_ms/1000).toFixed(2)} s` : ''}</div></> : <div className="empty"><span>{i ? '✳' : '◫'}</span><p>{busy ? (i ? 'Waiting for fused generation…' : 'Generating baseline…') : 'Your comparison will appear here.'}</p></div>}</article>)}</div>
      {timing && <div className="timing-details"><strong>Full comparison wall time: {(timing.comparison_wall_ms/1000).toFixed(2)} s</strong><span>Shared base setup {(timing.shared_setup_ms/1000).toFixed(2)} s · Queue {(timing.queue_wait_ms/1000).toFixed(2)} s · Baseline {(timing.baseline_total_ms/1000).toFixed(2)} s · Fused pipeline {(timing.fused_total_ms/1000).toFixed(2)} s</span><small>{timing.timing_note}</small></div>}
      {chosen && <details className="rubric"><summary>Review criteria for this proof prompt <span>5 CHECKS</span></summary><ul>{chosen.rubric.map(r => <li key={r}>{r}</li>)}</ul><p>Assess both outputs against each criterion. Fluency alone does not prove improved expertise.</p></details>}
      {audit && <details className="audit"><summary>Inspect the actual matrix changes <span>{audit.layer_count} LAYERS</span></summary><p>Captured token: {audit.token_index !== undefined ? audit.token_index + 1 : "Static"} · network: {audit.network?.state || "Not recorded"} · {audit.fusion_mode || "Fusion"}. These matrix values describe the last applied token vector.</p><p>Exact coefficients used by the kernel: {Object.entries(audit.weights).filter(([, weight]) => weight > 0).map(([name, weight]) => `${labels[name] || name} = ${weight}`).join(" · ")}. Card percentages and formula labels are rounded for readability.</p>{audit.matrix_sample && <div className="sample-inspector"><p>Actual upper-left 6 × 6 values · {audit.matrix_sample.module.replace('base_model.model.','')}</p><div className="sample-matrices">{[{label:'W base', values:audit.matrix_sample.base},...auditedExperts.map(e=>({label:`+ ${labels[e]} weighted Δ`,values:audit.matrix_sample?.contributions[e] || Array.from({length:6},()=>Array(6).fill(0))})),{label:'= W final',values:audit.matrix_sample.fused}].map(matrix=><div key={matrix.label}><strong>{matrix.label}</strong><div className="numeric-matrix">{matrix.values.flat().map((value,i)=><span key={i} title={String(value)}>{value.toFixed(4)}</span>)}</div></div>)}</div></div>}<div className="table-wrap"><table><thead><tr><th>Module</th><th>Shape</th>{auditedExperts.map(e=><th key={e}>{labels[e]} Δ norm</th>)}</tr></thead><tbody>{audit.layers.map(row=><tr key={row.module}><td>{row.module.replace('base_model.model.','')}</td><td>{row.shape.join(' × ')}</td>{auditedExperts.map(e=><td key={e}>{row.delta_norms[e]?.toFixed(4) || '0'}</td>)}</tr>)}</tbody></table></div></details>}
    </section><details className="cloud-drawer"><summary>Expand the adapter library <span>SEARCH & INSTALL FROM HUGGING FACE ↗</span></summary>{network?.state === 'OFFLINE' ? <p className="subtle">Cloud discovery is paused while the network is offline. Cached adapters remain available for inference.</p> : <CloudLibrary disabled={busy} onInstalled={async () => { await refresh(); resetRun(); setManual(false); setVaultVersion(previous => previous + 1); }} />}</details><footer><span>✳ SYNAPSE-MESH <span>/ PROOF OF CONCEPT</span></span><p>Edge orchestration · Outshift cloud connection. Adapter quality varies; compare outputs against the proof criteria.</p></footer>
  </main>;
}
