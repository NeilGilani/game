/**
 * Runs a task pack: turns PackContext calls into AgentEvents and AgentCommands back into
 * answers, approvals, pause, resume and stop. This is the in-process stand-in for the
 * agent runtime (Instance 4), and the piece it can embed to run packs.
 */

import type {
  AgentCommand,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  PlanStepView,
  TaskRequest,
} from "../contracts";
import {
  ApprovalViolation,
  PolicyRefusal,
  StoppedError,
  type Answer,
  type ApprovalAnswer,
  type ApprovalDraft,
  type ApprovalGrant,
  type PackContext,
  type TaskPack,
} from "./pack";
import { canonicalJson, sha256Hex } from "./sha256";

export interface AuditEntry {
  at: string;
  taskId: string;
  tool: string;
  risk: string;
  /** Canonical JSON of the arguments, truncated. Never contains secrets (packs refuse those). */
  args: string;
  approvalId?: string;
  result: "ok" | "error" | "blocked";
  detail?: string;
}

export function actionFingerprint(kind: string, tool: string, args: unknown, simulated: boolean): string {
  return sha256Hex(canonicalJson({ kind, tool, args, simulated }));
}

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

type Pending<T> = { resolve: (v: T) => void; reject: (e: unknown) => void };

export interface PackRunOptions {
  emit: (event: AgentEvent) => void;
  audit?: (entry: AuditEntry) => void;
  now?: () => Date;
}

export class PackRun {
  readonly taskId: string;
  private readonly controller = new AbortController();
  private readonly questions = new Map<string, Pending<Answer>>();
  private readonly approvals = new Map<string, Pending<ApprovalAnswer> & { request: ApprovalRequest }>();
  private readonly granted = new Map<string, ApprovalGrant>();
  private readonly used = new Set<string>();
  private paused: { promise: Promise<void>; resume: () => void } | null = null;
  private finished = false;
  private stepsView: PlanStepView[] = [];

  constructor(
    private readonly pack: TaskPack,
    private readonly request: TaskRequest,
    private readonly options: PackRunOptions,
  ) {
    this.taskId = request.id;
  }

  get done(): boolean {
    return this.finished;
  }

  private emit(event: AgentEvent): void {
    if (this.finished && event.type !== "task.stopped") return;
    this.options.emit(event);
  }

  private audit(entry: Omit<AuditEntry, "at" | "taskId">): void {
    this.options.audit?.({
      ...entry,
      at: (this.options.now?.() ?? new Date()).toISOString(),
      taskId: this.taskId,
    });
  }

  private throwIfStopped(): void {
    if (this.controller.signal.aborted) throw new StoppedError();
  }

  private waitFor<T>(register: (p: Pending<T>) => void): Promise<T> {
    this.throwIfStopped();
    return new Promise<T>((resolve, reject) => {
      // Listen first: a listener may stop the task synchronously while the event is emitted.
      this.controller.signal.addEventListener("abort", () => reject(new StoppedError()), { once: true });
      register({ resolve, reject });
      if (this.controller.signal.aborted) reject(new StoppedError());
    });
  }

  private context(): PackContext {
    const dryRun = this.request.dryRun ?? true;
    const ctx: PackContext = {
      taskId: this.taskId,
      dryRun,
      signal: this.controller.signal,
      plan: (steps) => {
        this.stepsView = steps.map((s) => ({ ...s, status: "pending" }));
        this.emit({ type: "task.plan", taskId: this.taskId, steps: this.stepsView });
      },
      step: (stepId, status, summary, evidence) => {
        this.throwIfStopped();
        this.stepsView = this.stepsView.map((s) => (s.id === stepId ? { ...s, status } : s));
        this.emit({
          type: "task.step",
          taskId: this.taskId,
          stepId,
          status,
          summary,
          ...(evidence ? { evidence } : {}),
        });
      },
      ask: (q) => {
        const question = { ...q, id: q.id ?? newId("q") };
        if (question.options.length < 2 || question.options.length > 6)
          throw new Error(`A question needs 2 to 6 options (got ${question.options.length})`);
        return this.waitFor<Answer>((p) => {
          this.questions.set(question.id, p);
          this.emit({ type: "task.question", taskId: this.taskId, question });
        });
      },
      approve: (draft) => this.requestApproval(draft, dryRun),
      exec: (tool, args, fn, grant) => this.exec(tool, args, fn, grant, dryRun),
      note: (text) => {
        this.emit({ type: "task.step", taskId: this.taskId, stepId: "note", status: "done", summary: text });
      },
    };
    return ctx;
  }

  private requestApproval(draft: ApprovalDraft, simulated: boolean): Promise<ApprovalAnswer> {
    const spec = this.pack.tools.find((t) => t.name === draft.action.tool);
    if (!spec) throw new ApprovalViolation(`Unknown tool ${draft.action.tool}`);
    if (spec.kind !== draft.kind)
      throw new ApprovalViolation(
        `${draft.action.tool} needs a "${spec.kind}" approval, not "${draft.kind}"`,
      );
    const request: ApprovalRequest = {
      id: newId("approval"),
      kind: draft.kind,
      summary: simulated ? `${draft.summary} (simulated)` : draft.summary,
      details: { ...draft.details, Mode: simulated ? "Simulated: nothing real happens" : "Real" },
      ...(draft.preview ? { preview: draft.preview } : {}),
      fingerprint: actionFingerprint(draft.kind, draft.action.tool, draft.action.args, simulated),
      simulated,
    };
    return this.waitFor<ApprovalAnswer>((p) => {
      this.approvals.set(request.id, { ...p, request });
      this.emit({ type: "approval.required", taskId: this.taskId, approval: request });
    });
  }

  private async exec<T>(
    tool: string,
    args: unknown,
    fn: () => Promise<T>,
    grant: ApprovalGrant | undefined,
    simulated: boolean,
  ): Promise<T> {
    this.throwIfStopped();
    if (this.paused) await this.paused.promise;
    this.throwIfStopped();
    const spec = this.pack.tools.find((t) => t.name === tool);
    const argText = canonicalJson(args).slice(0, 500);
    if (!spec) {
      this.audit({ tool, risk: "unknown", args: argText, result: "blocked", detail: "undeclared tool" });
      throw new ApprovalViolation(`Tool ${tool} isn't declared by pack ${this.pack.id}`);
    }
    if (spec.risk === "consequential") {
      const expected = actionFingerprint(spec.kind ?? "", tool, args, simulated);
      const recorded = grant ? this.granted.get(grant.approvalId) : undefined;
      const problem = !grant
        ? "no approval"
        : !recorded || recorded.fingerprint !== grant.fingerprint
          ? "approval not issued by this task"
          : grant.fingerprint !== expected
            ? "the action changed after it was approved"
            : this.used.has(grant.approvalId)
              ? "approval already used"
              : null;
      if (problem) {
        this.audit({ tool, risk: spec.risk, args: argText, result: "blocked", detail: problem });
        throw new ApprovalViolation(`${tool}: ${problem}. A new approval is needed.`);
      }
      this.used.add(grant!.approvalId);
    }
    try {
      const result = await fn();
      this.audit({
        tool,
        risk: spec.risk,
        args: argText,
        result: "ok",
        ...(grant ? { approvalId: grant.approvalId } : {}),
      });
      return result;
    } catch (e) {
      this.audit({
        tool,
        risk: spec.risk,
        args: argText,
        result: "error",
        detail: e instanceof Error ? e.message : String(e),
        ...(grant ? { approvalId: grant.approvalId } : {}),
      });
      throw e;
    }
  }

  async start(): Promise<void> {
    const dryRun = this.request.dryRun ?? true;
    this.emit({ type: "task.started", taskId: this.taskId, goal: this.request.goal, dryRun });
    try {
      const result = await this.pack.run(this.context(), this.request);
      if (this.finished) return;
      this.finished = true;
      this.options.emit({
        type: "task.done",
        taskId: this.taskId,
        outcome: result.outcome,
        verified: result.verified,
        ...(result.evidence ? { evidence: result.evidence } : {}),
      });
    } catch (e) {
      if (this.finished) return;
      this.finished = true;
      if (e instanceof StoppedError) return; // task.stopped was already emitted by stop()
      const reason =
        e instanceof PolicyRefusal || e instanceof ApprovalViolation
          ? e.message
          : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
      this.options.emit({
        type: "task.failed",
        taskId: this.taskId,
        reason,
        recoverable: !(e instanceof PolicyRefusal),
      });
    }
  }

  handle(command: AgentCommand): void {
    switch (command.type) {
      case "task.answer": {
        const p = this.questions.get(command.questionId);
        if (!p) return;
        this.questions.delete(command.questionId);
        p.resolve({
          optionId: command.optionId,
          ...(command.other !== undefined ? { other: command.other } : {}),
        });
        return;
      }
      case "approval.decide":
        this.decide(command.decision);
        return;
      case "task.pause":
        if (!this.paused) {
          let resume = () => {};
          const promise = new Promise<void>((r) => (resume = r));
          this.paused = { promise, resume };
        }
        return;
      case "task.resume":
        this.paused?.resume();
        this.paused = null;
        return;
      case "task.stop":
      case "stop.all":
        this.stop("person");
        return;
      case "task.start":
        return;
    }
  }

  private decide(decision: ApprovalDecision): void {
    const pending = this.approvals.get(decision.approvalId);
    if (!pending) return;
    // A decision for a different fingerprint is ignored: it can't approve this action.
    if (decision.fingerprint !== pending.request.fingerprint) return;
    this.approvals.delete(decision.approvalId);
    if (decision.decision === "approve") {
      const grant: ApprovalGrant = {
        approvalId: pending.request.id,
        fingerprint: pending.request.fingerprint,
        kind: pending.request.kind,
      };
      this.granted.set(grant.approvalId, grant);
      pending.resolve({ approved: true, grant });
    } else {
      pending.resolve({
        approved: false,
        decision: decision.decision,
        ...(decision.change !== undefined ? { change: decision.change } : {}),
      });
    }
  }

  stop(by: "person" | "caregiver" | "system"): void {
    if (this.finished) return;
    this.finished = true;
    this.paused?.resume();
    this.controller.abort();
    this.options.emit({ type: "task.stopped", taskId: this.taskId, by });
  }
}
