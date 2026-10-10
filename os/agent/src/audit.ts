/**
 * Append-only audit trail of every action: what, why, which approval, result. Readable by the person and
 * the caregiver. Secrets are redacted before anything is written; screenshots are never written.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./policy/secrets";

export type AuditKind =
  | "task.started"
  | "plan"
  | "action"
  | "approval.requested"
  | "approval.decided"
  | "approval.stale"
  | "refused"
  | "question"
  | "answer"
  | "injection"
  | "verify"
  | "model"
  | "task.ended";

export interface AuditEntry {
  at: string;
  taskId: string;
  kind: AuditKind;
  /** Plain-language line for the person and caregiver. */
  message: string;
  /** What was done (op and target label), if an action. */
  what?: string;
  /** Why: the plan step or the model's stated reason. */
  why?: string;
  approvalId?: string;
  fingerprint?: string;
  result?: "ok" | "failed" | "refused" | "needs-approval" | "simulated";
  data?: Record<string, string | number | boolean>;
}

export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  /** @param file optional JSONL file (e.g. ~/Library/Application Support/AGENCY/agent-audit.jsonl). */
  constructor(private readonly file?: string, private readonly clock: () => Date = () => new Date()) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  record(entry: Omit<AuditEntry, "at">): AuditEntry {
    const clean: AuditEntry = {
      ...entry,
      at: this.clock().toISOString(),
      message: redactSecrets(entry.message),
      what: entry.what && redactSecrets(entry.what),
      why: entry.why && redactSecrets(entry.why),
    };
    this.entries.push(clean);
    if (this.file) appendFileSync(this.file, JSON.stringify(clean) + "\n", { encoding: "utf8", mode: 0o600 });
    return clean;
  }

  all(taskId?: string): AuditEntry[] {
    return taskId ? this.entries.filter((e) => e.taskId === taskId) : [...this.entries];
  }
}
