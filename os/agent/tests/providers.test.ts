import { describe, expect, it } from "vitest";
import { cu, turn } from "../evals/harness";
import { FakeNative, FAKE_SCREEN } from "../evals/world/fakeNative";
import {
  AnthropicModel,
  claudeComputerAction,
  type AnthropicRequest,
  type AnthropicResponse,
} from "../src/model/anthropic";
import {
  GeminiModel,
  geminiComputerAction,
  GEMINI_EXCLUDED_ACTIONS,
  type GeminiRequest,
  type GeminiResponse,
} from "../src/model/gemini";
import { PLAN_TOOLS } from "../src/model/prompt";
import { ScriptedModel } from "../src/model/scripted";
import { ModelUnavailable, type ToolOutput } from "../src/model/types";
import { AgentRuntime } from "../src/runtime/runtime";
import { modelFor } from "../src/utility";

const signal = new AbortController().signal;
const opts = (computer = true) => ({ system: "SYS", tools: PLAN_TOOLS, computer, signal });

function gemini(responses: GeminiResponse[], extra: ConstructorParameters<typeof GeminiModel>[0] = {}) {
  const requests: GeminiRequest[] = [];
  const model = new GeminiModel({
    ...extra,
    transport: async (r) => {
      requests.push(structuredClone(r));
      const res = responses.shift();
      if (!res) throw new Error("no more responses");
      return res;
    },
  });
  return { model, requests };
}

describe("GeminiModel (Interactions API)", () => {
  it("builds a stateless request: default model, no storage, thinking level, function tools, desktop computer use", async () => {
    const { model, requests } = gemini([{ status: "completed", steps: [] }], { thinkingLevel: "high" });
    await model.start(opts()).next("Goal: x");
    const r = requests[0]!;
    expect(r.model).toBe("gemini-3.8-flash");
    expect(r.store).toBe(false);
    expect(r.previous_interaction_id).toBeUndefined();
    expect(r.system_instruction).toBe("SYS");
    expect(r.generation_config).toMatchObject({ thinking_level: "high", tool_choice: "auto" });
    expect(r.input).toEqual([{ type: "user_input", content: [{ type: "text", text: "Goal: x" }] }]);
    const fns = r.tools!.filter((t) => t.type === "function");
    expect(fns.map((t) => (t as { name: string }).name)).toEqual(PLAN_TOOLS.map((t) => t.name));
    expect(r.tools!.find((t) => t.type === "computer_use")).toEqual({
      type: "computer_use",
      environment: "desktop",
      enable_prompt_injection_detection: true,
      excluded_predefined_functions: GEMINI_EXCLUDED_ACTIONS,
    });
  });

  it("leaves computer use out when agency-native isn't connected, and the model id is configurable", async () => {
    const { model, requests } = gemini([{ status: "completed", steps: [] }], { model: "gemini-3.6-flash" });
    await model.start(opts(false)).next("x");
    expect(requests[0]!.model).toBe("gemini-3.6-flash");
    expect(requests[0]!.tools!.some((t) => t.type === "computer_use")).toBe(false);
  });

  it("parses custom and computer-use calls, and resends every model step exactly with the results", async () => {
    const thought = { type: "thought" as const, signature: "sig-abc", summary: [] };
    const { model, requests } = gemini([
      {
        status: "requires_action",
        steps: [
          thought,
          { type: "function_call", id: "c1", name: "show_plan", arguments: { steps: [] } },
          {
            type: "function_call",
            id: "c2",
            name: "click",
            arguments: {
              x: 500,
              y: 250,
              safety_decision: { decision: "require_confirmation", explanation: "Buy?" },
            },
          },
        ],
        usage: {
          total_input_tokens: 1_000_000,
          total_cached_tokens: 400_000,
          total_output_tokens: 100_000,
          total_thought_tokens: 100_000,
        },
      },
      { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }] },
    ]);
    const s = model.start(opts());
    const t1 = await s.next("go");
    expect(t1.stop).toBe("tools");
    expect(t1.calls[0]).toEqual({ id: "c1", name: "show_plan", args: { steps: [] } });
    expect(t1.calls[1]).toMatchObject({
      id: "c2",
      name: "click",
      computer: { kind: "click", at: { x: 500, y: 250, space: "normalized" }, button: "left", count: 1 },
      safety: { decision: "require_confirmation", explanation: "Buy?" },
    });
    expect(t1.calls[1]!.args.safety_decision).toBeUndefined();
    // $0.75/M uncached input, $0.075/M cached, $3.75/M output incl. thinking
    expect(t1.usage.costUsd).toBeCloseTo(0.6 * 0.75 + 0.4 * 0.075 + 0.2 * 3.75, 6);

    const outs: ToolOutput[] = [
      { callId: "c1", name: "show_plan", computer: false, text: "Plan shown." },
      {
        callId: "c2",
        name: "click",
        computer: true,
        text: "OK",
        safetyAcknowledged: true,
        image: { data: "PNG", mediaType: "image/png" },
      },
    ];
    const t2 = await s.next(outs);
    expect(t2).toMatchObject({ stop: "end", text: "ok" });
    const input = requests[1]!.input as unknown[];
    expect(input).toContainEqual(thought);
    expect(input).toContainEqual({
      type: "function_result",
      call_id: "c1",
      name: "show_plan",
      result: "Plan shown.",
    });
    expect(input).toContainEqual({
      type: "function_result",
      call_id: "c2",
      name: "click",
      result: [
        { type: "text", text: JSON.stringify({ status: "OK", safety_acknowledgement: true }) },
        { type: "image", data: "PNG", mime_type: "image/png" },
      ],
    });
  });

  it("reports blocked output as a refusal and incomplete output as truncated", async () => {
    const { model } = gemini([
      { status: "failed", errors: [{ message: "Response blocked by safety filters" }] },
    ]);
    expect((await model.start(opts()).next("x")).stop).toBe("refusal");
    const { model: m2 } = gemini([{ status: "incomplete", steps: [] }]);
    expect((await m2.start(opts()).next("x")).stop).toBe("truncated");
  });

  it("maps API errors to plain, retryable-or-not messages", async () => {
    const cases: [unknown, RegExp, boolean][] = [
      [Object.assign(new Error("x"), { status: 401 }), /key was not accepted/, false],
      [Object.assign(new Error("x"), { status: 404 }), /not found/, false],
      [Object.assign(new Error("x"), { status: 429 }), /busy/, true],
      [Object.assign(new Error("x"), { status: 503 }), /error \(503\)/, true],
      [new TypeError("fetch failed"), /no connection/, true],
    ];
    for (const [err, msg, retryable] of cases) {
      const model = new GeminiModel({ transport: async () => Promise.reject(err) });
      const e = await model
        .start(opts())
        .next("x")
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ModelUnavailable);
      expect((e as ModelUnavailable).message).toMatch(msg);
      expect((e as ModelUnavailable).retryable).toBe(retryable);
    }
  });

  it("translates Computer Use actions; unsupported ones are never faked", () => {
    expect(geminiComputerAction("type", { text: "hi", press_enter: true })).toEqual({
      kind: "type",
      text: "hi",
      pressEnter: true,
    });
    expect(geminiComputerAction("hotkey", { keys: ["control", "c"] })).toEqual({
      kind: "key",
      combo: "control+c",
      repeat: 1,
    });
    expect(geminiComputerAction("press_key", { key: "Enter" })).toEqual({
      kind: "key",
      combo: "Enter",
      repeat: 1,
    });
    expect(geminiComputerAction("scroll", { direction: "up", magnitude_in_pixels: 600 })).toEqual({
      kind: "scroll",
      at: null,
      direction: "up",
      amount: 600,
    });
    expect(geminiComputerAction("right_click", { x: 1, y: 2 })).toMatchObject({
      kind: "click",
      button: "right",
    });
    expect(geminiComputerAction("take_screenshot", {})).toEqual({ kind: "screenshot" });
    expect(geminiComputerAction("drag_and_drop", {})).toEqual({ kind: "unsupported", name: "drag_and_drop" });
  });

  it("normalized coordinates land on the right element of the real screen size", async () => {
    const native = new FakeNative();
    native.frontmost = "test.agency.messages";
    // "To" field: points x 40..200, y 40..100 on a 2560×1600-point screen.
    const to = {
      x: Math.round((100 / FAKE_SCREEN.widthPt) * 1000),
      y: Math.round((70 / FAKE_SCREEN.heightPt) * 1000),
    };
    const model = new ScriptedModel(
      [
        turn(["show_plan", { steps: [{ title: "x", risk: "read" }] }]),
        [
          {
            name: "click",
            args: {},
            computer: { kind: "click", at: { ...to, space: "normalized" }, button: "left", count: 1 },
          },
        ],
        turn(cu.type("Jordan")),
        turn(["give_up", { reason: "x" }]),
      ],
      { screenshotEveryComputerAction: true },
    );
    const rt = new AgentRuntime({ model, bridge: null, native, memory: null, packs: [] });
    await rt.handle({ type: "task.start", request: { id: "n1", goal: "x", origin: "home" } });
    expect(native.draft.to).toBe("Jordan");
  });
});

describe("AnthropicModel (optional provider)", () => {
  function claude(responses: unknown[]) {
    const requests: AnthropicRequest[] = [];
    const model = new AnthropicModel({
      transport: async (r) => {
        requests.push(structuredClone(r));
        return responses.shift() as AnthropicResponse;
      },
    });
    return { model, requests };
  }
  const msg = (content: unknown[], stop = "tool_use") => ({
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  it("keeps the current Claude request shape", async () => {
    const { model, requests } = claude([msg([], "end_turn")]);
    await model.start(opts()).next("x");
    const r = requests[0]!;
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.thinking).toEqual({ type: "adaptive" });
    expect(r.output_config).toEqual({ effort: "high" });
    expect(r.cache_control).toEqual({ type: "ephemeral" });
    expect(r.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(r.fallbacks).toBe("default");
    expect(r.tool_choice).toBeUndefined();
    expect(r.tools!.some((t) => "type" in t && t.type === "computer_toolset_20260801")).toBe(true);
    for (const t of r.tools!) if ("strict" in t) expect(t.strict).toBe(true);
  });

  it("echoes toolset_name on computer results and maps pixel coordinates", async () => {
    const { model, requests } = claude([
      msg([
        {
          type: "tool_use",
          id: "t1",
          name: "left_click",
          input: { coordinate: [50, 35] },
          toolset_name: "computer",
        },
      ]),
      msg([], "end_turn"),
    ]);
    const s = model.start(opts());
    const t = await s.next("x");
    expect(t.calls[0]!.computer).toEqual({
      kind: "click",
      at: { x: 50, y: 35, space: "pixels" },
      button: "left",
      count: 1,
    });
    await s.next([{ callId: "t1", name: "left_click", computer: true, text: "OK" }]);
    const last = requests[1]!.messages.at(-1)!.content as { toolset_name?: string; tool_use_id: string }[];
    expect(last[0]).toMatchObject({ tool_use_id: "t1", toolset_name: "computer" });
    expect(claudeComputerAction("key", { text: "ctrl+s", repeat: 2 })).toEqual({
      kind: "key",
      combo: "ctrl+s",
      repeat: 2,
    });
  });

  it("reports refusals", async () => {
    const { model } = claude([msg([], "refusal")]);
    expect((await model.start(opts()).next("x")).stop).toBe("refusal");
  });
});

describe("provider selection", () => {
  it("defaults to Gemini and uses Claude only when asked", () => {
    expect(modelFor("gemini", "k", {}).provider).toBe("gemini");
    expect(modelFor("gemini", "k", {}).model).toBe("gemini-3.8-flash");
    expect(modelFor("gemini", "k", { AGENCY_AGENT_MODEL: "gemini-3.6-flash" }).model).toBe(
      "gemini-3.6-flash",
    );
    expect(modelFor("anthropic", "k", {}).model).toBe("claude-opus-5-5");
  });
});
