/**
 * How a running task looks on Talk's screens: the plan as big steps, notes, the question as
 * big cards, approvals with the exact details, and the result (verified or not). The
 * approval's confirm control appears after a pause and away from where the request was.
 */

import { useEffect, useRef, useState } from "react";
import type { ApprovalRequest, ChoiceQuestion, PlanStepView } from "../../../os/contracts/src/agent";
import { SELECTION_RESET_EVENT } from "../components/common";
import { useDialogFocus } from "../components/useDialogFocus";
import { Icon } from "../components/Icon";
import type { TaskResult } from "./useAgentTask";

const STEP_ICON: Record<PlanStepView["status"], string> = {
  pending: "clock",
  running: "play",
  waiting: "hand",
  done: "check",
  failed: "alert",
  skipped: "skip",
};

export function PlanSteps({ steps }: { steps: PlanStepView[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="talk-steps" aria-label="Steps">
      {steps.map((s) => (
        <li key={s.id} className={`talk-step talk-step-${s.status}`}>
          <Icon name={STEP_ICON[s.status]} size={20} />
          <span>{s.title}</span>
          {s.risk === "consequential" && <span className="talk-step-tag">needs your OK</span>}
        </li>
      ))}
    </ol>
  );
}

export function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="talk-notes" aria-live="polite">
      {notes.slice(-2).map((n, i) => (
        <p key={`${i}-${n.slice(0, 20)}`} className="talk-note">
          <Icon name="info" size={20} /> {n}
        </p>
      ))}
    </div>
  );
}

export function QuestionCards({
  question,
  onAnswer,
  prompt,
  otherLabel = "Type my own words",
}: {
  question: ChoiceQuestion;
  onAnswer: (optionId: string | null, other?: string) => void;
  prompt?: string;
  otherLabel?: string;
}) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    setTyping(false);
    setText("");
  }, [question.id]);
  const cols = question.options.length + (question.allowOther ? 1 : 0) > 4 ? 3 : 2;
  return (
    <section className="talk-question" aria-labelledby={`q-${question.id}`}>
      <h2 id={`q-${question.id}`} className="talk-question-prompt">
        {prompt ?? question.prompt}
      </h2>
      {typing ? (
        <form
          className="talk-type"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAnswer(null, text.trim());
          }}
        >
          <label htmlFor="talk-type-input" className="sr-only">
            Your words
          </label>
          <input
            id="talk-type-input"
            className="talk-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            autoComplete="off"
          />
          <button className="btn btn-primary talk-btn" type="submit" disabled={!text.trim()} data-dwell>
            <Icon name="check" /> Use these words
          </button>
          <button
            className="btn talk-btn btn-quiet"
            type="button"
            onClick={() => setTyping(false)}
            data-dwell
          >
            <Icon name="back" /> Back to choices
          </button>
        </form>
      ) : (
        <div className={`talk-options talk-options-${cols}`}>
          {question.options.map((o) => (
            <button key={o.id} className="talk-option" onClick={() => onAnswer(o.id)} data-dwell>
              <span className="talk-option-label">{o.label}</span>
              {o.description && <span className="talk-option-desc">{o.description}</span>}
              {o.suggestedBecause && (
                <span className="talk-option-why">
                  <Icon name="sparkle" size={18} /> {o.suggestedBecause}
                </span>
              )}
            </button>
          ))}
          {question.allowOther && (
            <button className="talk-option talk-option-quiet" onClick={() => setTyping(true)} data-dwell>
              <span className="talk-option-label">
                <Icon name="edit" /> {otherLabel}
              </span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** The pause before Approve becomes available, so a lingering gaze can't confirm. */
export const APPROVE_PAUSE_MS = 1500;

export function ApprovalPanel({
  approval,
  onDecide,
  approveLabel = "Approve",
}: {
  approval: ApprovalRequest;
  onDecide: (decision: "approve" | "decline") => void;
  approveLabel?: string;
}) {
  const [ready, setReady] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, () => onDecide("decline"));
  useEffect(() => {
    setReady(false);
    const t = window.setTimeout(() => setReady(true), APPROVE_PAUSE_MS);
    return () => window.clearTimeout(t);
  }, [approval.id]);
  const entries = Object.entries(approval.details);
  return (
    <div className="sheet-backdrop">
      <div
        className="sheet talk-approval"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        data-dwell-scope="modal"
        ref={ref}
      >
        {approval.simulated && (
          <span className="badge talk-sim-badge" data-tone="sim">
            Simulated: nothing real happens
          </span>
        )}
        <h2 id="approval-title">{approval.summary}</h2>
        <dl className="talk-details">
          {entries.map(([k, v]) => (
            <div key={k} className="talk-detail">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {approval.preview?.kind === "text" && (
          <details className="talk-preview-box">
            <summary>Show exactly what is sent</summary>
            <pre className="talk-preview">{approval.preview.data}</pre>
          </details>
        )}
        <div className="sheet-actions">
          <button
            className="btn btn-xl btn-quiet"
            onClick={() => onDecide("decline")}
            data-dwell
            data-autofocus
          >
            <Icon name="x" /> No, don't
          </button>
          <button
            className="btn btn-xl btn-primary"
            onClick={() => onDecide("approve")}
            disabled={!ready}
            aria-disabled={!ready}
            data-dwell
          >
            <Icon name="check" /> {ready ? approveLabel : "Read it first…"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ResultPanel({
  result,
  onAgain,
  againLabel,
}: {
  result: TaskResult;
  onAgain: () => void;
  againLabel: string;
}) {
  const tone =
    result.type === "done"
      ? result.verified
        ? "ok"
        : "warn"
      : result.type === "failed"
        ? "danger"
        : "muted";
  return (
    <div className={`panel talk-result talk-result-${tone}`} role="status">
      {result.type === "done" && (
        <>
          <h2>
            <Icon name={result.verified ? "check" : "alert"} /> {result.outcome}
          </h2>
          <p className="talk-muted">
            {result.verified ? `Checked: ${result.evidence ?? "verified"}` : "Not verified. Please check."}
          </p>
        </>
      )}
      {result.type === "failed" && (
        <>
          <h2>
            <Icon name="alert" /> {result.recoverable ? "That didn't work" : "AGENCY won't do this"}
          </h2>
          <p className="talk-reason">{result.reason}</p>
        </>
      )}
      {result.type === "stopped" && <h2>Stopped. Nothing more will happen.</h2>}
      <button className="btn btn-primary talk-btn" onClick={onAgain} data-dwell>
        <Icon name="back" /> {againLabel}
      </button>
    </div>
  );
}
