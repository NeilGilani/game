/** One running task: its plan, the person's pending question or approval, pause/stop, and budgets. */

import type { AgentEvent, ApprovalDecision, ApprovalRequest, ChoiceQuestion, PlanStepView, TaskRequest } from "@agency/contracts";

export class TaskStopped extends Error {
  constructor(readonly by: "person" | "caregiver" | "system") {
    super(`stopped by ${by}`);
  }
}

export class BudgetExceeded extends Error {}

export interface Budgets {
  /** Model calls per task. */
  maxModelTurns: number;
  /** Tool calls with an effect per task. */
  maxActions: number;
  /** Estimated API spend per task, in dollars. */
  maxCostUsd: number;
  /** One tool call (bridge, native) before it counts as failed. */
  toolTimeoutMs: number;
  /** Attempts per plan step before recovery gives up on it. */
  maxStepAttempts: number;
}

export const DEFAULT_BUDGETS: Budgets = { maxModelTurns: 40, maxActions: 80, maxCostUsd: 2, toolTimeoutMs: 30_000, maxStepAttempts: 3 };

export interface Usage {
  modelTurns: number;
  actions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

type Answer = { optionId: string | null; other?: string };

export class TaskRun {
  readonly startedAt = Date.now();
  steps: PlanStepView[] = [];
  readonly usage: Usage = { modelTurns: 0, actions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  readonly abort = new AbortController();
  /** Time spent waiting for the person; excluded from timing so nobody is rushed. */
  waitingMs = 0;
  ended = false;

  private paused = false;
  private stoppedBy: TaskStopped["by"] | null = null;
  private resumeWaiters: (() => void)[] = [];
  private question: { q: ChoiceQuestion; resolve: (a: Answer) => void; reject: (e: Error) => void } | null = null;
  private approval: { r: ApprovalRequest; resolve: (d: ApprovalDecision) => void; reject: (e: Error) => void } | null = null;
  private qSeq = 0;

  constructor(
    readonly request: TaskRequest,
    readonly budgets: Budgets,
    private readonly emit: (e: AgentEvent) => void,
  ) {}

  get id(): string {
    return this.request.id;
  }

  get dryRun(): boolean {
    return this.request.dryRun !== false;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  // --- Control ------------------------------------------------------------------------------------

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    waiters.forEach((w) => w());
  }

  stop(by: TaskStopped["by"]): void {
    if (this.stoppedBy) return;
    this.stoppedBy = by;
    this.abort.abort();
    const err = new TaskStopped(by);
    this.question?.reject(err);
    this.approval?.reject(err);
    this.question = null;
    this.approval = null;
    this.resume();
  }

  get stopped(): TaskStopped["by"] | null {
    return this.stoppedBy;
  }

  /** Called before every model call and every action: throws when stopped, waits while paused. */
  async checkpoint(): Promise<void> {
    if (this.stoppedBy) throw new TaskStopped(this.stoppedBy);
    if (this.paused) {
      const t0 = Date.now();
      await new Promise<void>((r) => this.resumeWaiters.push(r));
      this.waitingMs += Date.now() - t0;
      if (this.stoppedBy) throw new TaskStopped(this.stoppedBy);
    }
  }

  // --- Plan ---------------------------------------------------------------------------------------

  setPlan(steps: Omit<PlanStepView, "status">[]): void {
    this.steps = steps.map((s) => ({ ...s, status: "pending" }));
    this.emit({ type: "task.plan", taskId: this.id, steps: this.steps.map((s) => ({ ...s })) });
  }

  stepStatus(stepId: string, status: PlanStepView["status"], summary: string, evidence?: string): void {
    const step = this.steps.find((s) => s.id === stepId);
    if (step) step.status = status;
    this.emit({ type: "task.step", taskId: this.id, stepId, status, summary, ...(evidence ? { evidence } : {}) });
  }

  // --- Waiting for the person (no time limits) ----------------------------------------------------

  async ask(q: Omit<ChoiceQuestion, "id">): Promise<Answer> {
    await this.checkpoint();
    const question: ChoiceQuestion = { ...q, id: `q_${this.id}_${++this.qSeq}` };
    const t0 = Date.now();
    try {
      return await new Promise<Answer>((resolve, reject) => {
        this.question = { q: question, resolve, reject };
        this.emit({ type: "task.question", taskId: this.id, question });
      });
    } finally {
      this.waitingMs += Date.now() - t0;
      this.question = null;
    }
  }

  answer(questionId: string, optionId: string | null, other?: string): boolean {
    const q = this.question;
    if (!q || q.q.id !== questionId) return false;
    if (optionId !== null && !q.q.options.some((o) => o.id === optionId)) return false;
    if (optionId === null && !(q.q.allowOther && other?.trim())) return false;
    q.resolve({ optionId, other: other?.trim() });
    return true;
  }

  pendingQuestion(): ChoiceQuestion | null {
    return this.question?.q ?? null;
  }

  async waitForApproval(r: ApprovalRequest): Promise<ApprovalDecision> {
    const t0 = Date.now();
    try {
      return await new Promise<ApprovalDecision>((resolve, reject) => {
        this.approval = { r, resolve, reject };
        this.emit({ type: "approval.required", taskId: this.id, approval: r });
      });
    } finally {
      this.waitingMs += Date.now() - t0;
      this.approval = null;
    }
  }

  decide(d: ApprovalDecision): boolean {
    const a = this.approval;
    if (!a || a.r.id !== d.approvalId) return false;
    a.resolve(d);
    return true;
  }

  pendingApproval(): ApprovalRequest | null {
    return this.approval?.r ?? null;
  }

  // --- Budgets ------------------------------------------------------------------------------------

  countAction(): void {
    if (++this.usage.actions > this.budgets.maxActions) throw new BudgetExceeded(`I used my limit of ${this.budgets.maxActions} actions for one task.`);
  }

  countModelTurn(): void {
    if (++this.usage.modelTurns > this.budgets.maxModelTurns) throw new BudgetExceeded(`I used my limit of ${this.budgets.maxModelTurns} thinking steps for one task.`);
    if (this.usage.costUsd > this.budgets.maxCostUsd) throw new BudgetExceeded(`This task reached its cost limit of $${this.budgets.maxCostUsd.toFixed(2)}.`);
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
