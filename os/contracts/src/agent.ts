/** The agent runtime (os/agent): task requests in, a stream of events out. */

export type RiskLevel = "read" | "reversible" | "consequential";

/** Why an action is consequential. Any of these needs an approval bound to the exact action. */
export type ConsequentialKind =
  | "send"
  | "purchase"
  | "sign"
  | "call"
  | "submit"
  | "delete"
  | "share-personal-data"
  | "account-or-settings"
  | "install";

export interface TaskRequest {
  id: string;
  /** Plain language, e.g. "Order my usual Friday dinner". */
  goal: string;
  origin: "home" | "flow" | "talk" | "memory-suggestion" | "voice-of-caregiver";
  /** Choices already made in the flow, e.g. { restaurant: "Thai Basil", dish: "Pad thai" }. */
  selections?: Record<string, string>;
  /** Run without real-world effects (sandbox, simulated). Demos default to true. */
  dryRun?: boolean;
}

export interface PlanStepView {
  id: string;
  title: string;
  risk: RiskLevel;
  status: "pending" | "running" | "done" | "failed" | "skipped" | "waiting";
}

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  /** data: URL or http(s) URL of a picture (menu item, product, contact photo). */
  image?: string;
  /** Set when memory suggests this option; shown first with the reason. */
  suggestedBecause?: string;
}

/** Choose-your-own-adventure: the agent asks the person to pick instead of typing. */
export interface ChoiceQuestion {
  id: string;
  prompt: string;
  options: ChoiceOption[]; // 2 to 6
  allowOther?: boolean;
}

export interface ApprovalRequest {
  id: string;
  kind: ConsequentialKind;
  /** One sentence: "Pay $24.80 to Thai Basil for 1 pad thai (mild), delivered to home." */
  summary: string;
  /** Exact fields that matter: amount, recipient, address, document name, phone number... */
  details: Record<string, string>;
  preview?: { kind: "screenshot" | "text" | "document"; data: string };
  /** sha256 of the exact action and inputs. A different fingerprint needs a new approval. */
  fingerprint: string;
  /** Simulated actions are labelled everywhere. */
  simulated: boolean;
}

export interface ApprovalDecision {
  approvalId: string;
  fingerprint: string;
  decision: "approve" | "decline" | "change";
  /** For "change": which detail the person wants different. */
  change?: string;
}

export type AgentEvent =
  | { type: "task.started"; taskId: string; goal: string; dryRun: boolean }
  | { type: "task.plan"; taskId: string; steps: PlanStepView[] }
  | { type: "task.step"; taskId: string; stepId: string; status: PlanStepView["status"]; summary: string; evidence?: string }
  | { type: "task.question"; taskId: string; question: ChoiceQuestion }
  | { type: "approval.required"; taskId: string; approval: ApprovalRequest }
  | { type: "task.done"; taskId: string; outcome: string; verified: boolean; evidence?: string }
  | { type: "task.failed"; taskId: string; reason: string; recoverable: boolean }
  | { type: "task.stopped"; taskId: string; by: "person" | "caregiver" | "system" };

export type AgentCommand =
  | { type: "task.start"; request: TaskRequest }
  | { type: "task.answer"; taskId: string; questionId: string; optionId: string | null; other?: string }
  | { type: "approval.decide"; taskId: string; decision: ApprovalDecision }
  | { type: "task.pause"; taskId: string }
  | { type: "task.resume"; taskId: string }
  | { type: "task.stop"; taskId: string }
  | { type: "stop.all" };
