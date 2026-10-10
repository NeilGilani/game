/**
 * Eval harness: runs one task against the sandbox web world and the fake native environment, with a simulated
 * person who answers questions and approvals by a fixed policy, and measures the outcome from the world's own
 * records (not from what the agent says).
 *
 * Scripts are provider-neutral. By default each one runs through the real GeminiModel class with a fake
 * Interactions transport (see wire.ts), so the provider's translation is exercised too.
 */

import type { AgentEvent, ApprovalRequest, ChoiceQuestion, TaskRequest } from "@agency/contracts";
import { AuditLog } from "../src/audit";
import type { MemoryClient } from "../src/memory";
import type { ScriptCall, ScriptTurn } from "../src/model/scripted";
import type { AgentModel } from "../src/model/types";
import { DEFAULT_SETTINGS, type SafetySettings } from "../src/policy/settings";
import { AgentRuntime } from "../src/runtime/runtime";
import type { ComputerAction } from "../src/tools/computer";
import type { TaskPack } from "../src/types";
import { wireModel, type Wire } from "./wire";
import { FakeNative } from "./world/fakeNative";
import { SandboxWeb, type Effect, type WorldOptions } from "./world/sandboxWeb";

export interface World {
  web: SandboxWeb;
  native: FakeNative;
}

export interface PersonPolicy {
  /** Option id to choose; default: the first option. */
  choose?(q: ChoiceQuestion, world: World): { optionId: string | null; other?: string };
  /** Default: approve. Called with the request exactly as the person would see it. */
  approve?(a: ApprovalRequest, world: World, n: number): "approve" | "decline" | { change: string };
}

export interface EvalTask {
  id: string;
  category: "task" | "safety" | "injection" | "honesty";
  description: string;
  request: Omit<TaskRequest, "id">;
  world?: WorldOptions;
  /** Which tiers are connected. Default: bridge only. */
  connect?: { bridge?: boolean; native?: boolean };
  startUrl?: string;
  frontmostApp?: string;
  settings?: Partial<SafetySettings>;
  packs?: TaskPack[];
  /** null runs with no model (no API key). */
  script: ScriptTurn[] | null;
  person?: PersonPolicy;
  /** Task-specific success check against the world's records and the event stream. */
  success(r: EvalRun): boolean;
}

export interface EvalRun {
  task: EvalTask;
  world: World;
  events: AgentEvent[];
  audit: AuditLog;
  effects: Effect[];
  final: AgentEvent | undefined;
  approvalsShown: ApprovalRequest[];
  questions: ChoiceQuestion[];
}

export interface EvalMetrics {
  id: string;
  category: EvalTask["category"];
  provider: string;
  success: boolean;
  outcome: string;
  modelTurns: number;
  actions: number;
  approvalsRequested: number;
  questionsAsked: number;
  consequentialEffects: number;
  approvedExecutions: number;
  consequentialWithoutApproval: number;
  /** Provider protocol mistakes found by the wire fake (always 0 for live runs, where nothing checks them). */
  protocolViolations: number;
  /** Agent working time, excluding time spent waiting for the person. */
  agentMs: number;
  costUsd: number;
}

/** A turn that calls one or more tools: [name, args] or [computer action]. */
export function turn(...calls: ([string, Record<string, unknown>] | [ComputerAction])[]): ScriptCall[] {
  return calls.map((c) =>
    c.length === 1 ? { name: "computer", args: {}, computer: c[0] } : { name: c[0], args: c[1] },
  );
}

/** Computer-use actions in global screen points (the wire fakes convert them per provider). */
export const cu = {
  screenshot: (): [ComputerAction] => [{ kind: "screenshot" }],
  click: (x: number, y: number): [ComputerAction] => [
    { kind: "click", at: { x, y, space: "points" }, button: "left", count: 1 },
  ],
  type: (text: string, pressEnter = false): [ComputerAction] => [{ kind: "type", text, pressEnter }],
  key: (combo: string): [ComputerAction] => [{ kind: "key", combo, repeat: 1 }],
};

export const REV = { risk: "reversible", kind: "none", summary: "", amount: 0 };
export function CONS(kind: string, summary: string, amount = 0) {
  return { risk: "consequential", kind, summary, amount };
}

export interface EvalOptions {
  wire?: Wire;
  /** A live model instead of the script (evals/run.ts --live). */
  model?: AgentModel;
  memory?: MemoryClient | null;
}

export async function runEval(
  task: EvalTask,
  opts: EvalOptions = {},
): Promise<{ run: EvalRun; metrics: EvalMetrics }> {
  const wire = opts.wire ?? "gemini";
  const wm = !opts.model && task.script ? wireModel(wire, task.script) : null;
  const model = opts.model ?? wm?.model ?? null;

  const world: World = { web: new SandboxWeb(task.world), native: new FakeNative() };
  if (task.startUrl) world.web.url = task.startUrl;
  if (task.frontmostApp) world.native.frontmost = task.frontmostApp;
  const audit = new AuditLog();
  const settings: SafetySettings = { ...DEFAULT_SETTINGS, ...task.settings };
  const connect = task.connect ?? { bridge: true };
  const runtime = new AgentRuntime({
    model,
    bridge: connect.bridge ? world.web : null,
    native: connect.native ? world.native : null,
    memory: opts.memory ?? null,
    packs: task.packs ?? [],
    audit,
    settings: () => settings,
    budgets: { toolTimeoutMs: 5000 },
  });

  const events: AgentEvent[] = [];
  const approvalsShown: ApprovalRequest[] = [];
  const questions: ChoiceQuestion[] = [];
  const taskId = `eval_${task.id}`;
  runtime.onEvent((e) => {
    events.push(e);
    if (e.type === "task.question") {
      questions.push(e.question);
      const answer = task.person?.choose?.(e.question, world) ?? {
        optionId: e.question.options[0]?.id ?? null,
      };
      queueMicrotask(
        () =>
          void runtime.handle({
            type: "task.answer",
            taskId,
            questionId: e.question.id,
            optionId: answer.optionId,
            other: answer.other,
          }),
      );
    }
    if (e.type === "approval.required") {
      approvalsShown.push(e.approval);
      const d = task.person?.approve?.(e.approval, world, approvalsShown.length) ?? "approve";
      const decision = typeof d === "string" ? d : "change";
      queueMicrotask(
        () =>
          void runtime.handle({
            type: "approval.decide",
            taskId,
            decision: {
              approvalId: e.approval.id,
              fingerprint: e.approval.fingerprint,
              decision,
              ...(typeof d === "object" ? { change: d.change } : {}),
            },
          }),
      );
    }
  });

  await runtime.handle({ type: "task.start", request: { ...task.request, id: taskId } });
  const t = runtime.task(taskId)!;
  const effects = [...world.web.effects, ...world.native.effects];
  const approved = audit.all(taskId).filter((e) => e.kind === "action" && e.approvalId).length;
  const final = [...events]
    .reverse()
    .find((e) => e.type === "task.done" || e.type === "task.failed" || e.type === "task.stopped");
  const run: EvalRun = { task, world, events, audit, effects, final, approvalsShown, questions };
  const metrics: EvalMetrics = {
    id: task.id,
    category: task.category,
    provider: model ? model.provider : "none (task pack)",
    success: task.success(run),
    outcome: final ? describeFinal(final) : "no ending",
    modelTurns: t.usage.modelTurns,
    actions: t.usage.actions,
    approvalsRequested: approvalsShown.length,
    questionsAsked: questions.length,
    consequentialEffects: effects.length,
    approvedExecutions: approved,
    consequentialWithoutApproval: Math.max(0, effects.length - approved),
    protocolViolations: wm?.violations.length ?? 0,
    agentMs: Math.max(0, Date.now() - t.startedAt - t.waitingMs),
    costUsd: Math.round(t.usage.costUsd * 10000) / 10000,
  };
  return { run, metrics };
}

function describeFinal(e: AgentEvent): string {
  if (e.type === "task.done") return `done (${e.verified ? "verified" : "NOT verified"})`;
  if (e.type === "task.failed") return `failed: ${e.reason}`;
  if (e.type === "task.stopped") return `stopped by ${e.by}`;
  return e.type;
}
