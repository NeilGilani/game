/**
 * The provider interface. The runner, guard and approvals only see these types; each provider (Gemini by
 * default, Claude optionally) translates them to and from its own API. Adding a provider never touches safety.
 */

import type { ComputerAction } from "../tools/computer";

/** A function the model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

export interface ToolCall {
  /** Provider call id, echoed on the result. */
  id: string;
  /** Provider-native name (e.g. "click" or "left_click" for computer use). */
  name: string;
  args: Record<string, unknown>;
  /** Set for computer-use calls, already translated to AGENCY's neutral action. */
  computer?: ComputerAction;
  /**
   * A provider-side safety signal (Gemini Computer Use `safety_decision`). It can only make AGENCY more careful:
   * "require_confirmation" sends the action through the person's approval; "blocked" refuses it.
   */
  safety?: { decision: string; explanation?: string };
}

export interface ToolOutput {
  callId: string;
  name: string;
  computer: boolean;
  text: string;
  isError?: boolean;
  /** Screenshot after a computer-use action, sent only during the running task and never stored. */
  image?: { data: string; mediaType: "image/png" | "image/jpeg" };
  /** True when the person approved an action the provider flagged with require_confirmation. */
  safetyAcknowledged?: boolean;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Estimated from the provider's published prices. */
  costUsd: number;
}

export interface ModelTurn {
  calls: ToolCall[];
  /** Any plain text the model wrote this turn (shown nowhere by default; kept for the audit). */
  text: string;
  /** "tools": calls to run; "end": finished without calls; "refusal": declined; "truncated": output cut off. */
  stop: "tools" | "end" | "refusal" | "truncated";
  usage: TurnUsage;
  model: string;
}

export interface SessionOptions {
  system: string;
  tools: ToolSpec[];
  /** Synapse's network budget: "low" thinking under Lean-Fusion. Providers map it to their own setting. */
  thinking?: "low";
  /** Offer computer use (only when agency-native is connected). */
  computer: boolean;
  signal: AbortSignal;
}

/** One conversation for one task. Kept in memory only; dropped when the task ends. */
export interface ModelSession {
  /** First call: the task brief. Later calls: one output per call of the previous turn. */
  next(input: string | ToolOutput[]): Promise<ModelTurn>;
}

export interface AgentModel {
  readonly provider: "gemini" | "anthropic" | "scripted";
  readonly model: string;
  /** Gemini wants a fresh screenshot with every computer-use result; Claude asks for screenshots itself. */
  readonly screenshotEveryComputerAction: boolean;
  start(options: SessionOptions): ModelSession;
}

/** A plain-language reason the model could not be used, for the person and the audit trail. */
export class ModelUnavailable extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface Prices {
  /** Dollars per million tokens. */
  input: number;
  output: number;
  cachedInput: number;
}
