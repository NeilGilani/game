/**
 * A provider-neutral scripted model for tests and the eval suite, and a recorder for live runs.
 * Scripts are lists of turns; each turn is a list of tool calls. They are hand-written, not model output.
 */

import type { ComputerAction } from "../tools/computer";
import type { AgentModel, ModelSession, ModelTurn, SessionOptions, ToolCall, ToolOutput } from "./types";

export interface ScriptCall {
  name: string;
  args: Record<string, unknown>;
  /** Computer-use action in global screen points; wire fakes convert it to each provider's coordinates. */
  computer?: ComputerAction;
  safety?: ToolCall["safety"];
}

/** A turn of a script. Receives the outputs of the previous turn (for scripts that react). */
export type ScriptTurn =
  ScriptCall[] | ((previous: ToolOutput[]) => ScriptCall[]) | { stop: "refusal" | "end" | "truncated" };

let seq = 0;
export const nextCallId = (): string => `call_${(++seq).toString().padStart(6, "0")}`;

export class ScriptedModel implements AgentModel {
  readonly provider = "scripted" as const;
  readonly model = "scripted";
  readonly screenshotEveryComputerAction: boolean;
  turns = 0;
  readonly inputs: (string | ToolOutput[])[] = [];

  constructor(
    private readonly script: ScriptTurn[],
    opts: { screenshotEveryComputerAction?: boolean } = {},
  ) {
    this.screenshotEveryComputerAction = opts.screenshotEveryComputerAction ?? false;
  }

  start(_options: SessionOptions): ModelSession {
    return {
      next: async (input) => {
        this.inputs.push(input);
        const entry = this.script[this.turns++];
        const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
        if (!entry)
          return {
            calls: [{ id: nextCallId(), name: "give_up", args: { reason: "Script ended." } }],
            text: "",
            stop: "tools",
            usage,
            model: this.model,
          };
        if (!Array.isArray(entry) && typeof entry === "object")
          return { calls: [], text: "", stop: entry.stop, usage, model: this.model };
        const calls = typeof entry === "function" ? entry(typeof input === "string" ? [] : input) : entry;
        return {
          calls: calls.map((c) => ({ id: nextCallId(), ...c })),
          text: "",
          stop: calls.length ? "tools" : "end",
          usage,
          model: this.model,
        };
      },
    };
  }
}

/** Wraps a live model and keeps every turn so a live run can become a CI fixture. Screenshots are not kept. */
export class RecordingModel implements AgentModel {
  readonly recorded: ModelTurn[] = [];
  constructor(private readonly inner: AgentModel) {}
  get provider() {
    return this.inner.provider;
  }
  get model() {
    return this.inner.model;
  }
  get screenshotEveryComputerAction() {
    return this.inner.screenshotEveryComputerAction;
  }
  start(options: SessionOptions): ModelSession {
    const session = this.inner.start(options);
    return {
      next: async (input) => {
        const turn = await session.next(input);
        this.recorded.push(structuredClone(turn));
        return turn;
      },
    };
  }
}
