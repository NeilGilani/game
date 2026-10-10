/**
 * The ActionGuard is the only path from the agent to the world. Every tool that has an effect (click, type,
 * navigate, key, pack action) is wrapped so it can only run through `run()`. In order, it:
 *
 *   1. re-resolves the action from live state (the model's word about what a button says is never used),
 *   2. refuses owner-reserved actions (emergency services, real doors),
 *   3. refuses secrets (passwords, one-time codes, card numbers),
 *   4. refuses sites outside the allowlist,
 *   5. classifies risk (code + hints + claim, maximum wins),
 *   6. for consequential actions: enforces simulated-only mode and spending limits, then requires a
 *      single-use approval whose fingerprint equals the fingerprint of the action about to run,
 *   7. runs it and writes the audit entry (what, why, which approval, result).
 */

import type { ApprovalDecision, ApprovalRequest, ConsequentialKind } from "@agency/contracts";
import { ApprovalGate, fingerprintAction } from "./approvals";
import type { AuditLog } from "./audit";
import { classify, type Classification } from "./policy/classify";
import { forbiddenAction } from "./policy/forbidden";
import { isSecretField, looksLikeSecretText } from "./policy/secrets";
import { originAllowed, pageTotal, type SafetySettings } from "./policy/settings";
import type { AgentAction } from "./types";

export interface GuardContext {
  taskId: string;
  dryRun: boolean;
  /** The plan step this action belongs to, for the audit trail. */
  why?: string;
  /** Show the request to the person and resolve with their decision. No time limit. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Throws if the task was stopped; waits while paused. */
  checkpoint(): Promise<void>;
}

export type GuardOutcome<T> =
  | { status: "done"; value: T; approvalId?: string; classification: Classification }
  | { status: "refused"; reason: string }
  | { status: "declined"; reason: string }
  | { status: "change"; change: string };

export class SpendLedger {
  private readonly spends: { at: number; amount: number }[] = [];
  constructor(private readonly now: () => number = () => Date.now()) {}
  record(amount: number): void {
    this.spends.push({ at: this.now(), amount });
  }
  last24h(): number {
    const since = this.now() - 24 * 3600 * 1000;
    return this.spends.filter((s) => s.at >= since).reduce((a, s) => a + s.amount, 0);
  }
}

const KIND_VERB: Record<ConsequentialKind, string> = {
  send: "Send",
  purchase: "Pay",
  sign: "Sign",
  call: "Call",
  submit: "Submit",
  delete: "Delete",
  "share-personal-data": "Share personal information",
  "account-or-settings": "Change an account or setting",
  install: "Install",
};

/** At most this many approval rounds for one action before giving up (the page keeps changing). */
const MAX_APPROVAL_ROUNDS = 3;

export class ActionGuard {
  constructor(
    readonly gate: ApprovalGate,
    private readonly audit: AuditLog,
    private readonly settings: () => SafetySettings,
    private readonly ledger: SpendLedger = new SpendLedger(),
  ) {}

  /**
   * @param resolve builds the action from live state; called again after every wait so that an approval is
   *   checked against what is on screen now, not what was there when the person was asked.
   * @param exec performs the action. Only called when every check passed.
   */
  async run<T>(
    ctx: GuardContext,
    resolve: () => Promise<AgentAction>,
    exec: (action: AgentAction) => Promise<T>,
  ): Promise<GuardOutcome<T>> {
    for (let round = 0; round <= MAX_APPROVAL_ROUNDS; round++) {
      await ctx.checkpoint();
      const action = await resolve();
      const what = describe(action);

      const refusal = this.precheck(ctx, action);
      if (refusal) return this.refuse(ctx, action, refusal);

      const c = classify(action);
      if (c.risk !== "consequential") {
        const value = await exec(action);
        this.audit.record({
          taskId: ctx.taskId,
          kind: "action",
          message: `Did: ${what}`,
          what,
          why: ctx.why,
          result: "ok",
          data: { risk: c.risk },
        });
        return { status: "done", value, classification: c };
      }

      const kind = c.kind ?? "submit";
      const consequentialRefusal = this.checkConsequential(ctx, action, kind);
      if (consequentialRefusal) return this.refuse(ctx, action, consequentialRefusal);

      const fingerprint = fingerprintAction(ctx.taskId, action, kind);
      const approvalId = this.gate.consume(ctx.taskId, fingerprint);
      if (approvalId) {
        if (kind === "purchase") this.ledger.record(amountOf(action) ?? 0);
        const value = await exec(action);
        this.audit.record({
          taskId: ctx.taskId,
          kind: "action",
          message: `Did (approved): ${what}`,
          what,
          why: ctx.why,
          approvalId,
          fingerprint,
          result: action.target?.simulated ? "simulated" : "ok",
          data: { risk: "consequential", kind },
        });
        return { status: "done", value, approvalId, classification: c };
      }

      if (this.gate.hasStaleApproval(ctx.taskId, fingerprint)) {
        this.gate.revokeTask(ctx.taskId);
        this.audit.record({
          taskId: ctx.taskId,
          kind: "approval.stale",
          message: "Something changed after you approved, so I need to ask again.",
          what,
          fingerprint,
        });
      }
      if (round === MAX_APPROVAL_ROUNDS) break;

      const request = this.gate.open(ctx.taskId, this.buildRequest(action, kind, c, fingerprint));
      this.audit.record({
        taskId: ctx.taskId,
        kind: "approval.requested",
        message: `Asked you: ${request.summary}`,
        what,
        why: ctx.why,
        approvalId: request.id,
        fingerprint,
        result: "needs-approval",
      });
      const decision = await ctx.requestApproval(request);
      const applied = this.gate.decide(ctx.taskId, decision);
      this.audit.record({
        taskId: ctx.taskId,
        kind: "approval.decided",
        message: applied.ok ? `You chose: ${decision.decision}` : `Approval not accepted: ${applied.error}`,
        approvalId: request.id,
        fingerprint: decision.fingerprint,
      });
      if (!applied.ok) return this.refuse(ctx, action, applied.error);
      if (applied.status === "declined")
        return { status: "declined", reason: "You said no, so I did not do it." };
      if (applied.status === "changed") return { status: "change", change: applied.change ?? "something" };
      // Approved: loop to re-resolve from live state and consume only if the fingerprint still matches.
    }
    return {
      status: "refused",
      reason: "The page kept changing while I asked, so I stopped instead of guessing.",
    };
  }

  private precheck(ctx: GuardContext, action: AgentAction): string | null {
    const forbidden = forbiddenAction(action);
    if (forbidden) return forbidden.reason;

    if (action.op.endsWith(".type")) {
      if (action.target && isSecretField(action.target)) {
        return "That field is for a password, code or card number. I never type those; please hand over to your helper or use a saved sign-in.";
      }
      const secret = looksLikeSecretText(String(action.input?.text ?? ""));
      if (secret) return `That text looks like ${secret}. I never type those.`;
    }
    if (action.tier === "bridge" && action.op !== "bridge.read") {
      const origin =
        action.op === "bridge.navigate" ? safeOrigin(String(action.input?.url ?? "")) : action.target?.origin;
      if (!origin || !originAllowed(origin, this.settings().siteAllowlist)) {
        return `${origin ?? "That site"} is not on your list of allowed sites. You or your caregiver can add it in Settings.`;
      }
    }
    void ctx;
    return null;
  }

  private checkConsequential(ctx: GuardContext, action: AgentAction, kind: ConsequentialKind): string | null {
    const s = this.settings();
    if ((s.simulatedOnly || ctx.dryRun) && !action.target?.simulated) {
      return "This is set to simulated mode, so I won't do that for real. Nothing was sent, bought or changed.";
    }
    if (kind === "purchase") {
      const amount = amountOf(action);
      if (s.maxPurchase === null) return "Purchases are turned off in Settings.";
      if (amount === null) return "I couldn't read the total on the page, so I won't pay.";
      if (amount > s.maxPurchase)
        return `The total, $${amount.toFixed(2)}, is over your limit of $${s.maxPurchase.toFixed(2)}.`;
      if (s.maxPurchasePerDay !== null && this.ledger.last24h() + amount > s.maxPurchasePerDay) {
        return `That would go over your daily limit of $${s.maxPurchasePerDay.toFixed(2)}.`;
      }
    }
    if ((kind === "send" || kind === "call") && action.facts?.["AI disclosure"] === "missing") {
      return "Messages and calls I help with must say that an AI assistant helped. I'll add that note first.";
    }
    return null;
  }

  private buildRequest(
    action: AgentAction,
    kind: ConsequentialKind,
    c: Classification,
    fingerprint: string,
  ): Omit<ApprovalRequest, "id"> {
    const t = action.target ?? {};
    const details: Record<string, string> = {};
    if (t.origin) details["Where"] = t.origin;
    if (t.label) details["Button"] = t.label;
    if (typeof action.input?.text === "string") details["Text"] = action.input.text;
    if (typeof action.input?.url === "string") details["Address"] = action.input.url;
    for (const [k, v] of Object.entries(action.facts ?? {})) details[k] = v;
    for (const [k, v] of Object.entries(action.claim?.details ?? {})) if (!(k in details)) details[k] = v;
    if (action.claim?.summary) details["Agent's description"] = action.claim.summary;
    details["Why I'm asking"] = c.reason;
    const total = amountOf(action);
    const summary =
      `${KIND_VERB[kind]}` +
      (kind === "purchase" && total !== null ? ` $${total.toFixed(2)}` : "") +
      (t.label ? `: "${t.label}"` : "") +
      (t.origin ? ` on ${t.origin}` : "") +
      (t.simulated ? " (simulated)" : "") +
      ".";
    return { kind, summary, details, fingerprint, simulated: Boolean(t.simulated), preview: action.preview };
  }

  private refuse(ctx: GuardContext, action: AgentAction, reason: string): GuardOutcome<never> {
    this.audit.record({
      taskId: ctx.taskId,
      kind: "refused",
      message: `Did not do: ${describe(action)}. ${reason}`,
      what: describe(action),
      why: ctx.why,
      result: "refused",
    });
    return { status: "refused", reason };
  }
}

function amountOf(action: AgentAction): number | null {
  const fromFacts = action.facts?.["Total"] ? pageTotal(`Total ${action.facts["Total"]}`) : null;
  const claimed =
    typeof action.claim?.amount === "number" && Number.isFinite(action.claim.amount)
      ? action.claim.amount
      : null;
  if (fromFacts === null) return claimed;
  return claimed === null ? fromFacts : Math.max(fromFacts, claimed);
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function describe(action: AgentAction): string {
  const t = action.target;
  const verb = action.op.split(".").pop() ?? action.op;
  const label = t?.label ? ` "${t.label}"` : t?.point ? ` at ${t.point.join(",")}` : "";
  const where = t?.origin ? ` on ${t.origin}` : "";
  const raw = typeof action.input?.text === "string" ? action.input.text : null;
  const hidden = raw !== null && ((t && isSecretField(t)) || looksLikeSecretText(raw) !== null);
  const text = raw === null ? "" : hidden ? " text [hidden]" : ` text "${raw.slice(0, 80)}"`;
  const url = typeof action.input?.url === "string" ? ` ${action.input.url}` : "";
  return `${verb}${label}${text}${url}${where}`;
}
