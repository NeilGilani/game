/** The pieces every Papers screen shares: the heading, big choices, the bottom bar with Stop, and the two-step yes. */
import { useEffect, useState, type ReactNode } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { navigate } from "../state/router";
import type { PaperFile } from "../../../os/contracts/src/host";
import type { PapersGate } from "./gate";
import type { PaperSource } from "./source";

/** A document the person opened: its exact bytes, its fingerprint and its text. */
export interface OpenDoc {
  name: string;
  kind: PaperFile["kind"];
  bytes: Uint8Array;
  sha256: string;
  /** Text of each page (empty for pictures and scans). Untrusted: shown and read aloud, never followed. */
  pages: string[];
}

export interface FlowProps {
  doc: OpenDoc;
  gate: PapersGate;
  source: PaperSource;
  /** Back to choosing a document. */
  onBack: () => void;
  /** Stop everything now. */
  onStop: () => void;
}

/** The time a confirm waits before it can be chosen, so a lingering look can't confirm by accident. */
export const PAPERS_CONFIRM_MS = 1500;

export function Head({ eyebrow, title, help }: { eyebrow: string; title: string; help?: ReactNode }) {
  // New choices under the gaze: pause selection briefly so a lingering look doesn't pick one.
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    document.getElementById("papers-title")?.focus({ preventScroll: true });
  }, [title]);
  return (
    <div className="flow-head">
      <div className="eyebrow">
        <Icon name="document" size={18} /> {eyebrow}
      </div>
      <h1 id="papers-title" tabIndex={-1}>
        {title}
      </h1>
      {help && <p className="muted papers-help">{help}</p>}
    </div>
  );
}

export function Choice({
  label,
  sub,
  icon,
  pic,
  onPick,
  gate,
  tone,
}: {
  label: string;
  sub?: string;
  icon?: string;
  pic?: ReactNode;
  onPick: () => void;
  gate?: boolean;
  tone?: "danger";
}) {
  return (
    <button
      className={`choice papers-choice ${tone === "danger" ? "choice-danger" : ""}`}
      onClick={onPick}
      data-dwell
      {...(gate ? { "data-approval-gate": true } : {})}
    >
      <span className="choice-pic" aria-hidden>
        {pic ?? <Icon name={icon ?? "document"} size={56} />}
      </span>
      <span className="choice-label">{label}</span>
      {sub && <span className="choice-sub">{sub}</span>}
    </button>
  );
}

export function Choices({ children, count }: { children: ReactNode; count: number }) {
  return (
    <div
      className="flow-options papers-options"
      data-count={count}
      role="group"
      aria-labelledby="papers-title"
    >
      {children}
    </div>
  );
}

/** Back, Home, then (on the right) paging and Stop. */
export function Bar({
  onBack,
  onStop,
  children,
}: {
  onBack?: () => void;
  onStop?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flow-bar" role="group" aria-label="Move around">
      <button className="btn btn-xl" onClick={onBack ?? (() => navigate("/flow/papers"))} data-dwell>
        <Icon name="back" /> Back
      </button>
      <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
        <Icon name="home" /> Home
      </button>
      <span className="spacer" />
      {children}
      {onStop && (
        <button className="btn btn-xl btn-solid-danger" onClick={onStop} data-dwell>
          <Icon name="stop" /> Stop
        </button>
      )}
    </div>
  );
}

export function PageButtons({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <>
      <button className="btn btn-xl" onClick={() => onPage(page - 1)} disabled={page === 0} data-dwell>
        <Icon name="left" /> Previous
      </button>
      <span className="muted" aria-live="polite">
        {page + 1} of {pages}
      </span>
      <button className="btn btn-xl" onClick={() => onPage(page + 1)} disabled={page >= pages - 1} data-dwell>
        More <Icon name="right" />
      </button>
    </>
  );
}

/**
 * The second yes: on the other side of the screen from the first, and only after a moment. Its label names exactly
 * what happens.
 */
export function SecondConfirm({
  question,
  yes,
  onYes,
  onNo,
  side,
}: {
  question: string;
  yes: string;
  onYes: () => void;
  onNo: () => void;
  side: "left" | "right";
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    const t = setTimeout(() => setReady(true), PAPERS_CONFIRM_MS);
    return () => clearTimeout(t);
  }, []);
  const yesButton = (
    <button
      className="btn btn-xl btn-primary papers-confirm-yes"
      onClick={onYes}
      disabled={!ready}
      data-dwell
      data-approval-gate
      aria-describedby="papers-confirm-why"
    >
      <Icon name="check" /> {ready ? yes : "One moment…"}
    </button>
  );
  const noButton = (
    <button className="btn btn-xl" onClick={onNo} data-dwell>
      <Icon name="back" /> No, go back
    </button>
  );
  return (
    <div className="papers-confirm" role="group" aria-label="Are you sure?">
      <p className="task-big">{question}</p>
      <p id="papers-confirm-why" className="sr-only">
        {ready
          ? "Look here to confirm."
          : "Ready in a moment, so a lingering look can't confirm by accident."}
      </p>
      <div className="task-actions">
        {side === "left" ? yesButton : noButton}
        <span className="spacer" />
        {side === "left" ? noButton : yesButton}
      </div>
    </div>
  );
}

/** A finished save: what was saved, where, and that sending it is a helper's job. */
export function Saved({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="flow" aria-label="Papers" data-testid="papers-saved">
      <Head eyebrow="Papers" title={title} />
      <div className="papers-panel stack">
        {lines.map((l) => (
          <p key={l} className="task-big">
            {l}
          </p>
        ))}
      </div>
      <Bar onBack={() => navigate("/flow/papers")} />
    </div>
  );
}

/** One plain message with a way back (an error, a refusal, something AGENCY can't do yet). */
export function Message({
  eyebrow,
  title,
  lines,
  onBack,
}: {
  eyebrow: string;
  title: string;
  lines: string[];
  onBack: () => void;
}) {
  return (
    <div className="flow" aria-label="Papers">
      <Head eyebrow={eyebrow} title={title} />
      <div className="papers-panel stack" role="status">
        {lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
      </div>
      <Bar onBack={onBack} />
    </div>
  );
}
