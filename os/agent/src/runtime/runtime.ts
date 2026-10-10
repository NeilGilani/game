/**
 * AgentRuntime: AgentCommand in, AgentEvent out (os/contracts/src/agent.ts). Chooses the most structured way
 * to do a task (a matching task pack, else Claude with bridge, native and computer-use tools), and wires every
 * effect through the ActionGuard.
 */

import type { AgentCommand, AgentEvent, ChoiceOption, ChoiceQuestion, Suggestion, TaskRequest } from "@agency/contracts";
import { ApprovalGate } from "../approvals";
import { AuditLog } from "../audit";
import { ActionGuard, SpendLedger } from "../guard";
import { rankWithMemory, safeLog, safeSuggestions, surfaceFor, type MemoryClient } from "../memory";
import type { ModelClient } from "../model/client";
import { DEFAULT_SETTINGS, type SafetySettings } from "../policy/settings";
import { GuardedTools } from "../tools/guarded";
import type { BrowserBridge, NativeClient, TaskPack } from "../types";
import { runClaude } from "./claudeRunner";
import { runPack } from "./packRunner";
import { BudgetExceeded, DEFAULT_BUDGETS, TaskRun, TaskStopped, type Budgets } from "./task";

export interface ModelSettings {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-side refusal fallbacks (fallbacks: "default"). */
  fallbacks: boolean;
  /** Offer the computer-use toolset when agency-native is connected. */
  computerUse: boolean;
  /** Dollars per million tokens, for the cost budget. */
  prices: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  model: "claude-opus-5-5",
  effort: "high",
  fallbacks: true,
  computerUse: true,
  prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export interface RuntimeDeps {
  model: ModelClient | null;
  bridge: BrowserBridge | null;
  native: NativeClient | null;
  memory: MemoryClient | null;
  packs: TaskPack[];
  audit?: AuditLog;
  settings?: () => SafetySettings;
  modelSettings?: Partial<ModelSettings>;
  budgets?: Partial<Budgets>;
}

export type RunResult =
  | { kind: "done"; outcome: string; verified: boolean; evidence?: string }
  | { kind: "failed"; reason: string; recoverable: boolean };

/** Ask the person a choice question; options are ranked by memory and logged back. */
export type Asker = (q: Omit<ChoiceQuestion, "id">) => Promise<{ optionId: string | null; other?: string }>;

export class AgentRuntime {
  readonly audit: AuditLog;
  readonly gate = new ApprovalGate();
  private readonly guard: ActionGuard;
  private readonly tasks = new Map<string, TaskRun>();
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private readonly modelSettings: ModelSettings;
  private readonly budgets: Budgets;
  private readonly settings: () => SafetySettings;

  constructor(private readonly deps: RuntimeDeps) {
    this.audit = deps.audit ?? new AuditLog();
    this.settings = deps.settings ?? (() => DEFAULT_SETTINGS);
    this.guard = new ActionGuard(this.gate, this.audit, this.settings, new SpendLedger());
    this.modelSettings = { ...DEFAULT_MODEL_SETTINGS, ...deps.modelSettings };
    this.budgets = { ...DEFAULT_BUDGETS, ...deps.budgets };
  }

  onEvent(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Plain-language status for the person: what this agent can do right now. */
  capabilities(): { model: boolean; bridge: boolean; native: boolean; packs: string[]; note: string } {
    const model = this.deps.model !== null;
    return {
      model,
      bridge: this.deps.bridge !== null,
      native: this.deps.native !== null,
      packs: this.deps.packs.map((p) => p.title),
      note: model ? `Claude (${this.modelSettings.model}) is set up.` : "No Claude API key is set up, so I can only do the built-in tasks.",
    };
  }

  task(id: string): TaskRun | undefined {
    return this.tasks.get(id);
  }

  /** Returns a promise that settles when the command has been applied (for a start: when the task ends). */
  async handle(cmd: AgentCommand): Promise<void> {
    switch (cmd.type) {
      case "task.start":
        return this.start(cmd.request);
      case "task.answer": {
        const ok = this.tasks.get(cmd.taskId)?.answer(cmd.questionId, cmd.optionId, cmd.other) ?? false;
        if (!ok) this.audit.record({ taskId: cmd.taskId, kind: "answer", message: "An answer arrived for a question that isn't open; ignored." });
        return;
      }
      case "approval.decide": {
        const ok = this.tasks.get(cmd.taskId)?.decide(cmd.decision) ?? false;
        if (!ok) this.audit.record({ taskId: cmd.taskId, kind: "approval.decided", message: "A decision arrived for an approval that isn't open; ignored. Nothing was done." });
        return;
      }
      case "task.pause":
        this.tasks.get(cmd.taskId)?.pause();
        return;
      case "task.resume":
        this.tasks.get(cmd.taskId)?.resume();
        return;
      case "task.stop":
        this.stopTask(cmd.taskId, "person");
        return;
      case "stop.all":
        for (const id of this.tasks.keys()) this.stopTask(id, "person");
        await this.deps.native?.call("input.stopAll", {}).catch(() => undefined);
        return;
    }
  }

  private stopTask(id: string, by: TaskStopped["by"]): void {
    const t = this.tasks.get(id);
    if (!t || t.ended) return;
    t.stop(by);
    this.gate.revokeTask(id);
  }

  private emit(e: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken listener must not stop the agent */
      }
    }
  }

  private async start(request: TaskRequest): Promise<void> {
    if (this.tasks.get(request.id) && !this.tasks.get(request.id)!.ended) return;
    const task = new TaskRun(request, this.budgets, (e) => this.emit(e));
    this.tasks.set(request.id, task);
    this.emit({ type: "task.started", taskId: task.id, goal: request.goal, dryRun: task.dryRun });
    this.audit.record({ taskId: task.id, kind: "task.started", message: `Started: ${request.goal}${task.dryRun ? " (simulated)" : ""}` });

    const surface = surfaceFor(request);
    const suggestions = await safeSuggestions(this.deps.memory, surface);
    const chosen: string[] = [];
    const tools = new GuardedTools(
      this.guard,
      {
        taskId: task.id,
        dryRun: task.dryRun,
        requestApproval: (r) => task.waitForApproval(r),
        checkpoint: async () => {
          await task.checkpoint();
          task.countAction();
        },
      },
      this.deps.bridge,
      this.deps.native,
    );
    const ask: Asker = async (q) => {
      const ranked = rankWithMemory(q.options, suggestions).slice(0, 6);
      const answer = await task.ask({ ...q, options: ranked });
      const label = answer.optionId ? ranked.find((o) => o.id === answer.optionId)?.label : answer.other;
      this.audit.record({ taskId: task.id, kind: "answer", message: `You chose: ${label ?? "something else"}`, why: q.prompt });
      if (label) {
        chosen.push(label);
        await safeLog(this.deps.memory, { path: [surface, q.prompt, label], surface, outcome: "chosen" });
      }
      return answer;
    };

    let result: RunResult;
    try {
      const pack = this.deps.packs.find((p) => p.matches(request));
      if (pack) {
        result = await runPack(task, pack, tools, ask);
      } else if (this.deps.model) {
        result = await runClaude({ task, tools, ask, model: this.deps.model, settings: this.modelSettings, audit: this.audit, suggestions: suggestions as Suggestion[], safety: this.settings() });
      } else {
        const names = this.deps.packs.map((p) => p.title).join(", ") || "none installed";
        result = { kind: "failed", reason: `I can't do this one: no Claude API key is set up, so I can only do built-in tasks (${names}).`, recoverable: false };
      }
    } catch (e) {
      if (e instanceof TaskStopped) {
        task.ended = true;
        this.emit({ type: "task.stopped", taskId: task.id, by: e.by });
        this.audit.record({ taskId: task.id, kind: "task.ended", message: `Stopped by ${e.by}. Anything not yet done was not done.` });
        await this.logOutcome(surface, chosen, "abandoned");
        return;
      }
      const reason = e instanceof BudgetExceeded ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
      result = { kind: "failed", reason, recoverable: !(e instanceof BudgetExceeded) };
    }

    task.ended = true;
    this.gate.revokeTask(task.id);
    if (task.stopped) {
      this.emit({ type: "task.stopped", taskId: task.id, by: task.stopped });
      return;
    }
    if (result.kind === "done") {
      this.emit({ type: "task.done", taskId: task.id, outcome: result.outcome, verified: result.verified, ...(result.evidence ? { evidence: result.evidence } : {}) });
      this.audit.record({ taskId: task.id, kind: "task.ended", message: `${result.verified ? "Done and checked" : "Finished but not confirmed"}: ${result.outcome}` });
      await this.logOutcome(surface, chosen, "completed");
    } else {
      this.emit({ type: "task.failed", taskId: task.id, reason: result.reason, recoverable: result.recoverable });
      this.audit.record({ taskId: task.id, kind: "task.ended", message: `Not done: ${result.reason}` });
      await this.logOutcome(surface, chosen, "abandoned");
    }
  }

  private async logOutcome(surface: ReturnType<typeof surfaceFor>, chosen: string[], outcome: "completed" | "abandoned"): Promise<void> {
    if (chosen.length) await safeLog(this.deps.memory, { path: [surface, ...chosen], surface, outcome });
  }
}

/** Options for a choice question built from labels, ids o1..o6. */
export function options(labels: (string | { label: string; description?: string })[]): ChoiceOption[] {
  return labels.slice(0, 6).map((l, i) => (typeof l === "string" ? { id: `o${i + 1}`, label: l } : { id: `o${i + 1}`, ...l }));
}
