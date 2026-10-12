/**
 * An in-page fake of the agent runtime (os/agent, Instance 4), used when AGENCY runs without the Mac app: in the
 * browser, in development and in tests. It speaks AgentCommand / AgentEvent from os/contracts and follows the same
 * rules as the real guard: an approval only counts with the exact fingerprint that was shown, decline means nothing
 * happens, change issues a new approval with a new fingerprint, Stop ends everything at once.
 *
 * Everything it "does" is simulated and says so, with one exception: a text or call to one of the person's real
 * saved people, once turned on in Settings (realMessaging.ts). That goes out through the Mac app, for real, and only
 * for the exact ticket the person approved.
 */
import type {
  AgentCommand,
  AgentEvent,
  ApprovalRequest,
  ChoiceOption,
  ChoiceQuestion,
  ConsequentialKind,
  PlanStepView,
  TaskRequest,
} from "./contracts";
import { realScriptFor } from "./realMessaging";

type Listener = (event: AgentEvent) => void;

export interface Script {
  steps: { title: string; risk: PlanStepView["risk"]; summary: string }[];
  /** Asked after the first step when the flow didn't already settle it. */
  question?: ChoiceQuestion;
  /** Index of the step that needs the approval (consequential). */
  approvalAt?: number;
  approval?: { kind: ConsequentialKind; summary: string; details: Record<string, string>; preview?: string };
  /** For "Change": which details can change, and to what. */
  changes?: Record<string, string[]>;
  outcome: string;
  evidence: string;
  /** Whether the result can be checked (false: AGENCY can't see whether it arrived). Default true. */
  verified?: boolean;
  /** Refuse at once with this reason (nothing is done). */
  refuse?: string;
  /** A real send (realMessaging.ts): bound to a ticket before each approval, sent only after it. */
  real?: RealHooks;
}

/** A real action behind an approval. The approval shown is the one `bind` returned; only that one can be sent. */
export interface RealHooks {
  bind(
    details: Record<string, string>,
  ): Promise<{ fingerprint: string; details: Record<string, string>; preview?: string } | { error: string }>;
  perform(
    fingerprint: string,
  ): Promise<
    { ok: true; summary: string; outcome: string; evidence: string } | { ok: false; reason: string }
  >;
  cancel(): void;
}

const NO_CHOICE = "__none__";

/** A cloud planner (the web demo's Gemini function): steps for the task, or null to keep the built-in plan. */
export type RemotePlanner = (r: TaskRequest) => Promise<{
  steps: { title: string; risk: PlanStepView["risk"]; done: string }[];
  label: string;
  /** How the planner made it fast, in plain words (shown on the plan). */
  speed?: string;
} | null>;

let remotePlanner: RemotePlanner | null = null;

/** The longest a task waits for the cloud planner before starting with the built-in plan. */
export const PLAN_WAIT_MS = 3500;

/** Let a cloud model plan the steps; the scripted approval (exact details) and practice services stay. */
export function setRemotePlanner(planner: RemotePlanner | null): void {
  remotePlanner = planner;
}

/**
 * Gemini's steps in place of the built-in ones; the approval moves to Gemini's consequential step. Every
 * consequential step must be the one the person approves, so a plan whose consequential steps don't match the
 * task's approval (one it has no approval for, more than one, or none when the task needs one) isn't used: the
 * built-in plan runs instead.
 */
export function withPlan(script: Script, plan: NonNullable<Awaited<ReturnType<RemotePlanner>>>): Script {
  const at = plan.steps.findIndex((s) => s.risk === "consequential");
  const consequential = plan.steps.filter((s) => s.risk === "consequential").length;
  if (consequential !== (script.approval ? 1 : 0)) return script;
  return {
    ...script,
    steps: plan.steps.map((s) => ({
      title: s.title,
      risk: s.risk,
      summary: s.risk === "consequential" && script.approval ? `${s.done} (practice, nothing real)` : s.done,
    })),
    ...(script.approval ? { approvalAt: at } : {}),
    question: at === 0 ? undefined : script.question,
  };
}

function sel(r: TaskRequest, key: string, fallback = ""): string {
  return r.selections?.[key] ?? fallback;
}

/** A small, honest script per kind of task. Unknown kinds get a generic one. */
export function scriptFor(r: TaskRequest): Script {
  const kind = sel(r, "kind");
  const ref = `SIM-${1000 + Math.floor(Math.random() * 9000)}`;
  if (kind === "food") {
    const place = sel(r, "restaurant", "the restaurant");
    const dish = sel(r, "dish", "your usual");
    const price = sel(r, "price", "$24.80");
    return {
      steps: [
        {
          title: `Open ${place} on the sandbox store`,
          risk: "read",
          summary: `Opened ${place} (sandbox store, simulated).`,
        },
        { title: `Put ${dish} in the basket`, risk: "reversible", summary: `${dish} is in the basket.` },
        { title: "Pay with your saved payment method", risk: "consequential", summary: "Paid (simulated)." },
        { title: "Check the order went through", risk: "read", summary: `The store shows order ${ref}.` },
      ],
      question: r.selections?.spice
        ? undefined
        : {
            id: "spice",
            prompt: "How spicy?",
            options: [
              { id: "mild", label: "Mild", suggestedBecause: "What you usually choose" },
              { id: "medium", label: "Medium" },
              { id: "none", label: "Not spicy" },
            ],
          },
      approvalAt: 2,
      approval: {
        kind: "purchase",
        summary: `Pay ${price} to ${place} for ${dish}, delivered to home.`,
        details: {
          Amount: price,
          To: place,
          Order: dish,
          "Deliver to": "Home",
          "Pay with": "Your saved payment method in the store",
        },
        preview: `${place}\n1 × ${dish}\nTotal ${price}\nDeliver to: Home`,
      },
      changes: { "Deliver to": ["Home", "Front desk"], Order: [dish, `2 × ${dish}`] },
      outcome: `Ordered ${dish} from ${place}. It should arrive in about 35 minutes.`,
      evidence: `Order ${ref} on the sandbox store (simulated: no real order or payment).`,
    };
  }
  if (kind === "call") {
    const who = sel(r, "person", "them");
    const reason = sel(r, "reason", "to talk");
    return {
      steps: [
        { title: `Find ${who}'s number`, risk: "read", summary: `Found ${who} in your contacts.` },
        { title: `Call ${who}`, risk: "consequential", summary: `Called ${who} (simulated phone).` },
        { title: "Check the call connected", risk: "read", summary: "The simulated phone answered." },
      ],
      approvalAt: 1,
      approval: {
        kind: "call",
        summary: `Call ${who} now. You talk by choosing what to say; your voice is a synthetic voice, and AGENCY tells ${who} that at the start.`,
        details: {
          Who: who,
          Number: sel(r, "number", "From your contacts"),
          About: reason,
          Voice: "Synthetic voice (disclosed)",
        },
      },
      outcome: `${who} answered. The call is simulated in this build.`,
      evidence: `Simulated call log ${ref}.`,
    };
  }
  if (kind === "message") {
    const who = sel(r, "person", "them");
    const text = sel(r, "text", "Hello");
    return {
      steps: [
        { title: "Write the message", risk: "reversible", summary: "Message written." },
        { title: `Send it to ${who}`, risk: "consequential", summary: `Sent to ${who} (simulated).` },
        { title: "Check it was delivered", risk: "read", summary: "Delivered (simulated)." },
      ],
      approvalAt: 1,
      approval: {
        kind: "send",
        summary: `Send this message to ${who}.`,
        details: { To: who, Message: text, Using: sel(r, "app", "Messages") },
        preview: text,
      },
      outcome: `Your message to ${who} was delivered.`,
      evidence: `Simulated delivery receipt ${ref}.`,
    };
  }
  if (kind === "shopping") {
    const item = sel(r, "product", "the item");
    const price = sel(r, "price", "$19.99");
    const store = sel(r, "store", "the sandbox store");
    return {
      steps: [
        { title: `Open ${store}`, risk: "read", summary: `Opened ${store} (simulated).` },
        { title: `Add ${item} to the basket`, risk: "reversible", summary: `${item} is in the basket.` },
        { title: "Pay with your saved payment method", risk: "consequential", summary: "Paid (simulated)." },
        { title: "Check the order", risk: "read", summary: `The store shows order ${ref}.` },
      ],
      approvalAt: 2,
      approval: {
        kind: "purchase",
        summary: `Buy ${item} for ${price} from ${store}, delivered to home.`,
        details: {
          Amount: price,
          Item: item,
          From: store,
          "Deliver to": "Home",
          "Pay with": "Your saved payment method in the store",
        },
      },
      changes: { "Deliver to": ["Home", "Front desk"] },
      outcome: `Bought ${item}. Delivery is expected in 2 days.`,
      evidence: `Order ${ref} on the sandbox store (simulated: no real order or payment).`,
    };
  }
  if (kind === "papers") {
    const doc = sel(r, "document", "the letter");
    const action = sel(r, "action", "explain");
    if (action === "explain") {
      return {
        steps: [
          { title: `Read ${doc}`, risk: "read", summary: `Read ${doc}.` },
          { title: "Explain it in plain words", risk: "read", summary: "Wrote a short explanation." },
        ],
        outcome: `${doc}: they need your updated address by the end of the month. Nothing was sent.`,
        evidence: "Explanation written from the document (demo document).",
      };
    }
    return {
      steps: [
        { title: `Open ${doc}`, risk: "read", summary: `Opened ${doc}.` },
        {
          title: "Fill in what AGENCY knows",
          risk: "reversible",
          summary: "Filled 6 fields from your details.",
        },
        {
          title: action === "sign" ? "Sign it" : "Submit it",
          risk: "consequential",
          summary: "Done (simulated).",
        },
        { title: "Check it was received", risk: "read", summary: `Received, reference ${ref}.` },
      ],
      approvalAt: 2,
      approval: {
        kind: action === "sign" ? "sign" : "submit",
        summary: `${action === "sign" ? "Sign" : "Submit"} ${doc} with the details shown.`,
        details: {
          Document: doc,
          Name: "Riley Example",
          Address: "12 Demo Street",
          "Sent to": sel(r, "to", "The office named on the form"),
        },
        preview: `${doc}\nName: Riley Example\nAddress: 12 Demo Street\nSigned: Riley Example`,
      },
      outcome: `${doc} was ${action === "sign" ? "signed" : "submitted"}.`,
      evidence: `Receipt ${ref} from the demo office (simulated).`,
    };
  }
  // Watching, browsing and apps: opening things is reversible, so no approval.
  const where = sel(r, "where", sel(r, "app", "it"));
  return {
    steps: [
      { title: `Open ${where}`, risk: "reversible", summary: `Opened ${where} (simulated).` },
      { title: "Check it's on screen", risk: "read", summary: `${where} is showing.` },
    ],
    outcome: `${r.goal}: done.`,
    evidence: `${where} is on screen (simulated in the browser; the Mac app opens it for real).`,
  };
}

async function fingerprint(kind: string, details: Record<string, string>): Promise<string> {
  const canonical = JSON.stringify([
    kind,
    Object.keys(details)
      .sort()
      .map((k) => [k, details[k]]),
  ]);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return `fp-${canonical.length}-${canonical}`;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Running {
  request: TaskRequest;
  stopped: boolean;
  paused: boolean;
  wake: (() => void) | null;
  answer: ((optionId: string | null) => void) | null;
  questionId: string | null;
  decide: ((d: "approve" | "decline" | "change", change?: string) => void) | null;
  approval: ApprovalRequest | null;
  /** The approval the person approved, and why a real one couldn't be prepared. */
  approved?: ApprovalRequest;
  refusal?: string;
}

export class FakeAgent {
  private listeners = new Set<Listener>();
  private tasks = new Map<string, Running>();

  constructor(private delayMs = 450) {}

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(cmd: AgentCommand): void {
    switch (cmd.type) {
      case "task.start":
        void this.run(cmd.request);
        return;
      case "task.answer": {
        const t = this.tasks.get(cmd.taskId);
        if (t?.answer && t.questionId === cmd.questionId) t.answer(cmd.optionId);
        return;
      }
      case "approval.decide": {
        const t = this.tasks.get(cmd.taskId);
        // The decision only counts for the exact action that was shown.
        if (
          t?.decide &&
          t.approval?.id === cmd.decision.approvalId &&
          t.approval.fingerprint === cmd.decision.fingerprint
        )
          t.decide(cmd.decision.decision, cmd.decision.change);
        return;
      }
      case "task.pause": {
        const t = this.tasks.get(cmd.taskId);
        if (t) t.paused = true;
        return;
      }
      case "task.resume": {
        const t = this.tasks.get(cmd.taskId);
        if (t) {
          t.paused = false;
          t.wake?.();
        }
        return;
      }
      case "task.stop":
        this.stop(cmd.taskId);
        return;
      case "stop.all":
        for (const id of [...this.tasks.keys()]) this.stop(id);
        return;
    }
  }

  private emit(e: AgentEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  private stop(id: string): void {
    const t = this.tasks.get(id);
    if (!t || t.stopped) return;
    t.stopped = true;
    this.emit({ type: "task.stopped", taskId: id, by: "person" });
    t.wake?.();
    t.answer?.(NO_CHOICE);
    t.decide?.("decline");
    this.tasks.delete(id);
  }

  /** Wait, respecting pause and stop. Resolves false when the task was stopped. */
  private async tick(t: Running): Promise<boolean> {
    await new Promise<void>((r) => {
      const timer = setTimeout(r, this.delayMs);
      t.wake = () => {
        clearTimeout(timer);
        r();
      };
    });
    while (t.paused && !t.stopped) await new Promise<void>((r) => (t.wake = r));
    t.wake = null;
    return !t.stopped;
  }

  private ask(t: Running, q: ChoiceQuestion): Promise<string | null> {
    return new Promise((resolve) => {
      t.questionId = q.id;
      t.answer = (optionId) => {
        t.answer = null;
        t.questionId = null;
        resolve(optionId === NO_CHOICE ? null : optionId);
      };
      this.emit({ type: "task.question", taskId: t.request.id, question: q });
    });
  }

  private async run(request: TaskRequest): Promise<void> {
    const id = request.id;
    if (this.tasks.has(id)) return;
    const t: Running = {
      request,
      stopped: false,
      paused: false,
      wake: null,
      answer: null,
      questionId: null,
      decide: null,
      approval: null,
    };
    this.tasks.set(id, t);
    const real = realScriptFor(request);
    let script = real ? await real : scriptFor(request);
    if (t.stopped) return;
    if (script.refuse) {
      this.emit({ type: "task.started", taskId: id, goal: request.goal, dryRun: false });
      this.emit({ type: "task.failed", taskId: id, reason: script.refuse, recoverable: false });
      this.tasks.delete(id);
      return;
    }
    let planNote: string | null = null;
    // A real send keeps its own plain plan: the cloud planner only plans practice tasks.
    if (remotePlanner && !script.real) {
      const started = performance.now();
      // Never keep the person waiting on the cloud: if Gemini hasn't planned within a few seconds (busy, slow
      // network), the built-in plan starts at once. A task chosen before comes back from Synapse's cache instantly.
      const plan = await Promise.race([
        remotePlanner(request).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), PLAN_WAIT_MS)),
      ]);
      if (t.stopped) return;
      if (plan) {
        script = withPlan(script, plan);
        planNote =
          plan.speed ??
          `Planned live by ${plan.label} in ${((performance.now() - started) / 1000).toFixed(1)} s.`;
        planNote += " Practice services carry it out.";
      } else {
        planNote = `Built-in plan: Gemini didn't answer within ${PLAN_WAIT_MS / 1000} s, so AGENCY didn't wait.`;
      }
    }
    const steps: PlanStepView[] = script.steps.map((s, i) => ({
      id: `s${i + 1}`,
      title: s.title,
      risk: s.risk,
      status: "pending",
    }));
    this.emit({
      type: "task.started",
      taskId: id,
      goal: request.goal,
      dryRun: script.real ? false : (request.dryRun ?? true),
    });
    this.emit({ type: "task.plan", taskId: id, steps });
    if (planNote)
      this.emit({
        type: "task.step",
        taskId: id,
        stepId: "synapse:route",
        status: "done",
        summary: planNote,
      });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const s = script.steps[i]!;
      if (!(await this.tick(t))) return;
      this.emit({ type: "task.step", taskId: id, stepId: step.id, status: "running", summary: s.title });

      if (i === script.approvalAt && script.approval) {
        const result = await this.approve(t, script);
        if (result !== "approved") script.real?.cancel();
        if (result === "refused" && !t.stopped) {
          this.emit({
            type: "task.step",
            taskId: id,
            stepId: step.id,
            status: "failed",
            summary: "Not sent.",
          });
          this.emit({
            type: "task.failed",
            taskId: id,
            reason: t.refusal ?? "Nothing was sent.",
            recoverable: true,
          });
          this.tasks.delete(id);
          return;
        }
        if (result !== "approved") {
          if (t.stopped) return;
          // Change on something with nothing to change isn't a no: say what really happened.
          const fixed = result === "unchangeable";
          this.emit({
            type: "task.step",
            taskId: id,
            stepId: step.id,
            status: "skipped",
            summary: fixed ? "Nothing here can be changed." : "You said no.",
          });
          this.emit({
            type: "task.failed",
            taskId: id,
            reason: `${fixed ? "Nothing here can be changed, so nothing was done. Start again from Home to choose differently." : "You said no, so nothing was done."} ${script.approval.kind === "purchase" ? "Nothing was paid." : "Nothing was sent."}`,
            recoverable: true,
          });
          this.tasks.delete(id);
          return;
        }
      }
      if (i === script.approvalAt && script.real && t.approved) {
        if (t.stopped) return;
        const done = await script.real.perform(t.approved.fingerprint);
        if (t.stopped) return;
        if (!done.ok) {
          this.emit({
            type: "task.step",
            taskId: id,
            stepId: step.id,
            status: "failed",
            summary: "Not sent.",
          });
          this.emit({ type: "task.failed", taskId: id, reason: done.reason, recoverable: true });
          this.tasks.delete(id);
          return;
        }
        s.summary = done.summary;
        script = { ...script, outcome: done.outcome, evidence: done.evidence };
      }
      if (!(await this.tick(t))) return;
      this.emit({ type: "task.step", taskId: id, stepId: step.id, status: "done", summary: s.summary });

      if (i === 0 && script.question) {
        const choice = await this.ask(t, script.question);
        if (t.stopped) return;
        const label = script.question.options.find((o) => o.id === choice)?.label;
        if (label && script.approval)
          script.approval.details[script.question.prompt.replace(/\?$/, "")] = label;
      }
    }
    if (!(await this.tick(t))) return;
    this.emit({
      type: "task.done",
      taskId: id,
      outcome: script.outcome,
      verified: script.verified ?? true,
      evidence: script.evidence,
    });
    this.tasks.delete(id);
  }

  private async approve(
    t: Running,
    script: Script,
  ): Promise<"approved" | "declined" | "unchangeable" | "refused"> {
    const base = script.approval!;
    let details = { ...base.details };
    for (let round = 1; round <= 5; round++) {
      let fp = await fingerprint(base.kind, details);
      let preview = base.preview;
      if (script.real) {
        // The Mac app makes the ticket for exactly these details; its fingerprint is the one shown and approved.
        const bound = await script.real.bind(details);
        if (t.stopped) return "declined";
        if ("error" in bound) {
          t.refusal = bound.error;
          return "refused";
        }
        details = bound.details;
        fp = bound.fingerprint;
        if (bound.preview !== undefined) preview = bound.preview;
      }
      const approval: ApprovalRequest = {
        id: `${t.request.id}.a${round}`,
        kind: base.kind,
        summary: base.summary,
        details,
        fingerprint: fp,
        simulated: !script.real,
        ...(preview ? { preview: { kind: "text" as const, data: preview } } : {}),
      };
      t.approval = approval;
      const decision = await new Promise<{ d: "approve" | "decline" | "change"; change?: string }>(
        (resolve) => {
          t.decide = (d, change) => {
            t.decide = null;
            resolve(change ? { d, change } : { d });
          };
          this.emit({ type: "approval.required", taskId: t.request.id, approval });
        },
      );
      t.approval = null;
      if (t.stopped || decision.d === "decline") return "declined";
      if (decision.d === "approve") {
        t.approved = approval;
        return "approved";
      }
      // Change: ask which detail, then the new value. The next approval has a new fingerprint.
      const changeable = Object.keys(script.changes ?? {});
      let field = decision.change && changeable.includes(decision.change) ? decision.change : null;
      if (!field) {
        if (!changeable.length) return "unchangeable";
        const which = await this.ask(t, {
          id: `change-${round}`,
          prompt: "What do you want to change?",
          options: changeable.map((k) => ({ id: k, label: k, description: `Now: ${details[k] ?? "–"}` })),
        });
        if (t.stopped || !which) return "declined";
        field = which;
      }
      const values = (script.changes?.[field] ?? []).filter((v) => v !== details[field]);
      const options: ChoiceOption[] = values.map((v, i) => ({ id: `v${i}`, label: v }));
      if (!options.length) continue;
      const picked = await this.ask(t, { id: `value-${round}`, prompt: `${field}: what instead?`, options });
      if (t.stopped) return "declined";
      const value = options.find((o) => o.id === picked)?.label;
      if (value) details = { ...details, [field]: value };
    }
    return "declined";
  }
}
