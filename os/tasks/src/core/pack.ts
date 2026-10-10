/**
 * What a task pack is: a declarative description (tools, policies, approvals, verification,
 * and an honest statement of what is real) plus a `run` function written against a
 * PackContext. The agent (os/agent, Instance 4) or the in-process PackAgent runs it.
 *
 * Safety lives in code, not in prompts: a consequential tool can only execute through
 * `ctx.exec` with an approval grant whose fingerprint matches the exact tool and arguments.
 */

import type {
  ApprovalRequest,
  ChoiceQuestion,
  ConsequentialKind,
  PlanStepView,
  RiskLevel,
  Surface,
  TaskRequest,
} from "../contracts";

export interface ToolSpec {
  name: string;
  description: string;
  risk: RiskLevel;
  /** Required when risk is "consequential": what kind of approval it needs. */
  kind?: ConsequentialKind;
}

export interface PolicySpec {
  id: string;
  /** Plain language: "Never dials emergency numbers; Lifeline handles emergencies." */
  rule: string;
}

export interface ApprovalSpec {
  kind: ConsequentialKind;
  /** What the approval binds to, e.g. ["phone number", "contact name", "disclosure"]. */
  bindsTo: string[];
}

export interface VerificationSpec {
  /** "The store reports an order with the approved total." */
  check: string;
}

export interface PackHonesty {
  real: string[];
  simulated: string[];
  untested: string[];
}

export interface PackOutcome {
  outcome: string;
  verified: boolean;
  evidence?: string;
}

export interface ApprovalDraft {
  kind: ConsequentialKind;
  summary: string;
  details: Record<string, string>;
  preview?: ApprovalRequest["preview"];
  /** The exact action the approval authorises. The fingerprint is computed from this. */
  action: { tool: string; args: unknown };
  /**
   * Whether the effect is simulated. Defaults to the task's dryRun. A pack sets it to true
   * when only a simulated backend is configured, so a "real" task never shows a real-looking
   * approval for a pretend effect.
   */
  simulated?: boolean;
}

/** Proof the person approved one exact action. Single use. */
export interface ApprovalGrant {
  approvalId: string;
  fingerprint: string;
  kind: ConsequentialKind;
  simulated: boolean;
}

export type ApprovalAnswer =
  | { approved: true; grant: ApprovalGrant }
  | { approved: false; decision: "decline" | "change"; change?: string };

export interface Answer {
  optionId: string | null;
  other?: string;
}

export interface StepInput {
  id: string;
  title: string;
  risk: RiskLevel;
}

export interface PackContext {
  readonly taskId: string;
  readonly dryRun: boolean;
  /** Aborted when the person (or Stop) stops the task. */
  readonly signal: AbortSignal;
  plan(steps: StepInput[]): void;
  step(stepId: string, status: PlanStepView["status"], summary: string, evidence?: string): void;
  ask(question: Omit<ChoiceQuestion, "id"> & { id?: string }): Promise<Answer>;
  approve(draft: ApprovalDraft): Promise<ApprovalAnswer>;
  /**
   * Run a declared tool. Consequential tools need a grant for exactly these arguments;
   * anything else throws ApprovalViolation before `fn` is called.
   */
  exec<T>(tool: string, args: unknown, fn: () => Promise<T>, grant?: ApprovalGrant): Promise<T>;
  /** Show the person something worth knowing that isn't a step (e.g. a refusal reason). */
  note(text: string): void;
}

export interface TaskPack {
  id: string;
  title: string;
  description: string;
  surfaces: Surface[];
  /** Example goals, for the agent's router and for documentation. */
  goals: string[];
  tools: ToolSpec[];
  policies: PolicySpec[];
  approvals: ApprovalSpec[];
  verification: VerificationSpec[];
  honesty: PackHonesty;
  /** 0..1: how well this pack fits a request. `selections.pack === id` always wins. */
  matches(request: TaskRequest): number;
  run(ctx: PackContext, request: TaskRequest): Promise<PackOutcome>;
}

export class ApprovalViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalViolation";
  }
}

export class StoppedError extends Error {
  constructor() {
    super("Stopped");
    this.name = "StoppedError";
  }
}

/** A refusal the pack explains to the person (not a crash). */
export class PolicyRefusal extends Error {
  constructor(
    message: string,
    readonly policyId: string,
  ) {
    super(message);
    this.name = "PolicyRefusal";
  }
}

export function checkPackDeclaration(pack: TaskPack): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const tool of pack.tools) {
    if (names.has(tool.name)) problems.push(`duplicate tool ${tool.name}`);
    names.add(tool.name);
    if (tool.risk === "consequential" && !tool.kind)
      problems.push(`${tool.name} is consequential without a kind`);
    if (tool.risk === "consequential" && tool.kind && !pack.approvals.some((a) => a.kind === tool.kind))
      problems.push(`${tool.name} needs a "${tool.kind}" approval spec`);
  }
  if (pack.policies.length === 0) problems.push("no policies declared");
  if (pack.verification.length === 0) problems.push("no verification declared");
  return problems;
}
