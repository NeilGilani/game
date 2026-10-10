'use client';
import { useEffect, useState } from 'react';
type Model = { repo_id: string; revision: string; base_models: string[]; downloads: number; candidate: boolean; reason: string; subfolder: string; installed_as: string | null; url: string };
type Catalog = { source: string; models: Model[]; next_cursor: string | null };
type Inspection = { repo_id: string; revision: string; subfolder: string; rank: number; bytes: number; target_modules: string[]; base_revision_unspecified: boolean; license: string | null };
export default function CloudLibrary({ onInstalled, disabled }: { onInstalled: (name: string) => Promise<void>; disabled: boolean }) {
  const [query, setQuery] = useState(''); const [scope, setScope] = useState('all');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false); const [working, setWorking] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [expertise, setExpertise] = useState(''); const [repo, setRepo] = useState(''); const [subfolder, setSubfolder] = useState('');
  async function search(cursor: string | null = null, nextScope = scope) {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ q: query, scope: nextScope }); if (cursor) params.set('cursor', cursor);
      const response = await fetch('/kernel/catalog?' + params); const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Cloud library unavailable');
      setCatalog(previous => cursor && previous ? { ...data, models: [...previous.models, ...data.models.filter((m: Model) => !previous.models.some(x => x.repo_id === m.repo_id))] } : data);
    } catch (e) { setError(e instanceof Error ? e.message : 'Cloud request failed'); } finally { setLoading(false); }
  }
  useEffect(() => { void search(); }, []);
  async function inspect(repo_id: string, folder = '', revision?: string) {
    setWorking(true); setError(''); setNotice(''); setInspection(null);
    try {
      const response = await fetch('/kernel/catalog/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo_id, subfolder: folder, revision }) }); const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Adapter is incompatible');
      setInspection(data); setExpertise(repo_id.split('/')[1].replaceAll('-', ' '));
    } catch (e) { setError(e instanceof Error ? e.message : 'Inspection failed'); } finally { setWorking(false); }
  }
  async function install() {
    if (!inspection) return; setWorking(true); setError('');
    try {
      const response = await fetch('/kernel/catalog/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...inspection, expertise }) }); const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Download failed');
      await onInstalled(data.name);
      setCatalog(previous => previous ? { ...previous, models: previous.models.map(m => m.repo_id === data.repo_id ? { ...m, installed_as: data.name } : m) } : previous);
      setNotice(`${data.label} downloaded and added to the vault. Select it in your mixture to fuse its weights.`); setInspection(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Download failed'); } finally { setWorking(false); }
  }
  return <section className="cloud-library">
    <div className="cloud-heading"><div><div className="eyebrow">CONNECTED MODEL LIBRARY</div><h2>Explore the cloud. Compose locally.</h2><p>Search the live Hugging Face catalog. Bring compatible LoRA experts into your fusion vault.</p></div><a href="https://huggingface.co/models" target="_blank" rel="noreferrer">Hugging Face ↗</a></div>
    <form className="cloud-search" onSubmit={e => { e.preventDefault(); void search(); }}><input aria-label="Search cloud models" placeholder="Search any model, author, or expertise…" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Cloud library filter" value={scope} disabled={loading} onChange={e => { setScope(e.target.value); void search(null, e.target.value); }}><option value="all">All cloud models</option><option value="adapters">LoRA / PEFT adapters</option><option value="compatible">Current base family</option></select><button disabled={loading} type="submit">{loading ? 'Searching…' : 'Search library'}</button></form>
    <div className="cloud-info"><span>{catalog?.source || 'Connecting to Hugging Face…'}</span><span>Catalog stays in the cloud · selected adapter matrices fuse on your GPU</span></div>
    {error && <div className="error" role="alert">{error}</div>}{notice && <p className="cloud-notice" role="status">{notice}</p>}
    {inspection && <div className="adapter-inspection"><div><strong>{inspection.repo_id}</strong><p>Verified LoRA · rank {inspection.rank} · {(inspection.bytes / 1048576).toFixed(1)} MB · {inspection.target_modules.length} projection types</p><small>Checkpoint {inspection.revision.slice(0, 12)} · License: {inspection.license || 'not declared'}{inspection.base_revision_unspecified ? ' · Adapter does not declare a base revision; using the demo’s pinned base.' : ''}</small></div><label>Expertise description<input value={expertise} maxLength={500} onChange={e => setExpertise(e.target.value)} /></label><button disabled={working || disabled} onClick={install}>{working ? 'Downloading adapter…' : 'Download & add to vault'}</button><button className="quiet" disabled={working} onClick={() => setInspection(null)}>Cancel</button></div>}
    <div className="cloud-models">{catalog?.models.map(model => <article className="cloud-model" key={model.repo_id}><div className="cloud-model-top"><span className={model.installed_as || model.candidate ? 'compatible' : ''}>{model.installed_as ? 'IN YOUR VAULT' : model.candidate ? 'BASE MATCH' : 'CLOUD MODEL'}</span><small>{new Intl.NumberFormat('en', { notation: 'compact' }).format(model.downloads)} downloads</small></div><a href={model.url} target="_blank" rel="noreferrer">{model.repo_id}</a><p>Base: {model.base_models.join(', ') || 'not declared'}</p><div className="cloud-model-bottom"><small>{model.reason}</small>{model.candidate && !model.installed_as && <button disabled={working || disabled} onClick={() => inspect(model.repo_id, model.subfolder, model.revision)}>Inspect LoRA ↗</button>}</div></article>)}</div>
    {catalog && !catalog.models.length && <p className="subtle">No models found. Try a different name or filter.</p>}
    {catalog?.next_cursor && <button className="load-more" disabled={loading} onClick={() => search(catalog.next_cursor)}>{loading ? 'Loading…' : 'Load more models ↓'}</button>}
    <details className="direct-import"><summary>Add an adapter by repository ID</summary><form onSubmit={e => { e.preventDefault(); void inspect(repo, subfolder); }}><input aria-label="Adapter repository ID" required value={repo} onChange={e => setRepo(e.target.value)} placeholder="owner/model" /><input aria-label="Adapter subfolder" value={subfolder} onChange={e => setSubfolder(e.target.value)} placeholder="Subfolder (optional)" /><button disabled={working || disabled}>Check compatibility</button></form><p>Full models and adapters for other bases remain browsable. This kernel fuses compatible Linear LoRA adapters sharing the current base checkpoint.</p></details>
  </section>;
}
