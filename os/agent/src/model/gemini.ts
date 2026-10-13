/**
 * Google Gemini through the Interactions API (@google/genai), the default provider.
 *
 * - Model `gemini-3.8-flash` by default (configurable), `thinking_level` low by default (AGENCY_AGENT_THINKING).
 * - Custom function tools for the plan, the person, the bridge and agency-native; Gemini Computer Use
 *   (`type: "computer_use"`, environment "desktop") as the fallback tier, with Gemini's own prompt-injection
 *   detection switched on, and the predefined actions agency-native can't do faithfully excluded.
 * - `store: false` and the full history resent each turn (stateless mode). The default would keep every
 *   interaction, screenshots included, on Google's servers for up to 55 days; AGENCY keeps screenshots only for
 *   the running task. Thought steps are resent exactly as received, as stateless mode requires.
 * - Gemini's `safety_decision` on a computer-use call is surfaced so the guard can only become stricter.
 */

import { GoogleGenAI, type Interactions } from "@google/genai";
import type { ComputerAction, ScreenPoint } from "../tools/computer";
import {
  ModelUnavailable,
  type AgentModel,
  type ModelSession,
  type ModelTurn,
  type Prices,
  type SessionOptions,
  type ToolCall,
  type ToolOutput,
} from "./types";

export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

export type GeminiStep = Interactions.Step;
export type GeminiRequest = Interactions.CreateModelInteractionParamsNonStreaming;

/** The part of an Interaction AGENCY reads. */
export interface GeminiResponse {
  id?: string;
  status: string;
  steps?: GeminiStep[];
  errors?: { code?: number | string; message?: string }[];
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    total_cached_tokens?: number;
  };
  model?: string;
}

export type GeminiTransport = (request: GeminiRequest, signal: AbortSignal) => Promise<GeminiResponse>;

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  thinkingLevel?: GeminiThinkingLevel;
  /** Dollars per million tokens. Defaults: gemini-3.8-flash paid tier, valid through 2026-12-31. */
  prices?: Prices;
  timeoutMs?: number;
  /** Screenshots kept in the history that is resent every turn (the most recent ones). */
  keepScreenshots?: number;
  /** Replaces the call to Google: AGENCY Cloud (model/cloud.ts), or a fake in tests. */
  transport?: GeminiTransport;
  /** How the model is reached, for the status: AGENCY's relay or a key of your own. */
  via?: "agency-cloud" | "own-key";
  /** Tried in order when the model above is busy (rate limited, overloaded, unreachable). */
  fallbackModels?: string[];
}

export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
/** Gemini's models are often overloaded at different times; each of these also runs computer use. */
export const GEMINI_FALLBACK_MODELS = ["gemini-3.7-flash", "gemini-3.5-flash-lite"];

/**
 * Stateless mode resends the whole history every turn, and Gemini Computer Use returns a screenshot with every
 * action, so without a limit each turn uploads every screenshot taken so far (the request grows with every step, and
 * so does the time to the next action). Only the latest few screens are kept, as in Google's own computer-use
 * reference agent; older results keep their text. Only images in AGENCY's own function results are dropped: model
 * steps (thought signatures) are always resent exactly.
 */
export const GEMINI_KEEP_SCREENSHOTS = 3;

/** Replaces the image in all but the newest `keep` screenshot-carrying function results with a short note. */
export function dropOldScreenshots(history: GeminiStep[], keep: number): void {
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const step = history[i]!;
    if (step.type !== "function_result" || !Array.isArray(step.result)) continue;
    const parts = step.result as { type: string }[];
    if (!parts.some((p) => p.type === "image")) continue;
    seen += 1;
    if (seen <= keep) continue;
    step.result = [
      ...parts.filter((p) => p.type !== "image"),
      { type: "text", text: "(older screenshot removed; the latest screenshots show the screen now)" },
    ] as typeof step.result;
  }
}

/** gemini-3.8-flash, paid tier, through 2026-12-31 (ai.google.dev/gemini-api/docs/pricing, read 2026-10-10). */
export const GEMINI_38_FLASH_PRICES: Prices = { input: 0.75, output: 3.75, cachedInput: 0.075 };

/** Predefined Computer Use actions agency-native can't perform faithfully. Excluded rather than faked. */
export const GEMINI_EXCLUDED_ACTIONS = [
  "drag_and_drop",
  "mouse_down",
  "mouse_up",
  "key_down",
  "key_up",
  "triple_click",
  "middle_click",
];

const COMPUTER_ACTIONS = new Set([
  "click",
  "double_click",
  "right_click",
  "move",
  "type",
  "press_key",
  "hotkey",
  "scroll",
  "wait",
  "take_screenshot",
  ...GEMINI_EXCLUDED_ACTIONS,
]);

export class GeminiModel implements AgentModel {
  readonly provider = "gemini" as const;
  readonly model: string;
  private readonly models: string[];
  readonly screenshotEveryComputerAction = true;
  readonly via: "agency-cloud" | "own-key";
  private readonly thinkingLevel: GeminiThinkingLevel;
  private readonly prices: Prices;
  private readonly transport: GeminiTransport;
  private readonly keepScreenshots: number;

  constructor(opts: GeminiOptions) {
    this.model = opts.model ?? GEMINI_DEFAULT_MODEL;
    this.models = [...new Set([this.model, ...(opts.fallbackModels ?? GEMINI_FALLBACK_MODELS)])];
    this.via = opts.via ?? "own-key";
    this.keepScreenshots = Math.max(1, opts.keepScreenshots ?? GEMINI_KEEP_SCREENSHOTS);
    // Low by default: each turn of a desktop task must come back in seconds, not tens of seconds.
    this.thinkingLevel = opts.thinkingLevel ?? "low";
    this.prices = opts.prices ?? GEMINI_38_FLASH_PRICES;
    if (opts.transport) {
      this.transport = opts.transport;
    } else {
      if (!opts.apiKey) throw new Error("A Gemini API key is needed.");
      const client = new GoogleGenAI({ apiKey: opts.apiKey });
      const timeout = opts.timeoutMs ?? 120_000;
      this.transport = async (request, signal) =>
        (await client.interactions.create(request, {
          timeout,
          maxRetries: 0, // a busy model hands over to the next one instead (see `busy`)
          fetchOptions: { signal },
        })) as GeminiResponse;
    }
  }

  start(options: SessionOptions): ModelSession {
    const tools: GeminiRequest["tools"] = options.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    if (options.computer) {
      tools.push({
        type: "computer_use",
        environment: "desktop",
        enable_prompt_injection_detection: true,
        excluded_predefined_functions: GEMINI_EXCLUDED_ACTIONS,
      });
    }
    const custom = new Set(options.tools.map((t) => t.name));
    const history: GeminiStep[] = [];
    // A session that had to move to a backup model stays on it: its history carries that model's steps.
    let current = 0;

    return {
      next: async (input) => {
        if (typeof input === "string") {
          history.push({ type: "user_input", content: [{ type: "text", text: input }] });
        } else {
          for (const out of input) history.push(functionResult(out));
          dropOldScreenshots(history, this.keepScreenshots);
        }
        const request: GeminiRequest = {
          model: this.models[current] ?? this.model,
          store: false,
          system_instruction: options.system,
          tools,
          generation_config: {
            thinking_level: options.thinking ?? this.thinkingLevel,
            tool_choice: "auto",
            max_output_tokens: 16000,
          },
          input: [...history],
        };
        let res: GeminiResponse | undefined;
        for (;;) {
          try {
            res = await this.transport(
              { ...request, model: this.models[current] ?? this.model },
              options.signal,
            );
            break;
          } catch (e) {
            const err = toUnavailable(e);
            if (!busy(e) || current >= this.models.length - 1 || options.signal.aborted) throw err;
            current += 1; // busy: the next model answers at once instead of a retry
          }
        }
        const turn = this.parse(res, custom, options.computer);
        // Keep every model step exactly as received (thought signatures included); drop any echo of our input.
        for (const step of res.steps ?? [])
          if (step.type !== "user_input" && step.type !== "function_result") history.push(step);
        return turn;
      },
    };
  }

  private parse(res: GeminiResponse, custom: Set<string>, computer: boolean): ModelTurn {
    const usage = res.usage ?? {};
    const input = usage.total_input_tokens ?? 0;
    const cached = Math.min(input, usage.total_cached_tokens ?? 0);
    const output = (usage.total_output_tokens ?? 0) + (usage.total_thought_tokens ?? 0);
    const costUsd =
      ((input - cached) * this.prices.input +
        cached * this.prices.cachedInput +
        output * this.prices.output) /
      1e6;
    const base = {
      usage: { inputTokens: input, outputTokens: output, cachedTokens: cached, costUsd },
      model: res.model ?? this.model,
    };

    const errorText = (res.errors ?? []).map((e) => e.message ?? "").join(" ");
    const outputs = (res.steps ?? []).filter(
      (s): s is Interactions.ModelOutputStep => s.type === "model_output",
    );
    const blocked = outputs.some((o) => o.error) || /safety|blocked|prohibited|recitation/i.test(errorText);
    if (res.status === "failed" || res.status === "cancelled") {
      if (blocked) return { ...base, calls: [], text: "", stop: "refusal" };
      throw new ModelUnavailable(
        `Gemini could not finish this turn${errorText ? `: ${errorText}` : "."}`,
        true,
      );
    }
    if (blocked && !(res.steps ?? []).some((s) => s.type === "function_call"))
      return { ...base, calls: [], text: "", stop: "refusal" };

    const calls: ToolCall[] = [];
    for (const step of res.steps ?? []) {
      if (step.type !== "function_call") continue;
      const args = { ...(step.arguments ?? {}) } as Record<string, unknown>;
      const safety = readSafety(args);
      if (computer && !custom.has(step.name) && COMPUTER_ACTIONS.has(step.name)) {
        delete args.safety_decision;
        calls.push({
          id: step.id,
          name: step.name,
          args,
          computer: geminiComputerAction(step.name, args),
          ...(safety ? { safety } : {}),
        });
      } else {
        calls.push({ id: step.id, name: step.name, args, ...(safety ? { safety } : {}) });
      }
    }
    const text = outputs
      .flatMap((o) => o.content ?? [])
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    const stop: ModelTurn["stop"] = calls.length
      ? "tools"
      : res.status === "incomplete" || res.status === "budget_exceeded"
        ? "truncated"
        : "end";
    return { ...base, calls, text, stop };
  }
}

function readSafety(args: Record<string, unknown>): ToolCall["safety"] | undefined {
  const s = args.safety_decision as { decision?: unknown; explanation?: unknown } | undefined;
  if (!s || typeof s !== "object" || typeof s.decision !== "string") return undefined;
  return {
    decision: s.decision,
    ...(typeof s.explanation === "string" ? { explanation: s.explanation } : {}),
  };
}

function functionResult(out: ToolOutput): GeminiStep {
  if (!out.computer) {
    return {
      type: "function_result",
      call_id: out.callId,
      name: out.name,
      result: out.text,
      ...(out.isError ? { is_error: true } : {}),
    };
  }
  const status: Record<string, unknown> = { status: out.text };
  if (out.safetyAcknowledged) status.safety_acknowledgement = true;
  const result: (Interactions.TextContent | Interactions.ImageContent)[] = [
    { type: "text", text: JSON.stringify(status) },
  ];
  if (out.image) result.push({ type: "image", data: out.image.data, mime_type: out.image.mediaType });
  return {
    type: "function_result",
    call_id: out.callId,
    name: out.name,
    result,
    ...(out.isError ? { is_error: true } : {}),
  };
}

const at = (args: Record<string, unknown>): ScreenPoint => ({
  x: Number(args.x),
  y: Number(args.y),
  space: "normalized",
});

/** Gemini Computer Use action (coordinates normalized 0..999) → AGENCY's neutral action. */
export function geminiComputerAction(name: string, args: Record<string, unknown>): ComputerAction {
  switch (name) {
    case "click":
      return { kind: "click", at: at(args), button: "left", count: 1 };
    case "double_click":
      return { kind: "click", at: at(args), button: "left", count: 2 };
    case "right_click":
      return { kind: "click", at: at(args), button: "right", count: 1 };
    case "move":
      return { kind: "move", at: at(args) };
    case "type":
      return { kind: "type", text: String(args.text ?? ""), pressEnter: args.press_enter === true };
    case "press_key":
      return { kind: "key", combo: String(args.key ?? ""), repeat: 1 };
    case "hotkey":
      return {
        kind: "key",
        combo: (Array.isArray(args.keys) ? args.keys.map(String) : [String(args.keys ?? "")]).join("+"),
        repeat: 1,
      };
    case "scroll":
      return {
        kind: "scroll",
        at: args.x !== undefined && args.y !== undefined ? at(args) : null,
        direction: (["up", "down", "left", "right"] as const).find((d) => d === args.direction) ?? "down",
        amount: Number(args.magnitude_in_pixels ?? 300),
      };
    case "wait":
      return { kind: "wait", seconds: Number(args.seconds ?? 1) };
    case "take_screenshot":
      return { kind: "screenshot" };
    default:
      return { kind: "unsupported", name };
  }
}

/** Rate limited, overloaded or unreachable: another model may well answer. A rejected key or request won't. */
function busy(error: unknown): boolean {
  if (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.name))) return false;
  const status =
    typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : null;
  if (status === 400 && safetyBlock(error)) return true; // seen live on harmless requests while Gemini was overloaded
  return status === null
    ? !(error instanceof ModelUnavailable) || error.retryable
    : status === 429 || status >= 500;
}

/** Google's "Request blocked due to safety violations": under load it also fires on plain requests ("what is this"). */
function safetyBlock(error: unknown): boolean {
  return /blocked due to safety|safety violation/i.test((error as Error)?.message ?? "");
}

function toUnavailable(error: unknown): Error {
  if (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.name))) return error;
  const status =
    typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : null;
  if (status === 401 || status === 403)
    return new ModelUnavailable("The Gemini API key was not accepted.", false);
  if (status === 404) return new ModelUnavailable("The configured Gemini model was not found.", false);
  if (status === 429) return new ModelUnavailable("Gemini is busy right now (rate limit).", true);
  if (status === 400 && safetyBlock(error))
    return new ModelUnavailable(
      "Google's safety check stopped this request. It sometimes does this by mistake when it's busy: try again in a minute.",
      true,
    );
  if (status === 400)
    return new ModelUnavailable(`Gemini could not take this request: ${(error as Error).message}`, false);
  if (status !== null) return new ModelUnavailable(`Gemini returned an error (${status}).`, status >= 500);
  if (error instanceof ModelUnavailable) return error;
  return new ModelUnavailable("Can't reach Gemini (no connection).", true);
}
