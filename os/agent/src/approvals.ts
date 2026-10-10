/**
 * Approvals bound to a fingerprint of the exact action. An approval is single-use: it authorizes exactly one
 * execution of exactly the action that was shown. Any change (target, text, amount, page facts) produces a
 * different fingerprint and needs a new approval. Modeled on backend/agency/engine (inputs_hash).
 */

import type { ApprovalDecision, ApprovalRequest, ConsequentialKind } from "@agency/contracts";
import { canonicalJson, sha256Hex } from "./canonical";
import type { AgentAction } from "./types";

/** The parts of an action that decide its effect. Previews and explanations are excluded on purpose. */
export function fingerprintAction(taskId: string, action: AgentAction, kind: ConsequentialKind): string {
  const t = action.target ?? {};
  return sha256Hex(
    canonicalJson({
      v: 1,
      taskId,
      kind,
      tier: action.tier,
      op: action.op,
      target: { ref: t.ref, label: t.label, role: t.role, origin: t.origin, url: t.url, point: t.point },
      input: action.input ?? {},
      facts: action.facts ?? {},
      summary: action.claim?.summary,
      details: action.claim?.details ?? {},
      amount: action.claim?.amount,
    }),
  );
}

type Status = "pending" | "approved" | "declined" | "changed" | "consumed" | "superseded";

interface Entry {
  request: ApprovalRequest;
  taskId: string;
  status: Status;
  decidedAt?: number;
  change?: string;
}

export class ApprovalGate {
  private readonly entries = new Map<string, Entry>();
  private counter = 0;

  constructor(private readonly newId: () => string = () => `apr_${Date.now().toString(36)}_${(++this.counter).toString(36)}`) {}

  /** Record a new pending request. Any older pending request for the same task is superseded. */
  open(taskId: string, request: Omit<ApprovalRequest, "id">): ApprovalRequest {
    for (const e of this.entries.values()) {
      if (e.taskId === taskId && e.status === "pending") e.status = "superseded";
    }
    const full: ApprovalRequest = { ...request, id: this.newId() };
    this.entries.set(full.id, { request: full, taskId, status: "pending" });
    return full;
  }

  /** Apply the person's decision. Rejects unknown ids, decided requests and mismatched fingerprints. */
  decide(taskId: string, decision: ApprovalDecision): { ok: true; status: Status; change?: string } | { ok: false; error: string } {
    const e = this.entries.get(decision.approvalId);
    if (!e || e.taskId !== taskId) return { ok: false, error: "There is no such approval request for this task." };
    if (e.status !== "pending") return { ok: false, error: `This request is already ${e.status}.` };
    if (decision.fingerprint !== e.request.fingerprint) {
      return { ok: false, error: "The approval does not match the action that was shown. Nothing was done." };
    }
    e.decidedAt = Date.now();
    if (decision.decision === "approve") e.status = "approved";
    else if (decision.decision === "decline") e.status = "declined";
    else {
      e.status = "changed";
      e.change = decision.change;
    }
    return { ok: true, status: e.status, change: e.change };
  }

  /**
   * Use an approval for one execution. Returns the approval id only when an approved, unused approval exists
   * for this task with exactly this fingerprint. It cannot be used again.
   */
  consume(taskId: string, fingerprint: string): string | null {
    for (const e of this.entries.values()) {
      if (e.taskId === taskId && e.status === "approved" && e.request.fingerprint === fingerprint) {
        e.status = "consumed";
        return e.request.id;
      }
    }
    return null;
  }

  /** True when the task has an approved-but-unused approval whose fingerprint differs (the action changed). */
  hasStaleApproval(taskId: string, fingerprint: string): boolean {
    return [...this.entries.values()].some((e) => e.taskId === taskId && e.status === "approved" && e.request.fingerprint !== fingerprint);
  }

  /** Drop approvals that were not used, e.g. when the task stops. */
  revokeTask(taskId: string): void {
    for (const e of this.entries.values()) {
      if (e.taskId === taskId && (e.status === "approved" || e.status === "pending")) e.status = "superseded";
    }
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return this.entries.get(approvalId)?.request;
  }

  pending(taskId: string): ApprovalRequest | undefined {
    for (const e of this.entries.values()) if (e.taskId === taskId && e.status === "pending") return e.request;
    return undefined;
  }
}
