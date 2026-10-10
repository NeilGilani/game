/**
 * FakeAgent: walks a scripted task through every AgentEvent the real runtime emits, so the task UI
 * (Instance 7) can be built and tested without Claude, the bridge or the native helper. It speaks exactly
 * AgentCommand / AgentEvent from @agency/contracts and enforces the same approval-fingerprint rule.
 *
 * Script ("Order my usual Friday dinner", simulated):
 *   plan (4 steps) → question: which restaurant (memory-ranked) → question: spice → approval: pay → done.
 *   Decline → task.failed (recoverable). Change → asks again what to change. Pause/resume/stop work at any point.
 */

import type { AgentCommand, AgentEvent, ApprovalRequest, ChoiceQuestion, PlanStepView, TaskRequest } from "@agency/contracts";
import { canonicalJson, sha256Hex } from "../canonical";

export interface FakeAgentOptions {
  /** Delay between scripted events, in ms. 0 for tests. */
  stepDelayMs?: number;
}

interface FakeTask {
  request: TaskRequest;
  paused: boolean;
  stopped: boolean;
  wake: (() => void) | null;
  question: { q: ChoiceQuestion; resolve: (optionId: string | null, other?: string) => void } | null;
  approval: { a: ApprovalRequest; resolve: (d: "approve" | "decline" | "change", change?: string) => void } | null;
}

const STEPS: PlanStepView[] = [
  { id: "s1", title: "Open Thai Basil", risk: "read", status: "pending" },
  { id: "s2", title: "Pick your dinner", risk: "reversible", status: "pending" },
  { id: "s3", title: "Pay with your saved card", risk: "consequential", status: "pending" },
  { id: "s4", title: "Check the order went through", risk: "read", status: "pending" },
];

export class FakeAgent {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private readonly tasks = new Map<string, FakeTask>();
  private readonly delay: number;

  constructor(opts: FakeAgentOptions = {}) {
    this.delay = opts.stepDelayMs ?? 600;
  }

  onEvent(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async handle(cmd: AgentCommand): Promise<void> {
    switch (cmd.type) {
      case "task.start":
        return this.run(cmd.request);
      case "task.answer": {
        const t = this.tasks.get(cmd.taskId);
        if (t?.question && t.question.q.id === cmd.questionId) t.question.resolve(cmd.optionId, cmd.other);
        return;
      }
      case "approval.decide": {
        const t = this.tasks.get(cmd.taskId);
        const a = t?.approval?.a;
        // Same rule as the real guard: the decision must carry the exact fingerprint that was shown.
        if (t?.approval && a && a.id === cmd.decision.approvalId && a.fingerprint === cmd.decision.fingerprint) {
          t.approval.resolve(cmd.decision.decision, cmd.decision.change);
        }
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
        for (const id of this.tasks.keys()) this.stop(id);
        return;
    }
  }

  private stop(id: string): void {
    const t = this.tasks.get(id);
    if (!t || t.stopped) return;
    t.stopped = true;
    t.wake?.();
    t.question?.resolve(null);
    t.approval?.resolve("decline");
  }

  private emit(e: AgentEvent): void {
    this.listeners.forEach((l) => l(e));
  }

  private async run(request: TaskRequest): Promise<void> {
    const t: FakeTask = { request, paused: false, stopped: false, wake: null, question: null, approval: null };
    this.tasks.set(request.id, t);
    const id = request.id;
    try {
      this.emit({ type: "task.started", taskId: id, goal: request.goal, dryRun: true });
      await this.tick(t);
      this.emit({ type: "task.plan", taskId: id, steps: STEPS.map((s) => ({ ...s })) });

      await this.step(t, "s1", "Opening Thai Basil (sandbox store)", "Thai Basil menu is showing");

      await this.tick(t);
      this.emit({ type: "task.step", taskId: id, stepId: "s2", status: "running", summary: "Choosing your dinner" });
      const dish = await this.ask(t, {
        prompt: "What would you like?",
        options: [
          { id: "pad-thai", label: "Pad thai", description: "Rice noodles, egg, peanuts. $14.50", suggestedBecause: "You chose this 4 of your last 5 Fridays." },
          { id: "green-curry", label: "Green curry", description: "With jasmine rice. $15.95" },
          { id: "drunken-noodles", label: "Drunken noodles", description: "Wide noodles, basil. $14.95" },
          { id: "something-else", label: "Something else", description: "See the whole menu" },
        ],
      });
      const spice = await this.ask(t, {
        prompt: "How spicy?",
        options: [
          { id: "mild", label: "Mild", suggestedBecause: "You always pick mild." },
          { id: "medium", label: "Medium" },
          { id: "hot", label: "Hot" },
        ],
      });
      this.emit({ type: "task.step", taskId: id, stepId: "s2", status: "done", summary: `${dish} (${spice}) is in the cart`, evidence: "Cart shows 1 item" });

      for (;;) {
        await this.tick(t);
        this.emit({ type: "task.step", taskId: id, stepId: "s3", status: "waiting", summary: "Waiting for your OK to pay" });
        const details = { Where: "Thai Basil (sandbox)", Order: `1 × ${dish} (${spice})`, Total: "$24.80", "Pay with": "Saved card ending 4242 (simulated)", "Deliver to": "Home" };
        const approval: ApprovalRequest = {
          id: `apr_fake_${id}_${Date.now().toString(36)}`,
          kind: "purchase",
          summary: `Pay $24.80 to Thai Basil for 1 ${dish} (${spice}), delivered to home (simulated).`,
          details,
          preview: { kind: "text", data: `Thai Basil — Order summary\n1 × ${dish} (${spice})  $14.50\nDelivery $5.99\nTax & fees $4.31\nTotal $24.80` },
          fingerprint: sha256Hex(canonicalJson({ fake: true, id, details })),
          simulated: true,
        };
        const decision = await new Promise<{ d: "approve" | "decline" | "change"; change?: string }>((resolve) => {
          t.approval = { a: approval, resolve: (d, change) => resolve({ d, change }) };
          this.emit({ type: "approval.required", taskId: id, approval });
        });
        t.approval = null;
        this.checkStopped(t);
        if (decision.d === "decline") {
          this.emit({ type: "task.step", taskId: id, stepId: "s3", status: "skipped", summary: "You said no. Nothing was paid." });
          this.emit({ type: "task.failed", taskId: id, reason: "You said no to paying, so nothing was ordered.", recoverable: true });
          return;
        }
        if (decision.d === "change") {
          await this.ask(t, {
            prompt: "What should be different?",
            options: [
              { id: "dish", label: "The dish" },
              { id: "address", label: "Where it goes" },
              { id: "cancel", label: "Cancel the order" },
            ],
          });
          continue;
        }
        this.emit({ type: "task.step", taskId: id, stepId: "s3", status: "done", summary: "Paid $24.80 (simulated)", evidence: "Store shows: Order #TB-1042 placed" });
        break;
      }
      await this.step(t, "s4", "Checking the order", "Order #TB-1042 confirmed, arriving in about 35 minutes");
      this.emit({ type: "task.done", taskId: id, outcome: "Your pad thai is ordered (simulated). It should arrive in about 35 minutes.", verified: true, evidence: "Store page shows Order #TB-1042 confirmed" });
    } catch (e) {
      if (e instanceof Stopped) {
        this.emit({ type: "task.stopped", taskId: id, by: "person" });
        return;
      }
      throw e;
    }
  }

  private async step(t: FakeTask, stepId: string, running: string, done: string): Promise<void> {
    await this.tick(t);
    this.emit({ type: "task.step", taskId: t.request.id, stepId, status: "running", summary: running });
    await this.tick(t);
    this.emit({ type: "task.step", taskId: t.request.id, stepId, status: "done", summary: done, evidence: done });
  }

  private async ask(t: FakeTask, q: Omit<ChoiceQuestion, "id">): Promise<string> {
    await this.tick(t);
    const question: ChoiceQuestion = { ...q, id: `q_${t.request.id}_${Math.random().toString(36).slice(2, 8)}` };
    const answer = await new Promise<string | null>((resolve) => {
      t.question = { q: question, resolve: (optionId, other) => resolve(optionId ? (q.options.find((o) => o.id === optionId)?.label ?? optionId) : (other ?? null)) };
      this.emit({ type: "task.question", taskId: t.request.id, question });
    });
    t.question = null;
    this.checkStopped(t);
    return answer ?? "";
  }

  private async tick(t: FakeTask): Promise<void> {
    this.checkStopped(t);
    if (this.delay > 0) await new Promise((r) => setTimeout(r, this.delay));
    while (t.paused && !t.stopped) await new Promise<void>((r) => (t.wake = r));
    t.wake = null;
    this.checkStopped(t);
  }

  private checkStopped(t: FakeTask): void {
    if (t.stopped) throw new Stopped();
  }
}

class Stopped extends Error {}
