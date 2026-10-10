import type { AgentEvent, ChoiceQuestion, TaskRequest } from "../src/contracts";
import { PackAgent } from "../src/core/agent";
import type { TaskPack } from "../src/core/pack";

export interface Script {
  /** Pick an option id (or { other }) for a question; return null to stop the task. */
  answer?: (q: ChoiceQuestion, events: AgentEvent[]) => string | { other: string } | null;
  approve?: (summary: string, details: Record<string, string>) => "approve" | "decline" | "change";
}

/** Runs a pack with scripted answers and approvals, and returns every event. */
export async function runPack(pack: TaskPack, request: Partial<TaskRequest>, script: Script = {}) {
  const agent = new PackAgent([pack]);
  const events: AgentEvent[] = [];
  agent.subscribe((e) => {
    events.push(e);
    if (e.type === "task.question") {
      const a = script.answer ? script.answer(e.question, events) : e.question.options[0]!.id;
      queueMicrotask(() => {
        if (a === null) agent.send({ type: "task.stop", taskId: e.taskId });
        else if (typeof a === "string")
          agent.send({ type: "task.answer", taskId: e.taskId, questionId: e.question.id, optionId: a });
        else
          agent.send({
            type: "task.answer",
            taskId: e.taskId,
            questionId: e.question.id,
            optionId: null,
            other: a.other,
          });
      });
    }
    if (e.type === "approval.required") {
      const d = script.approve?.(e.approval.summary, e.approval.details) ?? "approve";
      queueMicrotask(() =>
        agent.send({
          type: "approval.decide",
          taskId: e.taskId,
          decision: { approvalId: e.approval.id, fingerprint: e.approval.fingerprint, decision: d },
        }),
      );
    }
  });
  await agent.start({
    id: `t-${Math.random().toString(36).slice(2)}`,
    goal: "test",
    origin: "home",
    ...request,
  } as TaskRequest);
  return { events, agent, last: events.at(-1)! };
}

export const ofType = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
