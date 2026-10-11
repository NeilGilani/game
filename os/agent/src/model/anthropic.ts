/**
 * Anthropic Claude, the optional provider (AGENCY_AGENT_PROVIDER=anthropic). Same request shape as before the
 * switch to Gemini: claude-opus-5-5, adaptive thinking, effort, automatic prompt caching, strict tools, refusal
 * fallbacks, and the `computer_toolset_20260801` computer-use toolset with `toolset_name` echoed on results.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ComputerAction } from "../tools/computer";
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

export type AnthropicRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type AnthropicResponse = Anthropic.Beta.Messages.BetaMessage;
type Param = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResultParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export type AnthropicTransport = (
  request: AnthropicRequest,
  signal: AbortSignal,
) => Promise<AnthropicResponse>;

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  fallbacks?: boolean;
  prices?: Prices & { cacheWrite: number };
  timeoutMs?: number;
  transport?: AnthropicTransport;
}

/** Members agency-native can't implement faithfully are switched off rather than faked. */
export const COMPUTER_TOOLSET = {
  type: "computer_toolset_20260801" as const,
  configs: {
    zoom: { enabled: false },
    hold_key: { enabled: false },
    left_mouse_down: { enabled: false },
    left_mouse_up: { enabled: false },
    left_click_drag: { enabled: false },
    middle_click: { enabled: false },
    triple_click: { enabled: false },
  },
};

export class AnthropicModel implements AgentModel {
  readonly provider = "anthropic" as const;
  readonly model: string;
  readonly screenshotEveryComputerAction = false;
  private readonly effort: NonNullable<AnthropicOptions["effort"]>;
  private readonly fallbacks: boolean;
  private readonly prices: Prices & { cacheWrite: number };
  private readonly transport: AnthropicTransport;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model ?? "claude-opus-5-5";
    this.effort = opts.effort ?? "high";
    this.fallbacks = opts.fallbacks ?? true;
    this.prices = opts.prices ?? { input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5 };
    if (opts.transport) {
      this.transport = opts.transport;
    } else {
      if (!opts.apiKey) throw new Error("An Anthropic API key is needed.");
      const client = new Anthropic({
        apiKey: opts.apiKey,
        timeout: opts.timeoutMs ?? 120_000,
        maxRetries: 2,
      });
      this.transport = (request, signal) => client.beta.messages.stream(request, { signal }).finalMessage();
    }
  }

  start(options: SessionOptions): ModelSession {
    const tools = options.tools.map(
      (t) =>
        ({
          name: t.name,
          description: t.description,
          strict: true,
          input_schema: t.parameters,
        }) as Anthropic.Beta.Messages.BetaTool,
    );
    const messages: Param[] = [];
    return {
      next: async (input) => {
        if (typeof input === "string") messages.push({ role: "user", content: input });
        else messages.push({ role: "user", content: input.map(toolResult) });
        const request: AnthropicRequest = {
          model: this.model,
          max_tokens: 16000,
          system: [{ type: "text", text: options.system }],
          tools: options.computer ? [...tools, COMPUTER_TOOLSET] : tools,
          messages: [...messages],
          thinking: { type: "adaptive" },
          output_config: { effort: options.thinking ?? this.effort },
          cache_control: { type: "ephemeral" },
          ...(this.fallbacks
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
        };
        let res: AnthropicResponse;
        try {
          res = await this.transport(request, options.signal);
        } catch (e) {
          throw toUnavailable(e);
        }
        const turn = this.parse(res);
        if (turn.stop !== "refusal")
          messages.push({ role: "assistant", content: res.content as Param["content"] });
        return turn;
      },
    };
  }

  private parse(res: AnthropicResponse): ModelTurn {
    const u = res.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const p = this.prices;
    const costUsd =
      (u.input_tokens * p.input +
        u.output_tokens * p.output +
        cacheRead * p.cachedInput +
        cacheWrite * p.cacheWrite) /
      1e6;
    const base = {
      usage: {
        inputTokens: u.input_tokens + cacheRead + cacheWrite,
        outputTokens: u.output_tokens,
        cachedTokens: cacheRead,
        costUsd,
      },
      model: res.model,
    };
    if (res.stop_reason === "refusal") return { ...base, calls: [], text: "", stop: "refusal" };
    const calls: ToolCall[] = [];
    let text = "";
    for (const b of res.content) {
      if (b.type === "text") text += b.text;
      if (b.type !== "tool_use") continue;
      const args = (b.input ?? {}) as Record<string, unknown>;
      if (b.toolset_name === "computer")
        calls.push({ id: b.id, name: b.name, args, computer: claudeComputerAction(b.name, args) });
      else calls.push({ id: b.id, name: b.name, args });
    }
    const stop: ModelTurn["stop"] =
      res.stop_reason === "max_tokens" ? "truncated" : calls.length ? "tools" : "end";
    return { ...base, calls, text, stop };
  }
}

function toolResult(out: ToolOutput): ToolResultParam {
  const content: ToolResultParam["content"] = out.image
    ? [
        ...(out.text && out.text !== "OK" ? [{ type: "text" as const, text: out.text }] : []),
        { type: "image", source: { type: "base64", media_type: out.image.mediaType, data: out.image.data } },
      ]
    : out.text;
  return {
    type: "tool_result",
    tool_use_id: out.callId,
    content,
    ...(out.isError ? { is_error: true } : {}),
    ...(out.computer ? { toolset_name: "computer" } : {}),
  };
}

/** Claude computer-toolset member (pixel coordinates of the last screenshot) → AGENCY's neutral action. */
export function claudeComputerAction(name: string, args: Record<string, unknown>): ComputerAction {
  const coord =
    Array.isArray(args.coordinate) && args.coordinate.length === 2
      ? { x: Number(args.coordinate[0]), y: Number(args.coordinate[1]), space: "pixels" as const }
      : null;
  switch (name) {
    case "screenshot":
      return { kind: "screenshot" };
    case "wait":
      return { kind: "wait", seconds: Number(args.duration ?? 1) };
    case "mouse_move":
      return coord ? { kind: "move", at: coord } : { kind: "unsupported", name };
    case "left_click":
    case "right_click":
    case "double_click":
      if (!coord) return { kind: "unsupported", name: `${name} without a coordinate` };
      return {
        kind: "click",
        at: coord,
        button: name === "right_click" ? "right" : "left",
        count: name === "double_click" ? 2 : 1,
      };
    case "type":
      return { kind: "type", text: String(args.text ?? ""), pressEnter: false };
    case "key":
      return { kind: "key", combo: String(args.text ?? ""), repeat: Number(args.repeat ?? 1) };
    case "scroll":
      return {
        kind: "scroll",
        at: coord,
        direction:
          (["up", "down", "left", "right"] as const).find((d) => d === args.scroll_direction) ?? "down",
        amount: Number(args.scroll_amount ?? 3) * 40,
      };
    default:
      return { kind: "unsupported", name };
  }
}

function toUnavailable(error: unknown): Error {
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof Anthropic.AuthenticationError)
    return new ModelUnavailable("The Anthropic API key was not accepted.", false);
  if (error instanceof Anthropic.PermissionDeniedError)
    return new ModelUnavailable("The API key may not use this model.", false);
  if (error instanceof Anthropic.NotFoundError)
    return new ModelUnavailable("The configured Claude model was not found.", false);
  if (error instanceof Anthropic.RateLimitError)
    return new ModelUnavailable("Claude is busy right now (rate limit).", true);
  if (error instanceof Anthropic.BadRequestError)
    return new ModelUnavailable(`Claude could not take this request: ${error.message}`, false);
  if (error instanceof Anthropic.APIConnectionError)
    return new ModelUnavailable("Can't reach Claude (no connection).", true);
  if (error instanceof Anthropic.APIError)
    return new ModelUnavailable(
      `Claude returned an error (${error.status ?? "unknown"}).`,
      (error.status ?? 500) >= 500,
    );
  return error instanceof Error ? error : new Error(String(error));
}
