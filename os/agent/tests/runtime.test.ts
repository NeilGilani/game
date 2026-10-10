import type { AgentEvent } from "@agency/contracts";
import { describe, expect, it } from "vitest";
import { SandboxWeb, SITES } from "../evals/world/sandboxWeb";
import { FakeNative } from "../evals/world/fakeNative";
import { CONS, REV, ScriptedModel, turn } from "../evals/harness";
import { FakeMemoryClient, rankWithMemory, surfaceFor } from "../src/memory";
import { assistant, ReplayModelClient, text, toolUse, type ModelRequest } from "../src/model/client";
import { AgentRuntime } from "../src/runtime/runtime";
import { TaskRun, DEFAULT_BUDGETS, TaskStopped } from "../src/runtime/task";

const tick = () => new Promise((r) => setTimeout(r, 0));

function runtimeWith(
  model: ConstructorParameters<typeof AgentRuntime>[0]["model"],
  extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
) {
  const web = new SandboxWeb();
  const native = new FakeNative();
  const rt = new AgentRuntime({ model, bridge: web, native: null, memory: null, packs: [], ...extra });
  const events: AgentEvent[] = [];
  rt.onEvent((e) => events.push(e));
  return { rt, web, native, events };
}

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
    const model = new ScriptedModel([
      turn(["show_plan", { steps: [{ title: "Ask for refill", risk: "consequential" }] }]),
      turn(
        ["open_url", { url: `${SITES.PHARMACY}/refills` }],
        ["click", { ref: "rx1", ...REV }],
        ["click", { ref: "req", ...CONS("submit", "Refill") }],
      ),
      turn(["finish", { outcome: "Done", expect_text: "Refill request received" }]),
    ]);
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

  it("stop during an approval wait ends the task, revokes the request and does nothing", async () => {
    const model = new ScriptedModel([
      turn(["show_plan", { steps: [{ title: "Refill", risk: "consequential" }] }]),
      turn(
        ["open_url", { url: `${SITES.PHARMACY}/refills` }],
        ["click", { ref: "rx1", ...REV }],
        ["click", { ref: "req", ...CONS("submit", "Refill") }],
      ),
    ]);
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
    let calls = 0;
    const script = [
      turn(["show_plan", { steps: [{ title: "Look", risk: "read" }] }]),
      turn(["open_url", { url: `${SITES.STORE}/menu` }]),
      turn(["finish", { outcome: "ok", expect_text: "Thai Basil — Menu" }]),
    ];
    const model = {
      kind: "replay" as const,
      create: async (r: ModelRequest) => script[calls++]!({ req: r, last: () => "" }),
    };
    const { rt, events } = runtimeWith(model);
    rt.onEvent((e) => {
      if (e.type === "task.plan") void rt.handle({ type: "task.pause", taskId: "t3" });
    });
    const done = rt.handle({ type: "task.start", request: { id: "t3", goal: "Look", origin: "home" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "task.done")).toBe(false);
    await rt.handle({ type: "task.resume", taskId: "t3" });
    await done;
    expect(calls).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: "task.done", verified: true });
  });

  it("builds requests for the current API: model, adaptive thinking, effort, cache, fallbacks, computer toolset", async () => {
    const replay = new ReplayModelClient([assistant([toolUse("give_up", { reason: "test" })])]);
    const { rt } = runtimeWith(replay, { native: new FakeNative(), modelSettings: { effort: "medium" } });
    await rt.handle({ type: "task.start", request: { id: "t4", goal: "Something", origin: "home" } });
    const req = replay.requests[0]!;
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config).toEqual({ effort: "medium" });
    expect(req.cache_control).toEqual({ type: "ephemeral" });
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(req.fallbacks).toBe("default");
    expect(req.tool_choice).toBeUndefined();
    const toolset = req.tools!.find((t) => "type" in t && t.type === "computer_toolset_20260801");
    expect(toolset).toBeDefined();
    expect(toolset && "name" in toolset).toBe(false);
    for (const t of req.tools!) if ("strict" in t) expect(t.strict).toBe(true);
  });

  it("puts goal and selections in the first message, not the system prompt, and only a few memory suggestions", async () => {
    const replay = new ReplayModelClient([assistant([toolUse("give_up", { reason: "test" })])]);
    const memory = new FakeMemoryClient({
      food: Array.from({ length: 10 }, (_, i) => ({
        nodeId: `n${i}`,
        path: ["food", `Dish ${i}`],
        label: `Dish ${i}`,
        score: 1 - i / 10,
        reason: `reason ${i}`,
      })),
    });
    const { rt } = runtimeWith(replay, { memory });
    await rt.handle({
      type: "task.start",
      request: { id: "t5", goal: "Order dinner", origin: "home", selections: { restaurant: "Thai Basil" } },
    });
    const req = replay.requests[0]!;
    expect(JSON.stringify(req.system)).not.toContain("Thai Basil");
    const first = req.messages[0]!.content as string;
    expect(first).toContain("Goal: Order dinner");
    expect(first).toContain("restaurant: Thai Basil");
    expect(first).toContain("Dish 5");
    expect(first).not.toContain("Dish 6");
    expect(first).toContain("SIMULATED");
  });

  it("reports a refusal plainly and stops", async () => {
    const res = assistant([text("")], "refusal");
    const { rt, events } = runtimeWith(new ReplayModelClient([res]));
    await rt.handle({ type: "task.start", request: { id: "t6", goal: "x", origin: "home" } });
    expect(events.at(-1)).toMatchObject({ type: "task.failed", recoverable: false });
  });

  it("requires a plan before acting", async () => {
    const model = new ScriptedModel([
      turn(["open_url", { url: `${SITES.STORE}/menu` }]),
      turn(["give_up", { reason: "x" }]),
    ]);
    const { rt, web } = runtimeWith(model);
    await rt.handle({ type: "task.start", request: { id: "t7", goal: "x", origin: "home" } });
    expect(web.visits).toHaveLength(0);
  });

  it("sends computer-use results back with toolset_name and redirects Chrome to the bridge", async () => {
    const native = new FakeNative();
    native.frontmost = "com.google.Chrome";
    const replay = new ReplayModelClient([
      assistant([toolUse("show_plan", { steps: [{ title: "x", risk: "read" }] })]),
      assistant([
        toolUse("screenshot", {}, { toolset: "computer" }),
        toolUse("left_click", { coordinate: [10, 10] }, { toolset: "computer" }),
      ]),
      assistant([toolUse("give_up", { reason: "x" })]),
    ]);
    const { rt } = runtimeWith(replay, { native });
    await rt.handle({ type: "task.start", request: { id: "t8", goal: "x", origin: "home" } });
    const results = replay.requests[2]!.messages.at(-1)!.content as {
      type: string;
      toolset_name?: string;
      is_error?: boolean;
      content: unknown;
    }[];
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.toolset_name === "computer")).toBe(true);
    expect(Array.isArray(results[0]!.content)).toBe(true); // the screenshot image
    expect(results[1]!.is_error).toBe(true);
    expect(JSON.stringify(results[1]!.content)).toMatch(/AGENCY Bridge/);
    expect(native.calls.some((c) => c.method === "input.click")).toBe(false);
  });

  it("stops at the cost budget", async () => {
    const big = () => {
      const m = assistant([toolUse("read_page", {})]);
      m.usage.output_tokens = 200_000; // $4 at $20/M
      return m;
    };
    const { rt, events } = runtimeWith(
      new ReplayModelClient([
        assistant([toolUse("show_plan", { steps: [{ title: "x", risk: "read" }] })]),
        big,
        big,
        big,
      ]),
    );
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
    const model = new ScriptedModel([
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
    ]);
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
    const model = new ScriptedModel([
      turn(["show_plan", { steps: [{ title: "Look", risk: "read" }] }]),
      turn(["open_url", { url: `${SITES.STORE}/menu` }], ["read_page", {}]),
      turn(["give_up", { reason: "x" }]),
    ]);
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
