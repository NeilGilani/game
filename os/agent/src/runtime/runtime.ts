/**
 * AgentRuntime: AgentCommand in, AgentEvent out (os/contracts/src/agent.ts). Chooses the most structured way
 * to do a task (a matching task pack, else the AI model (Gemini by default) with bridge, native and computer-use tools), and wires every
 * effect through the ActionGuard.
 */

import type {
  AgentCommand,
  AgentEvent,
  ChoiceOption,
  ChoiceQuestion,
  Suggestion,
  TaskRequest,
} from "@agency/contracts";
import { ApprovalGate } from "../approvals";
import { AuditLog } from "../audit";
import { ActionGuard, SpendLedger } from "../guard";
import { rankWithMemory, safeLog, safeSuggestions, surfaceFor, type MemoryClient } from "../memory";
import type { AgentModel } from "../model/types";
import { DEFAULT_SETTINGS, type SafetySettings } from "../policy/settings";
import { GuardedTools } from "../tools/guarded";
import type { BrowserBridge, NativeClient, TaskPack } from "../types";
import type { SynapseRoute, SynapseRouter } from "../synapse";
import { runModel } from "./modelRunner";
import { runPack } from "./packRunner";
import { BudgetExceeded, DEFAULT_BUDGETS, TaskRun, TaskStopped, type Budgets } from "./task";

export interface RuntimeDeps {
  /** Gemini by default, Claude optionally; null when no API key is set up (task packs only). */
  model: AgentModel | null;
  bridge: BrowserBridge | null;
  native: NativeClient | null;
  memory: MemoryClient | null;
  packs: TaskPack[];
  audit?: AuditLog;
  settings?: () => SafetySettings;
  /** Offer computer use when agency-native is connected (default true). */
  computerUse?: boolean;
  /** Synapse layer: routes each model task (experts + network budget) before the model sees it. */
  router?: SynapseRouter | null;
  budgets?: Partial<Budgets>;
}

/** Task note id for the Synapse route ("Synapse-Mesh: Lean-Fusion: Gemini with light thinking, …"). */
export const SYNAPSE_STEP = "synapse:route";

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
  private readonly budgets: Budgets;
  private readonly settings: () => SafetySettings;

  constructor(private readonly deps: RuntimeDeps) {
    this.audit = deps.audit ?? new AuditLog();
    this.settings = deps.settings ?? (() => DEFAULT_SETTINGS);
    this.guard = new ActionGuard(this.gate, this.audit, this.settings, new SpendLedger());
    this.budgets = { ...DEFAULT_BUDGETS, ...deps.budgets };
  }

  onEvent(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Plain-language status for the person: what this agent can do right now. */
  capabilities(): {
    model: boolean;
    provider: string | null;
    modelName: string | null;
    bridge: boolean;
    native: boolean;
    packs: string[];
    note: string;
  } {
    const m = this.deps.model;
    const model = m !== null;
    return {
      model,
      provider: m?.provider ?? null,
      modelName: m?.model ?? null,
      bridge: this.deps.bridge !== null,
      native: this.deps.native !== null,
      packs: this.deps.packs.map((p) => p.title),
      note: model
        ? `${m.provider === "gemini" ? "Gemini" : m.provider === "anthropic" ? "Claude" : "A scripted model"} (${m.model}) is set up.`
        : "No AI model API key is set up, so I can only do the built-in tasks.",
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
        if (!ok)
          this.audit.record({
            taskId: cmd.taskId,
            kind: "answer",
            message: "An answer arrived for a question that isn't open; ignored.",
          });
        return;
      }
      case "approval.decide": {
        const ok = this.tasks.get(cmd.taskId)?.decide(cmd.decision) ?? false;
        if (!ok)
          this.audit.record({
            taskId: cmd.taskId,
            kind: "approval.decided",
            message: "A decision arrived for an approval that isn't open; ignored. Nothing was done.",
          });
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

  /** Ask the Synapse layer how to run this task; shown to the person as the first line of the task. */
  private async routeTask(taskId: string, request: TaskRequest): Promise<SynapseRoute | null> {
    const router = this.deps.router;
    if (!router) return null;
    const text = [request.goal, ...Object.values(request.selections ?? {})].join(". ");
    const route = await router.route(text);
    if (!route) return null;
    const who = route.router === "synapse" ? "Synapse-Mesh" : "AGENCY's stand-in router";
    this.emit({
      type: "task.step",
      taskId,
      stepId: SYNAPSE_STEP,
      status: "done",
      summary: `${who}: ${route.note}`,
    });
    this.audit.record({ taskId, kind: "synapse.route", message: `${who}: ${route.note}` });
    return route;
  }

  private async start(request: TaskRequest): Promise<void> {
    if (this.tasks.get(request.id) && !this.tasks.get(request.id)!.ended) return;
    const task = new TaskRun(request, this.budgets, (e) => this.emit(e));
    this.tasks.set(request.id, task);
    this.emit({ type: "task.started", taskId: task.id, goal: request.goal, dryRun: task.dryRun });
    this.audit.record({
      taskId: task.id,
      kind: "task.started",
      message: `Started: ${request.goal}${task.dryRun ? " (simulated)" : ""}`,
    });

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
        ensureRunning: () => task.checkpoint(),
      },
      this.deps.bridge,
      this.deps.native,
    );
    const ask: Asker = async (q) => {
      const ranked = rankWithMemory(q.options, suggestions).slice(0, 6);
      const answer = await task.ask({ ...q, options: ranked });
      const label = answer.optionId ? ranked.find((o) => o.id === answer.optionId)?.label : answer.other;
      this.audit.record({
        taskId: task.id,
        kind: "answer",
        message: `You chose: ${label ?? "something else"}`,
        why: q.prompt,
      });
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
        const route = await this.routeTask(task.id, request);
        result =
          route?.decision === "built-in"
            ? {
                kind: "failed",
                reason: `${route.note} New tasks need the cloud model, so this one has to wait; saved tasks still work.`,
                recoverable: true,
              }
            : await runModel({
                task,
                tools,
                ask,
                model: this.deps.model,
                computerUse: this.deps.computerUse ?? true,
                audit: this.audit,
                suggestions: suggestions as Suggestion[],
                safety: this.settings(),
                route,
              });
      } else {
        const names = this.deps.packs.map((p) => p.title).join(", ") || "none installed";
        result = {
          kind: "failed",
          reason: `I can't do this one: no AI model API key is set up, so I can only do built-in tasks (${names}).`,
          recoverable: false,
        };
      }
    } catch (e) {
      if (e instanceof TaskStopped) {
        task.ended = true;
        this.emit({ type: "task.stopped", taskId: task.id, by: e.by });
        this.audit.record({
          taskId: task.id,
          kind: "task.ended",
          message: `Stopped by ${e.by}. Anything not yet done was not done.`,
        });
        await this.logOutcome(surface, chosen, "abandoned");
        return;
      }
      const reason =
        e instanceof BudgetExceeded
          ? e.message
          : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
      result = { kind: "failed", reason, recoverable: !(e instanceof BudgetExceeded) };
    }

    task.ended = true;
    this.gate.revokeTask(task.id);
    if (task.stopped) {
      this.emit({ type: "task.stopped", taskId: task.id, by: task.stopped });
      return;
    }
    if (result.kind === "done") {
      this.emit({
        type: "task.done",
        taskId: task.id,
        outcome: result.outcome,
        verified: result.verified,
        ...(result.evidence ? { evidence: result.evidence } : {}),
      });
      this.audit.record({
        taskId: task.id,
        kind: "task.ended",
        message: `${result.verified ? "Done and checked" : "Finished but not confirmed"}: ${result.outcome}`,
      });
      await this.logOutcome(surface, chosen, "completed");
    } else {
      this.emit({
        type: "task.failed",
        taskId: task.id,
        reason: result.reason,
        recoverable: result.recoverable,
      });
      this.audit.record({ taskId: task.id, kind: "task.ended", message: `Not done: ${result.reason}` });
      await this.logOutcome(surface, chosen, "abandoned");
    }
  }

  private async logOutcome(
    surface: ReturnType<typeof surfaceFor>,
    chosen: string[],
    outcome: "completed" | "abandoned",
  ): Promise<void> {
    if (chosen.length) await safeLog(this.deps.memory, { path: [surface, ...chosen], surface, outcome });
  }
}

/** Options for a choice question built from labels, ids o1..o6. */
export function options(labels: (string | { label: string; description?: string })[]): ChoiceOption[] {
  return labels
    .slice(0, 6)
    .map((l, i) => (typeof l === "string" ? { id: `o${i + 1}`, label: l } : { id: `o${i + 1}`, ...l }));
}
