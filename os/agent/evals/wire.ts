/**
 * Wire-level fakes: run a provider-neutral script through the real GeminiModel / AnthropicModel classes by
 * encoding each scripted turn as the provider's own response objects, and checking every request the provider
 * sends back. This way every eval task also exercises the provider translation layer (function calls, computer
 * use coordinates, results, safety acknowledgement, thought-step replay), not just the guard.
 *
 * It is still not the live API: the responses are hand-built in the documented shapes.
 */

import { AnthropicModel, type AnthropicRequest, type AnthropicResponse } from "../src/model/anthropic";
import { GeminiModel, type GeminiRequest, type GeminiResponse, type GeminiStep } from "../src/model/gemini";
import { nextCallId, ScriptedModel, type ScriptCall, type ScriptTurn } from "../src/model/scripted";
import type { AgentModel } from "../src/model/types";
import type { ComputerAction, ScreenPoint } from "../src/tools/computer";
import { FAKE_SCREEN } from "./world/fakeNative";

export type Wire = "gemini" | "anthropic" | "neutral";

export interface WireModel {
  model: AgentModel;
  /** Protocol mistakes the provider made in its requests (should always be empty). */
  violations: string[];
  turns: () => number;
}

export function wireModel(wire: Wire, script: ScriptTurn[]): WireModel {
  if (wire === "gemini") return geminiWire(script);
  if (wire === "anthropic") return anthropicWire(script);
  const m = new ScriptedModel(script);
  return { model: m, violations: [], turns: () => m.turns };
}

const toPoints = (p: ScreenPoint) => {
  if (p.space !== "points") throw new Error("Scripts give computer-use coordinates in screen points.");
  return p;
};

function scriptCalls(
  entry: ScriptTurn | undefined,
): ScriptCall[] | { stop: "refusal" | "end" | "truncated" } {
  if (!entry) return [{ name: "give_up", args: { reason: "Script ended." } }];
  if (typeof entry === "function") return entry([]);
  return entry;
}

// --- Gemini Interactions API --------------------------------------------------------------------------

function geminiWire(script: ScriptTurn[]): WireModel {
  const violations: string[] = [];
  let turn = 0;
  let lastSteps: GeminiStep[] = [];
  let lastCalls: string[] = [];

  const transport = async (req: GeminiRequest): Promise<GeminiResponse> => {
    // Protocol checks on what the provider sent.
    if (req.store !== false)
      violations.push("store must be false (screenshots must not be kept server-side)");
    if (req.previous_interaction_id) violations.push("stateless mode must not use previous_interaction_id");
    const input = Array.isArray(req.input) ? (req.input as GeminiStep[]) : [];
    for (const s of lastSteps) {
      if (!input.some((i) => JSON.stringify(i) === JSON.stringify(s)))
        violations.push(`turn ${turn}: a ${s.type} step from the last response was not resent exactly`);
    }
    const results = input.filter(
      (s): s is Extract<GeminiStep, { type: "function_result" }> => s.type === "function_result",
    );
    for (const id of lastCalls)
      if (!results.some((r) => r.call_id === id))
        violations.push(`turn ${turn}: call ${id} got no function_result`);
    for (const r of results) {
      if (
        Array.isArray(r.result) &&
        r.result.some((c) => c.type === "image") &&
        !r.result.some((c) => c.type === "text")
      )
        violations.push("computer result without its JSON text item");
    }

    const entry = scriptCalls(script[turn++]);
    const usage = { total_input_tokens: 0, total_output_tokens: 0 };
    if (!Array.isArray(entry)) {
      lastSteps = [];
      lastCalls = [];
      if (entry.stop === "refusal")
        return { status: "failed", errors: [{ message: "Blocked by safety filters." }], steps: [], usage };
      if (entry.stop === "truncated") return { status: "incomplete", steps: [], usage };
      return {
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "text", text: "Done." }] }],
        usage,
      };
    }
    const steps: GeminiStep[] = [{ type: "thought", signature: `sig_${turn}` }];
    for (const c of entry) {
      const id = nextCallId();
      if (c.computer) {
        const { name, args } = encodeGemini(c.computer);
        steps.push({
          type: "function_call",
          id,
          name,
          arguments: c.safety ? { ...args, safety_decision: c.safety } : args,
        });
      } else {
        steps.push({ type: "function_call", id, name: c.name, arguments: c.args });
      }
    }
    lastSteps = steps;
    lastCalls = steps.filter((s) => s.type === "function_call").map((s) => (s as { id: string }).id);
    return { id: `int_${turn}`, status: "requires_action", steps, usage, model: "gemini-3.8-flash" };
  };
  return { model: new GeminiModel({ transport }), violations, turns: () => turn };
}

function encodeGemini(a: ComputerAction): { name: string; args: Record<string, unknown> } {
  const norm = (p: ScreenPoint) => {
    const q = toPoints(p);
    return {
      x: Math.round((q.x / FAKE_SCREEN.widthPt) * 1000),
      y: Math.round((q.y / FAKE_SCREEN.heightPt) * 1000),
    };
  };
  switch (a.kind) {
    case "screenshot":
      return { name: "take_screenshot", args: {} };
    case "wait":
      return { name: "wait", args: { seconds: a.seconds } };
    case "move":
      return { name: "move", args: norm(a.at) };
    case "click":
      return {
        name: a.button === "right" ? "right_click" : a.count === 2 ? "double_click" : "click",
        args: norm(a.at),
      };
    case "type":
      return { name: "type", args: { text: a.text, press_enter: a.pressEnter } };
    case "key":
      return a.combo.includes("+")
        ? { name: "hotkey", args: { keys: a.combo.split("+") } }
        : { name: "press_key", args: { key: a.combo } };
    case "scroll":
      return {
        name: "scroll",
        args: { direction: a.direction, magnitude_in_pixels: a.amount, ...(a.at ? norm(a.at) : {}) },
      };
    case "unsupported":
      return { name: a.name, args: {} };
  }
}

// --- Anthropic Messages API ---------------------------------------------------------------------------

function anthropicWire(script: ScriptTurn[]): WireModel {
  const violations: string[] = [];
  let turn = 0;
  let lastIds: { id: string; computer: boolean }[] = [];

  const transport = async (req: AnthropicRequest): Promise<AnthropicResponse> => {
    const last = req.messages[req.messages.length - 1];
    const content = last && Array.isArray(last.content) ? last.content : [];
    for (const { id, computer } of lastIds) {
      const r = content.find((b) => b.type === "tool_result" && b.tool_use_id === id) as
        { toolset_name?: string } | undefined;
      if (!r) violations.push(`turn ${turn}: tool_use ${id} got no tool_result`);
      else if (computer && r.toolset_name !== "computer")
        violations.push(`turn ${turn}: computer result without toolset_name`);
    }
    if (req.tool_choice) violations.push("forced tool_choice is rejected by claude-opus-5-5");

    const entry = scriptCalls(script[turn++]);
    const base = {
      id: `msg_${turn}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    if (!Array.isArray(entry)) {
      lastIds = [];
      const stop =
        entry.stop === "refusal" ? "refusal" : entry.stop === "truncated" ? "max_tokens" : "end_turn";
      return { ...base, content: [], stop_reason: stop } as unknown as AnthropicResponse;
    }
    const blocks = entry.map((c) => {
      const id = `toolu_${nextCallId()}`;
      if (c.computer) {
        const { name, input } = encodeClaude(c.computer);
        return { type: "tool_use", id, name, input, toolset_name: "computer" };
      }
      return { type: "tool_use", id, name: c.name, input: c.args };
    });
    lastIds = blocks.map((b) => ({ id: b.id, computer: "toolset_name" in b }));
    return { ...base, content: blocks, stop_reason: "tool_use" } as unknown as AnthropicResponse;
  };
  return { model: new AnthropicModel({ transport }), violations, turns: () => turn };
}

function encodeClaude(a: ComputerAction): { name: string; input: Record<string, unknown> } {
  const px = (p: ScreenPoint) => {
    const q = toPoints(p);
    return [Math.round(q.x * FAKE_SCREEN.pxPerPoint), Math.round(q.y * FAKE_SCREEN.pxPerPoint)];
  };
  switch (a.kind) {
    case "screenshot":
      return { name: "screenshot", input: {} };
    case "wait":
      return { name: "wait", input: { duration: a.seconds } };
    case "move":
      return { name: "mouse_move", input: { coordinate: px(a.at) } };
    case "click":
      return {
        name: a.button === "right" ? "right_click" : a.count === 2 ? "double_click" : "left_click",
        input: { coordinate: px(a.at) },
      };
    case "type":
      return { name: "type", input: { text: a.text } };
    case "key":
      return { name: "key", input: { text: a.combo } };
    case "scroll":
      return {
        name: "scroll",
        input: {
          scroll_direction: a.direction,
          scroll_amount: Math.max(1, Math.round(a.amount / 40)),
          ...(a.at ? { coordinate: px(a.at) } : {}),
        },
      };
    case "unsupported":
      return { name: a.name, input: {} };
  }
}
