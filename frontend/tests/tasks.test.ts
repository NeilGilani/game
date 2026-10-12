import { describe, expect, it } from "vitest";
import type { AgentEvent, ApprovalRequest, TaskRequest } from "../src/state/contracts";
import { FakeAgent, scriptFor, withPlan } from "../src/state/fakeAgent";
import {
  answered,
  decided,
  isFinished,
  needsPerson,
  newTask,
  progressText,
  reduceTask,
} from "../src/state/tasks";

const request: TaskRequest = {
  id: "t1",
  goal: "Order pad thai",
  origin: "flow",
  selections: { kind: "food", restaurant: "Thai Basil", dish: "Pad thai", price: "$24.80" },
  dryRun: true,
};

const approval: ApprovalRequest = {
  id: "t1.a1",
  kind: "purchase",
  summary: "Pay $24.80",
  details: { Amount: "$24.80" },
  fingerprint: "abc",
  simulated: true,
};

describe("the task view follows the agent's events", () => {
  it("plan, steps, question, approval, done", () => {
    let t = newTask(request, 0);
    const events: AgentEvent[] = [
      { type: "task.started", taskId: "t1", goal: "Order pad thai", dryRun: true },
      {
        type: "task.plan",
        taskId: "t1",
        steps: [
          { id: "s1", title: "Open", risk: "read", status: "pending" },
          { id: "s2", title: "Pay", risk: "consequential", status: "pending" },
        ],
      },
      { type: "task.step", taskId: "t1", stepId: "s1", status: "done", summary: "Opened", evidence: "url" },
    ];
    for (const e of events) t = reduceTask(t, e, 1);
    expect(t.phase).toBe("working");
    expect(t.steps.map((s) => s.status)).toEqual(["done", "pending"]);
    expect(t.notes.s1).toEqual({ summary: "Opened", evidence: "url" });
    expect(progressText(t)).toBe("1 of 2 steps done");

    t = reduceTask(
      t,
      { type: "task.question", taskId: "t1", question: { id: "q", prompt: "Spicy?", options: [] } },
      2,
    );
    expect(t.phase).toBe("question");
    expect(needsPerson(t)).toBe(true);
    t = answered(t, 3);
    expect(t.phase).toBe("working");

    t = reduceTask(t, { type: "approval.required", taskId: "t1", approval }, 4);
    expect(t.phase).toBe("approval");
    expect(t.approval).toBe(approval);
    // A step event while waiting doesn't hide the approval.
    t = reduceTask(
      t,
      { type: "task.step", taskId: "t1", stepId: "s2", status: "waiting", summary: "Waiting" },
      5,
    );
    expect(t.phase).toBe("approval");
    t = decided(t, "approve", 6);
    expect(t.approval).toBeNull();
    expect(t.decided).toEqual([{ approval, decision: "approve" }]);

    t = reduceTask(
      t,
      { type: "task.done", taskId: "t1", outcome: "Ordered", verified: true, evidence: "SIM-1" },
      7,
    );
    expect(t.phase).toBe("done");
    expect(t.outcome).toEqual({ text: "Ordered", verified: true, evidence: "SIM-1" });
    expect(isFinished(t)).toBe(true);
    // Late events after the end are ignored.
    expect(
      reduceTask(
        t,
        { type: "task.question", taskId: "t1", question: { id: "x", prompt: "?", options: [] } },
        8,
      ),
    ).toBe(t);
  });

  it("ignores other tasks' events, and reports failures and stops", () => {
    const t = newTask(request, 0);
    expect(reduceTask(t, { type: "task.stopped", taskId: "other", by: "person" }, 1)).toBe(t);
    const failed = reduceTask(t, { type: "task.failed", taskId: "t1", reason: "No", recoverable: true }, 1);
    expect(failed.phase).toBe("failed");
    expect(needsPerson(failed)).toBe(true);
    const stopped = reduceTask(t, { type: "task.stopped", taskId: "t1", by: "caregiver" }, 1);
    expect(stopped).toMatchObject({ phase: "stopped", stoppedBy: "caregiver" });
  });

  it("a pause while the plan is being made holds when the plan arrives", () => {
    const started: AgentEvent = { type: "task.started", taskId: "t1", goal: "Order pad thai", dryRun: true };
    const paused = { ...newTask(request, 0), phase: "paused" as const };
    expect(reduceTask(paused, started, 1).phase).toBe("paused");
    expect(reduceTask(newTask(request, 0), started, 1).phase).toBe("working");
  });

  it("an unverified result stays unverified", () => {
    const t = reduceTask(
      newTask(request, 0),
      { type: "task.done", taskId: "t1", outcome: "Sent?", verified: false },
      1,
    );
    expect(t.outcome).toEqual({ text: "Sent?", verified: false });
  });
});

function collect(agent: FakeAgent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.onEvent((e) => events.push(e));
  return events;
}

async function until(events: AgentEvent[], type: AgentEvent["type"], count = 1): Promise<AgentEvent> {
  for (let i = 0; i < 400; i++) {
    const found = events.filter((e) => e.type === type);
    if (found.length >= count) return found[count - 1]!;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`no ${type} (saw ${events.map((e) => e.type).join(", ")})`);
}

describe("the fake agent keeps the safety rules", () => {
  it("only an approval with the exact fingerprint goes through, and the result is labelled simulated", async () => {
    const agent = new FakeAgent(1);
    const events = collect(agent);
    agent.send({ type: "task.start", request });
    const q = await until(events, "task.question");
    if (q.type !== "task.question") throw new Error();
    agent.send({ type: "task.answer", taskId: "t1", questionId: q.question.id, optionId: "mild" });
    const req = await until(events, "approval.required");
    if (req.type !== "approval.required") throw new Error();
    expect(req.approval.simulated).toBe(true);
    expect(req.approval.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(req.approval.details["How spicy"]).toBe("Mild");

    agent.send({
      type: "approval.decide",
      taskId: "t1",
      decision: { approvalId: req.approval.id, fingerprint: "wrong", decision: "approve" },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(events.some((e) => e.type === "task.done")).toBe(false);

    agent.send({
      type: "approval.decide",
      taskId: "t1",
      decision: { approvalId: req.approval.id, fingerprint: req.approval.fingerprint, decision: "approve" },
    });
    const done = await until(events, "task.done");
    expect(done).toMatchObject({ verified: true });
    if (done.type === "task.done") expect(done.evidence).toMatch(/simulated/);
  });

  it("declining does nothing and can be retried; change issues a new fingerprint", async () => {
    const agent = new FakeAgent(1);
    const events = collect(agent);
    agent.send({
      type: "task.start",
      request: { ...request, selections: { ...request.selections, spice: "mild" } },
    });
    const first = await until(events, "approval.required");
    if (first.type !== "approval.required") throw new Error();
    agent.send({
      type: "approval.decide",
      taskId: "t1",
      decision: {
        approvalId: first.approval.id,
        fingerprint: first.approval.fingerprint,
        decision: "change",
      },
    });
    const which = await until(events, "task.question");
    if (which.type !== "task.question") throw new Error();
    expect(which.question.prompt).toBe("What do you want to change?");
    agent.send({ type: "task.answer", taskId: "t1", questionId: which.question.id, optionId: "Deliver to" });
    const value = await until(events, "task.question", 2);
    if (value.type !== "task.question") throw new Error();
    agent.send({
      type: "task.answer",
      taskId: "t1",
      questionId: value.question.id,
      optionId: value.question.options[0]!.id,
    });
    const second = await until(events, "approval.required", 2);
    if (second.type !== "approval.required") throw new Error();
    expect(second.approval.details["Deliver to"]).toBe("Front desk");
    expect(second.approval.fingerprint).not.toBe(first.approval.fingerprint);
    // The old approval no longer counts.
    agent.send({
      type: "approval.decide",
      taskId: "t1",
      decision: {
        approvalId: first.approval.id,
        fingerprint: first.approval.fingerprint,
        decision: "approve",
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(events.some((e) => e.type === "task.done")).toBe(false);
    agent.send({
      type: "approval.decide",
      taskId: "t1",
      decision: {
        approvalId: second.approval.id,
        fingerprint: second.approval.fingerprint,
        decision: "decline",
      },
    });
    const failed = await until(events, "task.failed");
    expect(failed).toMatchObject({ recoverable: true, reason: expect.stringContaining("Nothing was paid") });
  });

  it("Stop ends the task at once, even while it waits for an approval", async () => {
    const agent = new FakeAgent(1);
    const events = collect(agent);
    agent.send({
      type: "task.start",
      request: { ...request, selections: { ...request.selections, spice: "mild" } },
    });
    await until(events, "approval.required");
    agent.send({ type: "stop.all" });
    await until(events, "task.stopped");
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === "task.stopped")).toHaveLength(1);
    expect(events.some((e) => e.type === "task.done" || e.type === "task.failed")).toBe(false);
  });

  it("Change on an approval with nothing to change doesn't report that the person said no", async () => {
    const agent = new FakeAgent(1);
    const events = collect(agent);
    agent.send({
      type: "task.start",
      request: {
        id: "m1",
        goal: "Message Mom",
        origin: "flow",
        selections: { kind: "message", person: "Mom" },
      },
    });
    const req = await until(events, "approval.required");
    if (req.type !== "approval.required") throw new Error();
    agent.send({
      type: "approval.decide",
      taskId: "m1",
      decision: { approvalId: req.approval.id, fingerprint: req.approval.fingerprint, decision: "change" },
    });
    const failed = await until(events, "task.failed");
    if (failed.type !== "task.failed") throw new Error();
    expect(failed.reason).not.toMatch(/You said no/);
    expect(failed.reason).toMatch(/Nothing here can be changed.*Nothing was sent/);
    expect(events.some((e) => e.type === "task.done")).toBe(false);
  });

  it("a cloud plan is only used when its consequential steps are exactly the ones the person approves", () => {
    const food = scriptFor(request);
    const watch = scriptFor({ id: "w", goal: "Watch", origin: "flow", selections: { kind: "watch" } });
    const step = (risk: "read" | "reversible" | "consequential") => ({ title: risk, risk, done: risk });
    const plan = (...risks: ("read" | "reversible" | "consequential")[]) => ({
      steps: risks.map(step),
      label: "Gemini",
    });
    // One consequential step where the task has its approval: used, and the approval moves there.
    const used = withPlan(food, plan("read", "reversible", "consequential", "read"));
    expect(used.steps.map((s) => s.title)).toEqual(["read", "reversible", "consequential", "read"]);
    expect(used.approvalAt).toBe(2);
    // None, or two, where the task needs exactly one approval: the built-in plan.
    expect(withPlan(food, plan("read", "reversible"))).toBe(food);
    expect(withPlan(food, plan("consequential", "consequential", "read"))).toBe(food);
    // A consequential step in a task with no approval would run without asking: the built-in plan.
    expect(withPlan(watch, plan("read", "consequential"))).toBe(watch);
    expect(withPlan(watch, plan("reversible", "read")).steps.map((s) => s.title)).toEqual([
      "reversible",
      "read",
    ]);
  });

  it("opening things needs no approval", () => {
    const s = scriptFor({
      id: "w",
      goal: "Open YouTube",
      origin: "flow",
      selections: { kind: "watch", where: "YouTube" },
    });
    expect(s.approval).toBeUndefined();
    expect(s.steps.every((st) => st.risk !== "consequential")).toBe(true);
  });

  it("every consequential kind of task asks first", () => {
    for (const kind of ["food", "call", "message", "shopping"]) {
      const s = scriptFor({ id: "x", goal: "x", origin: "flow", selections: { kind } });
      expect(s.approval, kind).toBeDefined();
      expect(s.steps[s.approvalAt!]!.risk).toBe("consequential");
    }
    const sign = scriptFor({
      id: "x",
      goal: "x",
      origin: "flow",
      selections: { kind: "papers", action: "sign" },
    });
    expect(sign.approval?.kind).toBe("sign");
  });
});
