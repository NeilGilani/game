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
  let outcomeText: string | undefined;
  // Stop wins at once, even while a step waits for a page: the step's own next action would refuse anyway.
  const stopped = new Promise<never>((_, reject) => {
    const fail = () => reject(new TaskStopped(task.stopped ?? "person"));
    if (task.abort.signal.aborted) fail();
    else task.abort.signal.addEventListener("abort", fail, { once: true });
  });
  stopped.catch(() => undefined);

  for (const step of steps) {
    let lastError = "";
    let done = false;
    for (let attempt = 1; attempt <= task.budgets.maxStepAttempts && !done; attempt++) {
      await task.checkpoint();
      tools.setWhy(step.title);
      task.stepStatus(step.id, "running", attempt === 1 ? step.title : `${step.title} (try ${attempt})`);
      try {
        const outcome = await Promise.race([
          withActiveTimeout(
            task,
            step.run({
              request: task.request,
              tools,
              ask,
              values,
              checkpoint: () => task.checkpoint(),
              signal: task.abort.signal,
            }),
            task.budgets.toolTimeoutMs * 4,
            step.title,
          ),
          stopped,
        ]);
        if (outcome.verified) {
          task.stepStatus(step.id, "done", outcome.summary, outcome.evidence);
          if (outcome.evidence) evidence.push(outcome.evidence);
          if (outcome.outcome) outcomeText = outcome.outcome;
          done = true;
        } else if (outcome.unconfirmed) {
          task.stepStatus(step.id, "failed", outcome.summary, outcome.evidence);
          return {
            kind: "done",
            outcome: outcome.outcome ?? outcome.summary,
            verified: false,
            evidence: [...evidence, outcome.evidence].filter(Boolean).join(" "),
          };
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
      // "declined: ", "refused: " and "not done: " tell this runner not to retry; the person needn't read them.
      const why = lastError.replace(/^(declined|refused|not done):\s*/i, "");
      task.stepStatus(step.id, "failed", why || "This step did not work.");
      return {
        kind: "failed",
        reason: `${step.title}: ${why || "this step did not work."}`,
        recoverable: true,
      };
    }
  }
  return {
    kind: "done",
    outcome: outcomeText ?? `${pack.title}: done.`,
    verified: true,
    evidence: evidence.join(" "),
  };
}
