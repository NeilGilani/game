/**
 * Run one task on the pack agent and keep its state for the screen: the plan, notes, the
 * open question or approval, and the result. Speaks only the contract (AgentCommand and
 * AgentEvent), so it can switch to the real agent through window.agency without changes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ChoiceQuestion,
  PlanStepView,
  TaskRequest,
} from "../../../os/contracts/src/agent";
import type { PackAgent } from "../../../os/tasks/src/index";

export type TaskResult =
  | { type: "done"; outcome: string; verified: boolean; evidence?: string }
  | { type: "failed"; reason: string; recoverable: boolean }
  | { type: "stopped" };

export interface TaskView {
  taskId: string | null;
  goal: string;
  dryRun: boolean;
  steps: PlanStepView[];
  notes: string[];
  question: ChoiceQuestion | null;
  approval: ApprovalRequest | null;
  result: TaskResult | null;
}

const EMPTY: TaskView = {
  taskId: null,
  goal: "",
  dryRun: true,
  steps: [],
  notes: [],
  question: null,
  approval: null,
  result: null,
};

export function reduceTask(view: TaskView, e: AgentEvent): TaskView {
  if (view.taskId && e.taskId !== view.taskId) return view;
  switch (e.type) {
    case "task.started":
      return { ...EMPTY, taskId: e.taskId, goal: e.goal, dryRun: e.dryRun };
    case "task.plan":
      return { ...view, steps: e.steps };
    case "task.step":
      if (e.stepId === "note") return { ...view, notes: [...view.notes, e.summary] };
      return {
        ...view,
        steps: view.steps.map((s) => (s.id === e.stepId ? { ...s, status: e.status, title: s.title } : s)),
        notes: e.status === "failed" ? [...view.notes, e.summary] : view.notes,
      };
    case "task.question":
      return { ...view, question: e.question, approval: null };
    case "approval.required":
      return { ...view, approval: e.approval, question: null };
    case "task.done":
      return {
        ...view,
        question: null,
        approval: null,
        result: {
          type: "done",
          outcome: e.outcome,
          verified: e.verified,
          ...(e.evidence ? { evidence: e.evidence } : {}),
        },
      };
    case "task.failed":
      return {
        ...view,
        question: null,
        approval: null,
        result: { type: "failed", reason: e.reason, recoverable: e.recoverable },
      };
    case "task.stopped":
      return { ...view, question: null, approval: null, result: { type: "stopped" } };
  }
}

let seq = 0;

export function useAgentTask(agent: PackAgent) {
  const [view, setView] = useState<TaskView>(EMPTY);
  const taskRef = useRef<string | null>(null);
  // Commands are sent from event handlers, never inside state updaters (which may run twice).
  const viewRef = useRef<TaskView>(EMPTY);
  viewRef.current = view;

  useEffect(
    () =>
      agent.subscribe((e) => {
        if (e.taskId !== taskRef.current) return;
        setView((v) => reduceTask(v, e));
      }),
    [agent],
  );

  // Leaving the screen stops the task (a call hangs up, nothing is left half-done).
  useEffect(
    () => () => {
      if (taskRef.current) agent.send({ type: "task.stop", taskId: taskRef.current });
    },
    [agent],
  );

  const start = useCallback(
    (request: Omit<TaskRequest, "id">) => {
      seq += 1;
      const id = `talk-${Date.now().toString(36)}-${seq}`;
      taskRef.current = id;
      setView({ ...EMPTY, taskId: id, goal: request.goal });
      agent.send({ type: "task.start", request: { ...request, id } });
    },
    [agent],
  );

  const answer = useCallback(
    (optionId: string | null, other?: string) => {
      const taskId = taskRef.current;
      const question = viewRef.current.question;
      if (!taskId || !question) return;
      setView((v) => ({ ...v, question: null }));
      agent.send({
        type: "task.answer",
        taskId,
        questionId: question.id,
        optionId,
        ...(other !== undefined ? { other } : {}),
      });
    },
    [agent],
  );

  const decide = useCallback(
    (decision: ApprovalDecision["decision"], change?: string) => {
      const taskId = taskRef.current;
      const approval = viewRef.current.approval;
      if (!taskId || !approval) return;
      setView((v) => ({ ...v, approval: null }));
      agent.send({
        type: "approval.decide",
        taskId,
        decision: {
          approvalId: approval.id,
          fingerprint: approval.fingerprint,
          decision,
          ...(change ? { change } : {}),
        },
      });
    },
    [agent],
  );

  const stop = useCallback(() => {
    if (taskRef.current) agent.send({ type: "task.stop", taskId: taskRef.current });
  }, [agent]);

  const reset = useCallback(() => {
    if (taskRef.current && !view.result) agent.send({ type: "task.stop", taskId: taskRef.current });
    taskRef.current = null;
    setView(EMPTY);
  }, [agent, view.result]);

  return { view, start, answer, decide, stop, reset };
}
