import { useState } from "react";
import { api } from "../api/client";
import type { Approval, AuditEvent, CaseListItem, Timeline as TimelineData } from "../api/types";
import { ErrorNote, Pager, usePaged } from "../components/common";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { CaseBadge, Loading, formatTime } from "../components/status";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import { usePoll } from "../state/usePoll";
import { StepRow, useCase } from "./CaseWorkspace";

const TONES: Record<string, string> = {
  verified: "ok",
  case_completed: "ok",
  reconciled: "ok",
  step_failed: "danger",
  verification_failed: "danger",
  action_refused: "danger",
  rejected: "danger",
  tool_timeout: "warn",
  tool_retry: "warn",
  recovery_planned: "warn",
  approval_requested: "warn",
  interrupted: "warn",
};

const ACTOR: Record<AuditEvent["actor"], string> = {
  user: "You",
  agent: "AGENCY",
  system: "System",
  presenter: "Presenter",
};

export function TimelineView({ id }: { id: string }) {
  const t = usePoll<TimelineData>(() => api.timeline(id), 2500, `timeline-${id}`);
  const c = useCase(id);
  const [tab, setTab] = useState<"events" | "calls" | "checks">("events");
  const events = t.data?.events ?? [];
  const paged = usePaged(events, 9, "end");

  if (t.error && !t.data) return <ErrorNote message={t.error} onRetry={() => void t.reload()} />;
  if (!t.data || !c.data) return <Loading text="Loading timeline…" />;
  const titles = Object.fromEntries(c.data.steps.map((s) => [s.id, s.title]));

  return (
    <Page label="Case timeline">
      <div className="page-head">
        <div>
          <div className="eyebrow">{c.data.title} · timeline</div>
          <h1>Everything that happened, in order</h1>
          <p>
            Every entry is recorded by the coordinator as it happens: tool calls, results, checks and your
            decisions.
          </p>
        </div>
        <button className="btn" onClick={() => navigate(`/case/${id}`)} data-dwell>
          <Icon name="back" /> Back to case
        </button>
      </div>

      <div className="row" role="tablist" aria-label="Timeline views">
        {(
          [
            ["events", "Events", t.data.events.length],
            ["calls", "Tool calls", t.data.invocations.length],
            ["checks", "Verification checks", t.data.verifications.length],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`btn ${tab === key ? "btn-primary" : ""}`}
            onClick={() => setTab(key)}
            data-dwell
          >
            {label} ({count})
          </button>
        ))}
      </div>

      {tab === "events" && (
        <section className="panel stack">
          <ol className="timeline">
            {paged.items.map((e) => (
              <li key={e.id} data-actor={e.actor} data-tone={TONES[e.kind] ?? ""}>
                <time dateTime={e.ts}>
                  {formatTime(e.ts)} · {ACTOR[e.actor]}
                  {e.step_id && titles[e.step_id] ? ` · ${titles[e.step_id]}` : ""}
                </time>
                <div>{e.message}</div>
              </li>
            ))}
          </ol>
          <Pager
            page={paged.page}
            pages={paged.pages}
            onPrev={paged.prev}
            onNext={paged.next}
            label="Timeline"
          />
        </section>
      )}

      {tab === "calls" && (
        <section className="panel" style={{ overflowX: "auto" }}>
          <table className="data">
            <caption className="sr-only">Tool calls</caption>
            <thead>
              <tr>
                <th>Step</th>
                <th>Tool</th>
                <th>Attempt</th>
                <th>Outcome</th>
                <th>Time</th>
                <th>Idempotency key</th>
              </tr>
            </thead>
            <tbody>
              {t.data.invocations.map((i) => (
                <tr key={i.id}>
                  <td>{titles[i.step_id] ?? i.step_id}</td>
                  <td className="mono">{i.tool}</td>
                  <td>{i.attempt}</td>
                  <td>
                    {i.status}
                    {i.error ? `: ${i.error.message}` : ""}
                  </td>
                  <td>{i.duration_ms !== null ? `${i.duration_ms} ms` : "—"}</td>
                  <td className="mono">{i.idempotency_key}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === "checks" && (
        <section className="stack">
          {t.data.verifications.length === 0 && <p className="empty">No checks yet.</p>}
          {t.data.verifications.slice(-8).map((v) => (
            <div key={v.id} className={`panel ${v.passed ? "" : "panel-danger"}`}>
              <h3>
                <Icon name={v.passed ? "check" : "alert"} /> {titles[v.step_id] ?? v.step_id} ·{" "}
                {v.passed ? "confirmed" : "did not match"} · {formatTime(v.ts)}
              </h3>
              <ul className="list">
                {v.checks.map((ch) => (
                  <li key={ch.name}>
                    <Icon name={ch.passed ? "check" : "x"} size={20} />
                    <span>
                      {ch.name}
                      {!ch.passed && (
                        <span className="small muted">
                          {" "}
                          (expected {JSON.stringify(ch.expected)}, found {JSON.stringify(ch.observed)})
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </Page>
  );
}

export function RecoveryView({ id }: { id: string }) {
  const c = useCase(id);
  if (c.error && !c.data) return <ErrorNote message={c.error} onRetry={() => void c.reload()} />;
  if (!c.data) return <Loading />;
  const data = c.data;
  const failed = data.steps.filter((s) => s.status === "failed" || s.status === "rejected");
  return (
    <Page label="Recovery">
      <div className="page-head">
        <div>
          <div className="eyebrow">{data.title} · recovery</div>
          <h1>
            {failed.length
              ? "What went wrong, and what I'm doing about it"
              : "Nothing has gone wrong in this case"}
          </h1>
          <p>
            I never pretend a failed action worked. I check with the service, explain, and ask before trying
            something else.
          </p>
        </div>
        <button className="btn" onClick={() => navigate(`/case/${id}`)} data-dwell>
          <Icon name="back" /> Back to case
        </button>
      </div>
      {failed.map((s) => {
        const fix = data.steps.find((x) => x.id === s.replaced_by);
        const related = data.steps.filter(
          (x) => x.recovery_context?.part_of_recovery_for === s.id || x.id === s.replaced_by,
        );
        return (
          <section key={s.id} className="panel stack">
            <h2>
              <Icon name="alert" /> {s.title}
            </h2>
            <dl className="kv">
              <dt>What went wrong</dt>
              <dd>{s.error?.message ?? "It didn't complete."}</dd>
              {fix?.recovery_context?.what_happened && (
                <>
                  <dt>What I checked</dt>
                  <dd>{fix.recovery_context.what_happened}</dd>
                </>
              )}
              <dt>What I propose</dt>
              <dd>
                {fix
                  ? `“${fix.title}”: ${fix.status_label.toLowerCase()}.`
                  : s.status === "rejected"
                    ? "You declined this, so it won't happen."
                    : "Nothing automatic: this part stays undone."}
              </dd>
            </dl>
            {related.length > 0 && (
              <ol className="steps">
                {related.map((r) => (
                  <StepRow key={r.id} step={r} steps={data.steps} />
                ))}
              </ol>
            )}
            {fix?.status === "awaiting_approval" && (
              <button
                className="btn btn-xl btn-primary"
                style={{ alignSelf: "flex-start" }}
                onClick={() => navigate(`/case/${id}/approve`)}
                data-dwell
              >
                <Icon name="hand" /> Review the fix
              </button>
            )}
          </section>
        );
      })}
    </Page>
  );
}

export function CasesList() {
  const cases = usePoll<CaseListItem[]>(() => api.cases(), 3000, "cases-all");
  const announce = useAnnounce();
  const paged = usePaged(cases.data ?? [], 4);
  if (cases.error && !cases.data)
    return <ErrorNote message={cases.error} onRetry={() => void cases.reload()} />;
  if (!cases.data) return <Loading />;
  return (
    <Page label="Cases">
      <div className="page-head">
        <div>
          <div className="eyebrow">Cases</div>
          <h1>Your tasks</h1>
          <p>
            Every case is saved on the coordinator, so you can come back to it after a break or a restart.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate("/new")} data-dwell>
          <Icon name="plus" /> New task
        </button>
      </div>
      {cases.data.length === 0 && <p className="empty">No cases yet. Start a task to create one.</p>}
      <div className="grid grid-2">
        {paged.items.map((c) => {
          const resumable = ["paused", "interrupted", "needs_attention"].includes(c.status);
          return (
            <section key={c.id} className="panel stack">
              <div className="row">
                <h2 style={{ margin: 0 }}>{c.title}</h2>
                <span className="spacer" />
                <CaseBadge status={c.status} label={c.status_label} />
              </div>
              <div className="progress">
                <span style={{ width: `${(100 * c.progress.done) / Math.max(1, c.progress.total)}%` }} />
              </div>
              <p className="small muted">
                {c.progress.done} of {c.progress.total} steps done · updated {formatTime(c.updated_at)}
                {c.pending_approvals ? ` · ${c.pending_approvals} waiting for approval` : ""}
              </p>
              <div className="row">
                <button className="btn btn-primary" onClick={() => navigate(`/case/${c.id}`)} data-dwell>
                  Open
                </button>
                {resumable && (
                  <button
                    className="btn"
                    data-dwell
                    onClick={async () => {
                      await api.resumeCase(c.id);
                      announce(`Resumed ${c.title}`);
                      navigate(`/case/${c.id}`);
                    }}
                  >
                    <Icon name="play" /> Resume
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <Pager page={paged.page} pages={paged.pages} onPrev={paged.prev} onNext={paged.next} label="Cases" />
    </Page>
  );
}

export function ApprovalsList() {
  const approvals = usePoll<Approval[]>(() => api.approvals(), 2500, "approvals-all");
  if (approvals.error && !approvals.data)
    return <ErrorNote message={approvals.error} onRetry={() => void approvals.reload()} />;
  if (!approvals.data) return <Loading />;
  const groups = new Map<string, Approval[]>();
  for (const a of approvals.data) groups.set(a.case_id, [...(groups.get(a.case_id) ?? []), a]);
  return (
    <Page label="Approvals">
      <div className="page-head">
        <div>
          <div className="eyebrow">Approvals</div>
          <h1>Waiting for your decision</h1>
          <p>AGENCY never books, sends or submits anything without your approval.</p>
        </div>
      </div>
      {groups.size === 0 && <p className="empty">Nothing is waiting for you.</p>}
      {[...groups.entries()].map(([caseId, items]) => (
        <section key={caseId} className="panel stack">
          <h2>{items[0]?.case_title}</h2>
          <ul className="list">
            {items.map((a) => (
              <li key={a.id}>
                <Icon name="hand" size={20} />
                <strong>{a.summary}</strong>
              </li>
            ))}
          </ul>
          <button
            className="btn btn-xl btn-primary"
            style={{ alignSelf: "flex-start" }}
            onClick={() => navigate(`/case/${caseId}/approve`)}
            data-dwell
          >
            Review {items.length === 1 ? "it" : `all ${items.length}`}
          </button>
        </section>
      ))}
    </Page>
  );
}
