/**
 * Runs a predefined task pack (Instance 8). Works without an API key. Packs get the same guarded tools as the
 * model, so the same approvals, limits and refusals apply.
 */

import type { GuardedTools } from "../tools/guarded";
import { ToolError } from "../tools/guarded";
import type { TaskPack } from "../types";
import type { Asker, RunResult } from "./runtime";
import { TaskStopped, withActiveTimeout, type TaskRun } from "./task";

export async function runPack(
  task: TaskRun,
  pack: TaskPack,
  tools: GuardedTools,
  ask: Asker,
): Promise<RunResult> {
  const steps = pack.steps(task.request);
  task.setPlan(steps.map((s) => ({ id: s.id, title: s.title, risk: s.risk })));
  const values: Record<string, string> = { ...(task.request.selections ?? {}) };
  const evidence: string[] = [];

  for (const step of steps) {
    let lastError = "";
    let done = false;
    for (let attempt = 1; attempt <= task.budgets.maxStepAttempts && !done; attempt++) {
      await task.checkpoint();
      tools.setWhy(step.title);
      task.stepStatus(step.id, "running", attempt === 1 ? step.title : `${step.title} (try ${attempt})`);
      try {
        const outcome = await withActiveTimeout(
          task,
          step.run({ request: task.request, tools, ask, values }),
          task.budgets.toolTimeoutMs * 4,
          step.title,
        );
        if (outcome.verified) {
          task.stepStatus(step.id, "done", outcome.summary, outcome.evidence);
          if (outcome.evidence) evidence.push(outcome.evidence);
          done = true;
        } else {
          lastError = outcome.summary;
          if (/^(declined|refused|not done)/i.test(outcome.summary)) break;
        }
      } catch (e) {
        if (e instanceof TaskStopped) throw e;
        lastError = e instanceof Error ? e.message : String(e);
        if (!(e instanceof ToolError)) break;
      }
    }
    if (!done) {
      task.stepStatus(step.id, "failed", lastError || "This step did not work.");
      return {
        kind: "failed",
        reason: `${step.title}: ${lastError || "this step did not work."}`,
        recoverable: true,
      };
    }
  }
  return { kind: "done", outcome: `${pack.title}: done.`, verified: true, evidence: evidence.join(" ") };
}
