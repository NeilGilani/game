/**
 * The model behind an interface so CI can replay recorded responses and live runs can record them.
 * Only the agent utility process talks to the Anthropic API; the key never reaches renderer code.
 */

import Anthropic from "@anthropic-ai/sdk";

export type ModelRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ModelMessage = Anthropic.Beta.Messages.BetaMessage;
export type ModelParam = Anthropic.Beta.Messages.BetaMessageParam;
export type ModelContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
export type ToolResultParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export interface ModelClient {
  readonly kind: "anthropic" | "replay";
  create(request: ModelRequest, signal?: AbortSignal): Promise<ModelMessage>;
}

/** A plain-language reason the model could not be used, for the person and the audit trail. */
export class ModelUnavailable extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export interface AnthropicOptions {
  apiKey: string;
  /** Per request, in milliseconds. */
  timeoutMs?: number;
}

export class AnthropicModelClient implements ModelClient {
  readonly kind = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(opts: AnthropicOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: 2 });
  }

  async create(request: ModelRequest, signal?: AbortSignal): Promise<ModelMessage> {
    try {
      const stream = this.client.beta.messages.stream(request, { signal });
      return await stream.finalMessage();
    } catch (error) {
      throw toUnavailable(error);
    }
  }
}

function toUnavailable(error: unknown): Error {
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof Anthropic.AuthenticationError) return new ModelUnavailable("The API key was not accepted.", false);
  if (error instanceof Anthropic.PermissionDeniedError) return new ModelUnavailable("The API key may not use this model.", false);
  if (error instanceof Anthropic.NotFoundError) return new ModelUnavailable("The configured model was not found.", false);
  if (error instanceof Anthropic.RateLimitError) return new ModelUnavailable("Claude is busy right now (rate limit).", true);
  if (error instanceof Anthropic.BadRequestError) return new ModelUnavailable(`Claude could not take this request: ${error.message}`, false);
  if (error instanceof Anthropic.APIConnectionError) return new ModelUnavailable("Can't reach Claude (no connection).", true);
  if (error instanceof Anthropic.APIError) return new ModelUnavailable(`Claude returned an error (${error.status ?? "unknown"}).`, (error.status ?? 500) >= 500);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Replays model responses in order. Used by CI and the eval suite. A script entry may be a recorded message
 * or a function of the request (for scripted adversarial models that react to tool results).
 */
export type ScriptEntry = ModelMessage | ((request: ModelRequest) => ModelMessage);

export class ReplayModelClient implements ModelClient {
  readonly kind = "replay" as const;
  private i = 0;
  readonly requests: ModelRequest[] = [];

  constructor(private readonly script: ScriptEntry[]) {}

  async create(request: ModelRequest): Promise<ModelMessage> {
    this.requests.push(structuredClone(request));
    const entry = this.script[this.i++];
    if (!entry) throw new ModelUnavailable("The recorded script ran out of responses.", false);
    return typeof entry === "function" ? entry(request) : structuredClone(entry);
  }
}

/** Wraps a live client and keeps every response so a live run can become a CI fixture. Images are not kept. */
export class RecordingModelClient implements ModelClient {
  readonly kind = "anthropic" as const;
  readonly recorded: ModelMessage[] = [];

  constructor(private readonly inner: ModelClient) {}

  async create(request: ModelRequest, signal?: AbortSignal): Promise<ModelMessage> {
    const res = await this.inner.create(request, signal);
    this.recorded.push(structuredClone(res));
    return res;
  }
}

// --- Helpers for building messages in scripts and tests ---------------------------------------------

let seq = 0;

export function toolUse(name: string, input: Record<string, unknown>, extra: { toolset?: "computer" } = {}): ModelContentBlock {
  const block = { type: "tool_use", id: `toolu_${(++seq).toString().padStart(6, "0")}`, name, input } as Anthropic.Beta.Messages.BetaToolUseBlock;
  if (extra.toolset) block.toolset_name = extra.toolset;
  return block;
}

export function assistant(content: ModelContentBlock[], stop: ModelMessage["stop_reason"] = "tool_use"): ModelMessage {
  return {
    id: `msg_${(++seq).toString().padStart(6, "0")}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as ModelMessage;
}

export function text(t: string): ModelContentBlock {
  return { type: "text", text: t, citations: null } as ModelContentBlock;
}
