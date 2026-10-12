import type { AgentEvent } from "@agency/contracts";
import { describe, expect, it } from "vitest";
import { CONS, cu, REV, turn } from "../evals/harness";
import { FakeNative } from "../evals/world/fakeNative";
import { SandboxWeb, SITES } from "../evals/world/sandboxWeb";
import { FakeMemoryClient, rankWithMemory, surfaceFor } from "../src/memory";
import { ScriptedModel, type ScriptTurn } from "../src/model/scripted";
import type { AgentModel, ToolOutput } from "../src/model/types";
import { AgentRuntime, type RuntimeDeps } from "../src/runtime/runtime";
import { DEFAULT_BUDGETS, TaskRun, TaskStopped, withActiveTimeout } from "../src/runtime/task";

const tick = () => new Promise((r) => setTimeout(r, 0));

function runtimeWith(model: AgentModel | null, extra: Partial<RuntimeDeps> = {}) {
  const web = new SandboxWeb();
  const rt = new AgentRuntime({ model, bridge: web, native: null, memory: null, packs: [], ...extra });
  const events: AgentEvent[] = [];
  rt.onEvent((e) => events.push(e));
  return { rt, web, events };
}

const script = (...turns: ScriptTurn[]) => new ScriptedModel(turns);

describe("TaskRun", () => {
  it("waits at the checkpoint while paused and throws once stopped", async () => {
    const t = new TaskRun({ id: "t", goal: "g", origin: "home" }, DEFAULT_BUDGETS, () => undefined);
    t.pause();
    let passed = false;
    const p = t.checkpoint().then(() => (passed = true));
    await tick();
    expect(passed).toBe(false);
    t.resume();
    await p;
    expect(passed).toBe(true);
    t.stop("caregiver");
    await expect(t.checkpoint()).rejects.toBeInstanceOf(TaskStopped);
  });

  it("only accepts answers for the open question and its options", async () => {
    const events: AgentEvent[] = [];
    const t = new TaskRun({ id: "t", goal: "g", origin: "home" }, DEFAULT_BUDGETS, (e) => events.push(e));
    const p = t.ask({
      prompt: "Which?",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    await tick();
    const q = events.find((e) => e.type === "task.question");
    if (q?.type !== "task.question") throw new Error("no question");
    expect(t.answer("wrong-id", "a")).toBe(false);
    expect(t.answer(q.question.id, "zzz")).toBe(false);
    expect(t.answer(q.question.id, null, "free text")).toBe(false); // allowOther is off
    expect(t.answer(q.question.id, "b")).toBe(true);
    await expect(p).resolves.toEqual({ optionId: "b", other: undefined });
  });

  it("enforces the action and turn budgets", () => {
    const t = new TaskRun(
      { id: "t", goal: "g", origin: "home" },
      { ...DEFAULT_BUDGETS, maxActions: 1, maxModelTurns: 1 },
      () => undefined,
    );
    t.countAction();
    expect(() => t.countAction()).toThrow(/limit/);
    t.countModelTurn();
    expect(() => t.countModelTurn()).toThrow(/limit/);
  });
});

describe("AgentRuntime", () => {
  it("emits the contract's event sequence for a full task", async () => {
    const model = script(
      turn(["show_plan", { steps: [{ title: "Ask for refill", risk: "consequential" }] }]),
      turn(
        ["open_url", { url: `${SITES.PHARMACY}/refills` }],
        ["click_element", { ref: "rx1", ...REV }],
        ["click_element", { ref: "req", ...CONS("submit", "Refill") }],
      ),
      turn(["finish", { outcome: "Done", expect_text: "Refill request received" }]),
    );
    const { rt, events } = runtimeWith(model);
    rt.onEvent((e) => {
      if (e.type === "approval.required")
        queueMicrotask(
          () =>
            void rt.handle({
              type: "approval.decide",
              taskId: "t1",
              decision: {
                approvalId: e.approval.id,
                fingerprint: e.approval.fingerprint,
                decision: "approve",
              },
            }),
        );
    });
    await rt.handle({ type: "task.start", request: { id: "t1", goal: "Refill", origin: "home" } });
    expect(events.map((e) => e.type)).toEqual([
      "task.started",
      "task.plan",
      "approval.required",
      "task.step",
      "task.done",
    ]);
    expect(events[0]).toMatchObject({ dryRun: true });
    expect(events.at(-1)).toMatchObject({ type: "task.done", verified: true });
  });

  it("a slow approval is never a timeout: the action runs once, in step with the model", async () => {
    const model = script(
      turn(["show_plan", { steps: [{ title: "Ask for refill", risk: "consequential" }] }]),
      turn(
        ["open_url", { url: `${SITES.PHARMACY}/refills` }],
        ["click_element", { ref: "rx1", ...REV }],
        ["click_element", { ref: "req", ...CONS("submit", "Refill") }],
      ),
      turn(["finish", { outcome: "Done", expect_text: "Refill request received" }]),
    );
    // Tool calls may take 50 ms of the agent's own time; the person takes 300 ms to decide (minutes in real life).
    const { rt, web, events } = runtimeWith(model, { budgets: { toolTimeoutMs: 50 } });
    rt.onEvent((e) => {
      if (e.type === "approval.required")
        setTimeout(
          () =>
            void rt.handle({
              type: "approval.decide",
              taskId: "slow",
              decision: {
                approvalId: e.approval.id,
                fingerprint: e.approval.fingerprint,
                decision: "approve",
              },
            }),
          300,
        );
    });
    await rt.handle({ type: "task.start", request: { id: "slow", goal: "Refill", origin: "home" } });
    expect(events.at(-1)).toMatchObject({ type: "task.done", verified: true });
    const outputs = model.inputs;
    expect(JSON.stringify(outputs)).not.toMatch(/took longer/);
    expect(web.effects).toHaveLength(1);
  });

  it("a pause doesn't count against the time a tool call may take", async () => {
    const t = new TaskRun({ id: "p", goal: "g", origin: "home" }, DEFAULT_BUDGETS, () => undefined);
    t.pause();
    const work = (async () => {
      await t.checkpoint(); // waits while paused, like an action would
      return "done";
    })();
    const timed = withActiveTimeout(t, work, 50, "click");
    await new Promise((r) => setTimeout(r, 200));
    t.resume();
    await expect(timed).resolves.toBe("done");
    // Its own time still counts.
    await expect(withActiveTimeout(t, new Promise(() => undefined), 50, "click")).rejects.toThrow(
      /took longer/,
    );
  });

  it("stop during an approval wait ends the task, revokes the request and does nothing", async () => {
    const model = script(
      turn(["show_plan", { steps: [{ title: "Refill", risk: "consequential" }] }]),
      turn(
        ["open_url", { url: `${SITES.PHARMACY}/refills` }],
        ["click_element", { ref: "rx1", ...REV }],
        ["click_element", { ref: "req", ...CONS("submit", "Refill") }],
      ),
    );
    const native = new FakeNative();
    const { rt, web, events } = runtimeWith(model, { native });
    let approval: { id: string; fingerprint: string } | null = null;
    rt.onEvent((e) => {
      if (e.type === "approval.required") {
        approval = e.approval;
        queueMicrotask(() => void rt.handle({ type: "stop.all" }));
      }
    });
    await rt.handle({ type: "task.start", request: { id: "t2", goal: "Refill", origin: "home" } });
    expect(events.at(-1)).toEqual({ type: "task.stopped", taskId: "t2", by: "person" });
    expect(web.effects).toHaveLength(0);
    expect(native.stopAllCalls).toBe(1);
    // A late approval for the stopped task is ignored.
    await rt.handle({
      type: "approval.decide",
      taskId: "t2",
      decision: { approvalId: approval!.id, fingerprint: approval!.fingerprint, decision: "approve" },
    });
    expect(web.effects).toHaveLength(0);
  });

  it("pause holds the task before the next step until resume", async () => {
    const model = script(
      turn(["show_plan", { steps: [{ title: "Look", risk: "read" }] }]),
      turn(["open_url", { url: `${SITES.STORE}/menu` }]),
      turn(["finish", { outcome: "ok", expect_text: "Thai Basil — Menu" }]),
    );
    const { rt, events } = runtimeWith(model);
    rt.onEvent((e) => {
      if (e.type === "task.plan") void rt.handle({ type: "task.pause", taskId: "t3" });
    });
    const done = rt.handle({ type: "task.start", request: { id: "t3", goal: "Look", origin: "home" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(model.turns).toBe(1);
    expect(events.some((e) => e.type === "task.done")).toBe(false);
    await rt.handle({ type: "task.resume", taskId: "t3" });
    await done;
    expect(model.turns).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: "task.done", verified: true });
  });

  it("puts goal and selections in the first message, and only a few memory suggestions", async () => {
    const model = script(turn(["give_up", { reason: "test" }]));
    const memory = new FakeMemoryClient({
      food: Array.from({ length: 10 }, (_, i) => ({
        nodeId: `n${i}`,
        path: ["food", `Dish ${i}`],
        label: `Dish ${i}`,
        score: 1 - i / 10,
        reason: `reason ${i}`,
      })),
    });
    const { rt } = runtimeWith(model, { memory });
    await rt.handle({
      type: "task.start",
      request: { id: "t5", goal: "Order dinner", origin: "home", selections: { restaurant: "Golden Lotus" } },
    });
    const first = model.inputs[0] as string;
    expect(first).toContain("Goal: Order dinner");
    expect(first).toContain("restaurant: Golden Lotus");
    expect(first).toContain("Dish 5");
    expect(first).not.toContain("Dish 6");
    expect(first).toContain("SIMULATED");
  });

  it("reports a refusal plainly and stops", async () => {
    const { rt, events } = runtimeWith(script({ stop: "refusal" }));
    await rt.handle({ type: "task.start", request: { id: "t6", goal: "x", origin: "home" } });
    expect(events.at(-1)).toMatchObject({ type: "task.failed", recoverable: false });
  });

  it("requires a plan before acting", async () => {
    const { rt, web } = runtimeWith(
      script(turn(["open_url", { url: `${SITES.STORE}/menu` }]), turn(["give_up", { reason: "x" }])),
    );
    await rt.handle({ type: "task.start", request: { id: "t7", goal: "x", origin: "home" } });
    expect(web.visits).toHaveLength(0);
  });

  it("rejects calls with invalid arguments before anything runs", async () => {
    const model = script(
      turn(["show_plan", { steps: [{ title: "x", risk: "read" }] }]),
      turn(
        ["click_element", { ref: "place", risk: "nope", kind: "none", summary: "", amount: 0 }],
        ["open_url", {}],
      ),
      turn(["give_up", { reason: "x" }]),
    );
    const { rt, web } = runtimeWith(model);
    await rt.handle({ type: "task.start", request: { id: "t7b", goal: "x", origin: "home" } });
    const outs = model.inputs[2] as ToolOutput[];
    expect(outs.map((o) => o.isError)).toEqual([true, true]);
    expect(outs[0]!.text).toMatch(/risk/);
    expect(outs[1]!.text).toMatch(/Missing "url"/);
    expect(web.visits).toHaveLength(0);
  });

  it("redirects computer use in Chrome to the bridge and never clicks", async () => {
    const native = new FakeNative();
    native.frontmost = "com.google.Chrome";
    const model = script(
      turn(["show_plan", { steps: [{ title: "x", risk: "read" }] }]),
      turn(cu.screenshot(), cu.click(10, 10)),
      turn(["give_up", { reason: "x" }]),
    );
    const { rt } = runtimeWith(model, { native });
    await rt.handle({ type: "task.start", request: { id: "t8", goal: "x", origin: "home" } });
    const outs = model.inputs[2] as ToolOutput[];
    expect(outs.every((o) => o.computer)).toBe(true);
    expect(outs[0]!.image?.mediaType).toBe("image/png");
    expect(outs[1]!.isError).toBe(true);
    expect(outs[1]!.text).toMatch(/AGENCY Bridge/);
    expect(native.calls.some((c) => c.method === "input.click")).toBe(false);
  });

  it("a provider require_confirmation makes a harmless-looking action need approval, acknowledged only after approval", async () => {
    const native = new FakeNative();
    native.frontmost = "test.agency.messages";
    const flagged = {
      ...turn(cu.click(100, 70))[0]!,
      safety: { decision: "require_confirmation", explanation: "Accepting terms" },
    };
    const model = new ScriptedModel(
      [
        turn(["show_plan", { steps: [{ title: "x", risk: "read" }] }]),
        turn(cu.screenshot()),
        [flagged],
        [flagged],
        turn(["give_up", { reason: "x" }]),
      ],
      {
        screenshotEveryComputerAction: true,
      },
    );
    const { rt, events } = runtimeWith(model, { native, bridge: null });
    let n = 0;
    rt.onEvent((e) => {
      if (e.type === "approval.required") {
        const decision = ++n === 1 ? "decline" : "approve";
        queueMicrotask(
          () =>
            void rt.handle({
              type: "approval.decide",
              taskId: "t11",
              decision: { approvalId: e.approval.id, fingerprint: e.approval.fingerprint, decision },
            }),
        );
      }
    });
    await rt.handle({ type: "task.start", request: { id: "t11", goal: "x", origin: "home" } });
    expect(events.filter((e) => e.type === "approval.required")).toHaveLength(2);
    const declined = (model.inputs[3] as ToolOutput[])[0]!;
    const approved = (model.inputs[4] as ToolOutput[])[0]!;
    expect(declined.safetyAcknowledged).toBeUndefined();
    expect(approved.safetyAcknowledged).toBe(true);
    expect(approved.image).toBeDefined(); // a fresh screenshot with every result for this provider
  });

  it("a provider 'blocked' safety decision is refused without running", async () => {
    const native = new FakeNative();
    const blocked = { ...turn(cu.click(100, 70))[0]!, safety: { decision: "blocked", explanation: "No" } };
    const model = script(
      turn(["show_plan", { steps: [{ title: "x", risk: "read" }] }]),
      [blocked],
      turn(["give_up", { reason: "x" }]),
    );
    const { rt } = runtimeWith(model, { native, bridge: null });
    await rt.handle({ type: "task.start", request: { id: "t12", goal: "x", origin: "home" } });
    expect(native.calls.some((c) => c.method === "input.click")).toBe(false);
    expect((model.inputs[2] as ToolOutput[])[0]!.isError).toBe(true);
  });

  it("stops at the cost budget", async () => {
    const expensive: AgentModel = {
      provider: "scripted",
      model: "x",
      screenshotEveryComputerAction: false,
      start: () => ({
        next: async () => ({
          calls: [{ id: "c", name: "read_page", args: {} }],
          text: "",
          stop: "tools",
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 1.5 },
          model: "x",
        }),
      }),
    };
    const { rt, events } = runtimeWith(expensive);
    await rt.handle({ type: "task.start", request: { id: "t9", goal: "x", origin: "home" } });
    expect(events.at(-1)).toMatchObject({ type: "task.failed", reason: expect.stringMatching(/cost limit/) });
  });

  it("logs choices and outcomes to memory", async () => {
    const memory = new FakeMemoryClient({
      food: [
        {
          nodeId: "n",
          path: ["food", "Green curry"],
          label: "Green curry",
          score: 0.9,
          reason: "3 of your last 4 Fridays.",
        },
      ],
    });
    const model = script(
      turn(["show_plan", { steps: [{ title: "Pick", risk: "read" }] }]),
      turn([
        "ask_person",
        {
          prompt: "What would you like?",
          options: [
            { label: "Pad thai", description: "" },
            { label: "Green curry", description: "" },
          ],
          allow_other: false,
        },
      ]),
      turn(["give_up", { reason: "done testing" }]),
    );
    const { rt, events } = runtimeWith(model, { memory });
    rt.onEvent((e) => {
      if (e.type === "task.question")
        queueMicrotask(
          () =>
            void rt.handle({
              type: "task.answer",
              taskId: "t10",
              questionId: e.question.id,
              optionId: e.question.options[0]!.id,
            }),
        );
    });
    await rt.handle({ type: "task.start", request: { id: "t10", goal: "Order dinner", origin: "home" } });
    const q = events.find((e) => e.type === "task.question");
    expect(q?.type === "task.question" && q.question.options[0]).toMatchObject({
      label: "Green curry",
      suggestedBecause: "3 of your last 4 Fridays.",
    });
    expect(memory.logged.map((e) => e.outcome)).toEqual(["chosen", "abandoned"]);
    expect(memory.logged[0]!.path).toEqual(["food", "What would you like?", "Green curry"]);
  });

  it("says which model is set up, or that only built-in tasks work", () => {
    expect(runtimeWith(script()).rt.capabilities()).toMatchObject({ model: true, provider: "scripted" });
    expect(runtimeWith(null).rt.capabilities().note).toMatch(/only do the built-in tasks/);
  });
});

describe("memory helpers", () => {
  it("maps goals to surfaces", () => {
    expect(surfaceFor({ id: "x", goal: "Order my usual Friday dinner", origin: "home" })).toBe("food");
    expect(surfaceFor({ id: "x", goal: "Call the pharmacy", origin: "home" })).toBe("call");
    expect(surfaceFor({ id: "x", goal: "Something odd", origin: "home" })).toBe("home");
  });
  it("ranks suggested options first, keeping order otherwise", () => {
    const ranked = rankWithMemory(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      [{ nodeId: "n", path: ["x", "C"], label: "C", score: 0.8, reason: "usually" }],
    );
    expect(ranked.map((o) => o.id)).toEqual(["c", "a", "b"]);
    expect(ranked[0]!.suggestedBecause).toBe("usually");
  });
});

describe("injection pause", () => {
  it("asks the person directly and does not log the safety answer to memory", async () => {
    const memory = new FakeMemoryClient();
    const web = new SandboxWeb({ storeInjection: true });
    const model = script(
      turn(["show_plan", { steps: [{ title: "Look", risk: "read" }] }]),
      turn(["open_url", { url: `${SITES.STORE}/menu` }], ["read_page", {}]),
      turn(["give_up", { reason: "x" }]),
    );
    const rt = new AgentRuntime({ model, bridge: web, native: null, memory, packs: [] });
    const questions: string[] = [];
    rt.onEvent((e) => {
      if (e.type === "task.question") {
        questions.push(e.question.prompt);
        queueMicrotask(
          () =>
            void rt.handle({ type: "task.answer", taskId: "i1", questionId: e.question.id, optionId: "o1" }),
        );
      }
    });
    await rt.handle({ type: "task.start", request: { id: "i1", goal: "Order dinner", origin: "home" } });
    expect(questions).toHaveLength(1);
    expect(memory.logged.some((e) => e.path.includes("Keep going safely"))).toBe(false);
    expect(rt.audit.all("i1").some((e) => e.kind === "injection")).toBe(true);
  });
});
