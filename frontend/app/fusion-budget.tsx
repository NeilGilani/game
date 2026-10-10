'use client';

export type TokenBudget = { token_index: number; weights: Record<string, number>; ideal_weights: Record<string, number>; network_cap: number; budget_spent: number; fusion_mode: string; kernel_updated: boolean; cache_action: string };

export default function FusionBudget({ ideal, actual, cap, mode, labels, step, history }: { ideal: Record<string, number>; actual: Record<string, number>; cap: number; mode: string; labels: Record<string, string>; step: TokenBudget | null; history: TokenBudget[] }) {
  const names = Object.keys({ ...ideal, ...actual }).filter(name => ideal[name] > 0 || actual[name] > 0);
  const idealSum = Object.values(ideal).reduce((sum, value) => sum + value, 0);
  const spent = Object.values(actual).reduce((sum, value) => sum + value, 0);
  const peak = Math.max(1, ...Object.values(ideal));
  return <section className="fusion-budget" aria-label="Network-constrained token budget">
    <div className="budget-heading"><div><span className="eyebrow">ADAPTIVE INTELLIGENCE GRID</span><h3>Intent requests. Network constrains.</h3></div><strong className="budget-total">{spent.toFixed(3)} / {cap.toFixed(3)}<small>APPLIED / CAP</small></strong></div>
    <p className="subtle">{step ? `Token ${step.token_index + 1} · ${step.kernel_updated ? 'weights updated' : 'weights unchanged'} · attention cache ${step.cache_action === 'rebuild' ? 'rebuilt' : 'reused'}` : 'Preview · weights are applied before each next-token prediction.'}</p>
    <div className="budget-columns"><span>ADAPTER</span><span>IDEAL</span><span>ACTUAL</span></div>
    {names.map(name => <div className="budget-row" key={name} data-adapter={name} title={`Exact ideal ${ideal[name] || 0}; actual ${actual[name] || 0}`}><span>{labels[name] || name}</span><div><strong className="ideal-value">{(ideal[name] || 0).toFixed(4)}</strong><i style={{ width: `${(ideal[name] || 0) / peak * 100}%` }} /></div><div><strong className="actual-value">{(actual[name] || 0).toFixed(4)}</strong><i style={{ width: `${(actual[name] || 0) / peak * 100}%` }} /></div></div>)}
    <p className="budget-equation">{mode === 'Critical-Fusion' ? 'α actual[argmax α ideal] = cap; others = 0' : 'α actual = (α ideal / Σ α ideal) × cap'} · Ideal total {idealSum.toFixed(3)}</p>
    <p className="budget-caveat">The cap limits adapter influence. Smaller coefficients alone do not reduce dense computation; changing weights requires a cache rebuild. Timings below include that work.</p>
    {history.length > 0 && <details className="token-ledger"><summary>Inspect token budgets <span>{history.length} TOKENS</span></summary><div className="table-wrap"><table><thead><tr><th>Token</th><th>Mode</th><th>Cap</th><th>Spent</th><th>Cache</th><th>Actual coefficients</th></tr></thead><tbody>{history.map(row => <tr key={row.token_index}><td>{row.token_index + 1}</td><td>{row.fusion_mode}</td><td>{row.network_cap.toFixed(2)}</td><td>{row.budget_spent.toFixed(6)}</td><td>{row.cache_action}</td><td>{Object.entries(row.weights).filter(([, value]) => value > 0).map(([name, value]) => `${labels[name] || name}=${value}`).join(' · ') || 'Base only'}</td></tr>)}</tbody></table></div></details>}
  </section>;
}
