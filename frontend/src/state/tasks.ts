/**
 * What the person sees of a task, folded from the agent's event stream (AgentEvent in os/contracts). Pure, so it is
 * unit-tested without an agent. The agent is the source of truth; this view never invents progress.
 */
import type { AgentEvent, ApprovalRequest, ChoiceQuestion, PlanStepView, TaskRequest } from "./contracts";

export type TaskPhase =
  "starting" | "working" | "question" | "approval" | "paused" | "done" | "failed" | "stopped";

export interface TaskView {
  id: string;
  goal: string;
  request: TaskRequest;
  dryRun: boolean;
  phase: TaskPhase;
  steps: PlanStepView[];
  /** Latest summary per step, with evidence when the agent gave one. */
  notes: Record<string, { summary: string; evidence?: string }>;
  question: ChoiceQuestion | null;
  approval: ApprovalRequest | null;
  outcome: { text: string; verified: boolean; evidence?: string } | null;
  failure: { reason: string; recoverable: boolean } | null;
  stoppedBy: "person" | "caregiver" | "system" | null;
  /** Approvals the person decided, newest last, so the result screen can say what was approved. */
  decided: { approval: ApprovalRequest; decision: "approve" | "decline" | "change" }[];
  startedAt: number;
  updatedAt: number;
}

export function newTask(request: TaskRequest, now: number): TaskView {
  return {
    id: request.id,
    goal: request.goal,
    request,
    dryRun: request.dryRun ?? true,
    phase: "starting",
    steps: [],
    notes: {},
    question: null,
    approval: null,
    outcome: null,
    failure: null,
    stoppedBy: null,
    decided: [],
    startedAt: now,
    updatedAt: now,
  };
}

const FINISHED: TaskPhase[] = ["done", "failed", "stopped"];

export function isFinished(t: TaskView): boolean {
  return FINISHED.includes(t.phase);
}

/** Needs the person: a question, an approval, or a failure that can be retried. */
export function needsPerson(t: TaskView): boolean {
  return (
    t.phase === "question" || t.phase === "approval" || (t.phase === "failed" && !!t.failure?.recoverable)
  );
}

/** Apply one agent event. Events for other tasks, and late events after the task finished, are ignored. */
export function reduceTask(t: TaskView, e: AgentEvent, now: number): TaskView {
  if (e.taskId !== t.id) return t;
  if (isFinished(t) && e.type !== "task.started") return t;
  const next: TaskView = { ...t, updatedAt: now };
  switch (e.type) {
    case "task.started":
      return {
        ...newTask(t.request, t.startedAt),
        goal: e.goal,
        dryRun: e.dryRun,
        phase: "working",
        updatedAt: now,
      };
    case "task.plan":
      return {
        ...next,
        steps: e.steps.map((s) => ({ ...s })),
        phase: t.phase === "starting" ? "working" : t.phase,
      };
    case "task.step": {
      const steps = next.steps.map((s) => (s.id === e.stepId ? { ...s, status: e.status } : s));
      const notes = {
        ...next.notes,
        [e.stepId]: e.evidence ? { summary: e.summary, evidence: e.evidence } : { summary: e.summary },
      };
      // A step resuming after a question or approval means the agent moved on.
      const phase = t.phase === "paused" ? "paused" : t.question || t.approval ? t.phase : "working";
      return { ...next, steps, notes, phase };
    }
    case "task.question":
      return { ...next, question: e.question, phase: "question" };
    case "approval.required":
      return { ...next, approval: e.approval, question: null, phase: "approval" };
    case "task.done":
      return {
        ...next,
        phase: "done",
        question: null,
        approval: null,
        outcome: e.evidence
          ? { text: e.outcome, verified: e.verified, evidence: e.evidence }
          : { text: e.outcome, verified: e.verified },
      };
    case "task.failed":
      return {
        ...next,
        phase: "failed",
        question: null,
        approval: null,
        failure: { reason: e.reason, recoverable: e.recoverable },
      };
    case "task.stopped":
      return { ...next, phase: "stopped", question: null, approval: null, stoppedBy: e.by };
  }
}

/** The person answered: clear the question locally until the agent's next event arrives. */
export function answered(t: TaskView, now: number): TaskView {
  return { ...t, question: null, phase: "working", updatedAt: now };
}

/** The person decided an approval. The approval is cleared; the agent's next event says what happened. */
export function decided(t: TaskView, decision: "approve" | "decline" | "change", now: number): TaskView {
  if (!t.approval) return t;
  return {
    ...t,
    decided: [...t.decided, { approval: t.approval, decision }],
    approval: null,
    phase: "working",
    updatedAt: now,
  };
}

/** Plain-language progress, e.g. "2 of 4 steps done". */
export function progressText(t: TaskView): string {
  const done = t.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  return t.steps.length ? `${done} of ${t.steps.length} steps done` : "Planning…";
}
