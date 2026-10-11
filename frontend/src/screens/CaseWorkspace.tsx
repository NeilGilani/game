import { RouteLine } from "../components/Synapse";
import { useState } from "react";
import { api } from "../api/client";
import type { CaseDetail, Step } from "../api/types";
import { ConfirmSheet, ErrorNote } from "../components/common";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import {
  CaseBadge,
  Loading,
  SimulatedBadge,
  StepBadge,
  formatTime,
  formatWhen,
  stepIcon,
} from "../components/status";
import { caseFocus, likely } from "../input/context";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import { usePoll } from "../state/usePoll";

const ACTIVE = new Set([
  "planning",
  "running",
  "waiting_input",
  "waiting_approval",
  "needs_attention",
  "paused",
  "interrupted",
]);

export function useCase(id: string) {
  return usePoll<CaseDetail>(() => api.case(id), 1000, `case-${id}`);
}

function evidenceLine(step: Step): string | null {
  const ev = step.evidence;
  if (!ev || step.status !== "verified") return null;
  const out = step.output ?? {};
  const parts: string[] = [];
  if (typeof out.reference === "string") parts.push(`Reference ${out.reference}`);
  if (step.tool === "repair.submit_request" && typeof out.starts_at === "string")
    parts.push(formatWhen(out.starts_at));
  if (step.tool === "calendar.add_event" && typeof out.starts_at === "string")
    parts.push(`on your calendar ${formatWhen(out.starts_at)}`);
  if (step.tool === "funding.check_requirements" && Array.isArray(out.missing)) {
    const missing = out.missing as { label: string }[];
    parts.push(
      missing.length ? `Still needed: ${missing.map((m) => m.label).join("; ")}` : "All requirements on file",
    );
  }
  if (step.tool === "repair.find_slots" && out.recommended && typeof out.recommended === "object") {
    parts.push(`Earliest that fits: ${formatWhen((out.recommended as { starts_at: string }).starts_at)}`);
  }
  if (ev.verification && !step.read_only) parts.push(ev.verification);
  if (ev.replayed) parts.push("Already done earlier, not repeated");
  return parts.length ? parts.join(" · ") : null;
}

export function StepRow({
  step,
  steps,
  onSkip,
}: {
  step: Step;
  steps: Step[];
  onSkip?: (step: Step) => void;
}) {
  const replacement = step.replaced_by ? steps.find((s) => s.id === step.replaced_by) : null;
  const label = step.status === "verified" && step.read_only ? "Done" : step.status_label;
  const evidence = evidenceLine(step);
  return (
    <li className="step" data-status={step.status} data-recovery={!!step.recovery_context}>
      <span className="step-icon">
        <Icon name={stepIcon(step.status)} size={18} />
      </span>
      <span className="step-title">{step.title}</span>
      <StepBadge status={step.status} label={label} />
      <span className="step-meta">
        {step.integration !== "AGENCY" && <span>{step.integration}</span>}
        {step.consequential && <span>Needs your approval</span>}
        {step.recovery_context && <span>Recovery step</span>}
        {step.attempts > 1 && <span>{step.attempts} attempts</span>}
        {step.optional && <span>Optional</span>}
      </span>
      {evidence && <span className="step-evidence">{evidence}</span>}
      {onSkip && step.optional && ["pending", "waiting_input", "awaiting_approval"].includes(step.status) && (
        <span className="step-meta">
          <button className="btn btn-quiet" style={{ minHeight: 56 }} onClick={() => onSkip(step)} data-dwell>
            <Icon name="skip" size={20} /> Skip this step
          </button>
        </span>
      )}
      {step.error && ["failed", "blocked", "rejected"].includes(step.status) && (
        <span className="step-error">
          {step.error.message}
          {replacement && ` Replaced by “${replacement.title}”.`}
        </span>
      )}
    </li>
  );
}

function NowPanel({ data, reload }: { data: CaseDetail; reload: () => Promise<void> }) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const question = data.steps.find((s) => s.status === "waiting_input");
  const failures = data.steps.filter((s) => s.status === "failed" && s.replaced_by);
  // What the coordinator's planner (backend/agency/engine next_actions) is waiting for.
  const focus = caseFocus(data.next_actions);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      announce(message);
      await reload();
    } catch (e) {
      announce(e instanceof Error ? e.message : "That didn't work.", true);
    } finally {
      setBusy(false);
    }
  };

  if (question?.question) {
    return (
      <section className="panel panel-accent stack" aria-labelledby="h-now">
        <div className="eyebrow">I need one answer</div>
        <h2 id="h-now">{question.question.prompt}</h2>
        <div className="option-list">
          {question.question.options.map((o) => (
            <button
              key={o.value}
              className="btn option"
              data-dwell
              {...likely(focus === "answer" && "strong")}
              disabled={busy}
              onClick={() => act(() => api.answer(data.id, question.id, o.value), `Answered: ${o.label}`)}
            >
              {o.label}
              {o.description && <span className="opt-desc">{o.description}</span>}
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (data.status === "waiting_approval") {
    return (
      <section className="panel panel-accent stack" aria-labelledby="h-now">
        <div className="eyebrow">Waiting for you</div>
        <h2 id="h-now">
          {data.pending_approvals.length === 1
            ? "One action needs your approval"
            : `${data.pending_approvals.length} actions need your approval`}
        </h2>
        <ul className="list">
          {data.pending_approvals.map((a) => (
            <li key={a.id}>
              <Icon name={a.details.recovery_context?.reason ? "refresh" : "hand"} size={20} />
              <strong>{a.summary}</strong>
            </li>
          ))}
        </ul>
        {failures.length > 0 && (
          <p className="small">Something went wrong earlier and I've proposed a fix. It's included above.</p>
        )}
        <button
          className="btn btn-xl btn-primary"
          onClick={() => navigate(`/case/${data.id}/approve`)}
          data-dwell
          {...likely(focus === "review" && "strong")}
        >
          <Icon name="hand" /> Review and decide
        </button>
      </section>
    );
  }

  if (data.status === "paused" || data.status === "interrupted" || data.status === "needs_attention") {
    const text =
      data.status === "interrupted"
        ? "The coordinator restarted while this case was running. I've checked what had already happened; finished steps won't be repeated."
        : data.status === "needs_attention"
          ? "I stopped because something unexpected happened. Nothing else will run until you decide."
          : data.automation_paused
            ? "All automation is stopped (Stop agent). Resume it from the top bar."
            : "This case is paused. Nothing will happen until you resume it.";
    return (
      <section className="panel panel-warn stack" aria-labelledby="h-now">
        <div className="eyebrow">{data.status_label}</div>
        <h2 id="h-now">{text}</h2>
        {!data.automation_paused && (
          <button
            className="btn btn-xl btn-primary"
            disabled={busy}
            onClick={() => act(() => api.resumeCase(data.id), "Resumed.")}
            data-dwell
            {...likely(focus === "resume" && "strong")}
          >
            <Icon name="play" /> Resume
          </button>
        )}
      </section>
    );
  }

  if (data.status === "completed" || data.status === "completed_partial") {
    const s = data.summary;
    return (
      <section
        className={`panel stack ${data.status === "completed" ? "panel-accent" : "panel-warn"}`}
        aria-labelledby="h-now"
      >
        <div className="eyebrow">
          {data.status === "completed" ? "Done and verified" : "Finished with open items"}
        </div>
        <h2 id="h-now">
          {data.status === "completed" ? "Everything I did has been checked." : "Some parts weren't done."}
        </h2>
        {s && (
          <>
            <ul className="list">
              {s.done.map((d) => (
                <li key={d}>
                  <Icon name="check" size={20} />
                  {d}
                </li>
              ))}
              {s.not_done.map((d) => (
                <li key={d}>
                  <Icon name="x" size={20} />
                  {d}
                </li>
              ))}
            </ul>
            {s.follow_ups.length > 0 && (
              <>
                <h3>Still to do</h3>
                <ul className="list">
                  {s.follow_ups.map((f) => (
                    <li key={f}>
                      <Icon name="clock" size={20} />
                      {f}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="small muted">{s.simulated_note}</p>
          </>
        )}
        <div className="row">
          <button className="btn btn-primary" onClick={() => navigate("/")} data-dwell>
            <Icon name="home" /> Home
          </button>
          <button className="btn" onClick={() => navigate(`/case/${data.id}/timeline`)} data-dwell>
            <Icon name="timeline" /> See what happened
          </button>
        </div>
      </section>
    );
  }

  if (data.status === "cancelled") {
    return (
      <section className="panel stack">
        <h2>This case was cancelled.</h2>
        <p>Nothing else will happen. Anything already completed stays as it is.</p>
      </section>
    );
  }

  return (
    <section className="panel stack" aria-labelledby="h-now" aria-live="polite">
      <div className="eyebrow">Working on it</div>
      <h2 id="h-now" className="row">
        <span className="spinner" aria-hidden="true" />
        {data.last_event?.message ?? "Starting…"}
      </h2>
      {data.next_actions
        .filter((n) => n.kind === "next")
        .map((n) => (
          <p key={n.step_id} className="muted">
            {n.text}
          </p>
        ))}
      <p className="small muted">
        You don't need to do anything. I'll stop and ask before anything important.
      </p>
    </section>
  );
}

export function CaseWorkspace({ id }: { id: string }) {
  const c = useCase(id);
  const announce = useAnnounce();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  if (c.error && !c.data) return <ErrorNote message={c.error} onRetry={() => void c.reload()} />;
  if (!c.data) return <Loading text="Opening case…" />;
  const data = c.data;
  const active = ACTIVE.has(data.status);
  const failures = data.steps.filter((s) => s.status === "failed");
  const done = data.steps.filter((s) => s.status === "verified" || s.status === "skipped").length;

  return (
    <Page label={`Case: ${data.title}`}>
      <div className="page-head">
        <div className="stack" style={{ gap: 8 }}>
          <div className="eyebrow">
            Case · started {formatTime(data.created_at)} · plan v{data.plan_version}
          </div>
          <h1>{data.title}</h1>
          <div className="row">
            <CaseBadge status={data.status} label={data.status_label} />
            <span className="badge" data-tone={data.reasoning.mode === "cloud" ? "info" : "neutral"}>
              <Icon name={data.reasoning.mode === "cloud" ? "sparkle" : "shield"} size={16} />
              {data.reasoning.mode === "cloud"
                ? `Plan adapted by ${data.reasoning.label ?? "the cloud model"}, validated by AGENCY`
                : "Built-in plan"}
            </span>
            <SimulatedBadge text="Demo services only" />
          </div>
          <RouteLine route={data.reasoning.route} />
        </div>
        <div className="row">
          <button className="btn" onClick={() => navigate(`/case/${id}/timeline`)} data-dwell>
            <Icon name="timeline" /> Timeline
          </button>
          {failures.length > 0 && (
            <button className="btn" onClick={() => navigate(`/case/${id}/recovery`)} data-dwell>
              <Icon name="alert" /> What went wrong
            </button>
          )}
          {active && data.status !== "paused" && data.status !== "interrupted" && (
            <button
              className="btn"
              disabled={busy}
              data-dwell
              onClick={async () => {
                setBusy(true);
                try {
                  c.set(await api.pauseCase(id));
                  announce("Case paused.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Icon name="pause" /> Pause case
            </button>
          )}
          {active && (
            <button className="btn btn-danger" onClick={() => setConfirmCancel(true)} data-dwell>
              <Icon name="x" /> Cancel case
            </button>
          )}
        </div>
      </div>

      <div className="workspace-grid">
        <div className="stack">
          <NowPanel data={data} reload={c.reload} />
          <section className="panel panel-muted stack">
            <h3>
              <Icon name="target" /> Goal
            </h3>
            <p>{data.goal.outcome}</p>
            {data.reasoning.notes.length > 0 && (
              <ul className="list small muted">
                {data.reasoning.notes.map((n) => (
                  <li key={n}>
                    <Icon name="info" size={18} />
                    {n}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <section className="panel" aria-labelledby="h-plan">
          <div className="row">
            <h2 id="h-plan" style={{ margin: 0 }}>
              <Icon name="list" /> Plan
            </h2>
            <span className="spacer" />
            <span className="muted" aria-label={`${done} of ${data.steps.length} steps finished`}>
              {done} / {data.steps.length} done
            </span>
          </div>
          <div className="progress" style={{ margin: "12px 0 6px" }}>
            <span style={{ width: `${(100 * done) / Math.max(1, data.steps.length)}%` }} />
          </div>
          <ol className="steps">
            {data.steps.map((s) => (
              <StepRow
                key={s.id}
                step={s}
                steps={data.steps}
                onSkip={async (step) => {
                  try {
                    c.set(await api.skip(id, step.id));
                    announce(`Skipped: ${step.title}`);
                  } catch (e) {
                    announce(e instanceof Error ? e.message : "Couldn't skip that step.", true);
                  }
                }}
              />
            ))}
          </ol>
        </section>
      </div>

      {confirmCancel && (
        <ConfirmSheet
          title="Cancel this case?"
          confirmLabel="Yes, cancel the case"
          cancelLabel="Keep going"
          tone="danger"
          busy={busy}
          onCancel={() => setConfirmCancel(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              c.set(await api.cancelCase(id));
              announce("Case cancelled.");
              setConfirmCancel(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            Nothing else will happen in this case. Anything already completed (like a booking) stays as it is.
          </p>
        </ConfirmSheet>
      )}
    </Page>
  );
}
