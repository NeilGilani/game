import type { CaseStatus, StepStatus } from "../api/types";
import { Icon } from "./Icon";

type Tone = "ok" | "warn" | "danger" | "info" | "neutral" | "sim";

const STEP: Record<StepStatus, { tone: Tone; icon: string }> = {
  pending: { tone: "neutral", icon: "clock" },
  waiting_input: { tone: "warn", icon: "question" },
  awaiting_approval: { tone: "warn", icon: "hand" },
  approved: { tone: "info", icon: "check" },
  running: { tone: "info", icon: "refresh" },
  retrying: { tone: "info", icon: "refresh" },
  succeeded: { tone: "info", icon: "check" },
  verified: { tone: "ok", icon: "check" },
  failed: { tone: "danger", icon: "alert" },
  rejected: { tone: "danger", icon: "x" },
  skipped: { tone: "neutral", icon: "skip" },
  superseded: { tone: "neutral", icon: "skip" },
  blocked: { tone: "danger", icon: "x" },
  cancelled: { tone: "neutral", icon: "x" },
};

const CASE: Record<CaseStatus, { tone: Tone; icon: string }> = {
  planning: { tone: "info", icon: "refresh" },
  running: { tone: "info", icon: "refresh" },
  waiting_input: { tone: "warn", icon: "question" },
  waiting_approval: { tone: "warn", icon: "hand" },
  needs_attention: { tone: "danger", icon: "alert" },
  paused: { tone: "warn", icon: "pause" },
  interrupted: { tone: "warn", icon: "pause" },
  completed: { tone: "ok", icon: "check" },
  completed_partial: { tone: "warn", icon: "info" },
  cancelled: { tone: "neutral", icon: "x" },
};

export function stepIcon(status: StepStatus): string {
  return STEP[status].icon;
}

export function StepBadge({ status, label }: { status: StepStatus; label: string }) {
  const s = STEP[status];
  return (
    <span className="badge" data-tone={s.tone}>
      <Icon name={s.icon} size={16} />
      {label}
    </span>
  );
}

export function CaseBadge({ status, label }: { status: CaseStatus; label: string }) {
  const s = CASE[status];
  return (
    <span className="badge" data-tone={s.tone}>
      <Icon name={s.icon} size={16} />
      {label}
    </span>
  );
}

export function SimulatedBadge({ text = "Simulated service" }: { text?: string }) {
  return (
    <span
      className="badge"
      data-tone="sim"
      title="Demonstration service: no real company, office or person is contacted"
    >
      <Icon name="shield" size={16} />
      {text}
    </span>
  );
}

export function Loading({ text = "Loading…" }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {text}
    </div>
  );
}

const WHEN = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** Demo appointment times are wall-clock strings ("2026-10-13T09:00"). */
export function formatWhen(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : WHEN.format(d);
}

/** Audit timestamps are UTC ("…Z"), shown in local time. */
export function formatTime(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : TIME.format(d);
}
