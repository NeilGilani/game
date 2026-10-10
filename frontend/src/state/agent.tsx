/**
 * Tasks the person started, and the agent that carries them out: the Mac app's agent runtime through
 * `window.agency.agent`, or the in-page fake (simulated) everywhere else.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AgentCommand, AgentEvent, ApprovalDecision, TaskRequest } from "./contracts";
import { FakeAgent } from "./fakeAgent";
import { fakeForced, host } from "./host";
import { answered, decided, newTask, reduceTask, type TaskView } from "./tasks";

interface AgentLink {
  send(command: AgentCommand): void;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /** True when this is the in-page fake: everything it does is simulated. */
  simulated: boolean;
}

function fakeDelay(): number {
  try {
    const v = Number(localStorage.getItem("agency.fakeAgentDelayMs"));
    return Number.isFinite(v) && v > 0 ? v : 700;
  } catch {
    return 700;
  }
}

function connect(): AgentLink {
  const h = host();
  if (h && !fakeForced("agent")) {
    return { send: (c) => h.agent.send(c), onEvent: (l) => h.agent.onEvent(l), simulated: false };
  }
  const fake = new FakeAgent(fakeDelay());
  return { send: (c) => fake.send(c), onEvent: (l) => fake.onEvent(l), simulated: true };
}

export interface AgentState {
  tasks: TaskView[];
  task(id: string): TaskView | undefined;
  /** Start a task; returns its id. */
  start(request: Omit<TaskRequest, "id"> & { id?: string }): string;
  answer(taskId: string, questionId: string, optionId: string | null): void;
  decide(taskId: string, decision: ApprovalDecision): void;
  pause(taskId: string): void;
  resume(taskId: string): void;
  stop(taskId: string): void;
  /** Stop every task and all synthetic input at once. */
  stopAll(): void;
  /** Forget a finished task (from Continue). */
  dismiss(taskId: string): void;
  simulated: boolean;
}

const AgentContext = createContext<AgentState | null>(null);

let counter = 0;
function taskId(): string {
  counter += 1;
  return `task-${Date.now().toString(36)}-${counter}`;
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const link = useMemo(connect, []);
  const [tasks, setTasks] = useState<Record<string, TaskView>>({});
  const order = useRef<string[]>([]);

  useEffect(
    () =>
      link.onEvent((e) =>
        setTasks((all) => {
          const t = all[e.taskId];
          return t ? { ...all, [e.taskId]: reduceTask(t, e, Date.now()) } : all;
        }),
      ),
    [link],
  );

  const start = useCallback(
    (req: Omit<TaskRequest, "id"> & { id?: string }) => {
      const request: TaskRequest = { dryRun: true, ...req, id: req.id ?? taskId() };
      order.current = [request.id, ...order.current];
      setTasks((all) => ({ ...all, [request.id]: newTask(request, Date.now()) }));
      link.send({ type: "task.start", request });
      return request.id;
    },
    [link],
  );

  const value: AgentState = {
    tasks: order.current.map((id) => tasks[id]).filter((t): t is TaskView => !!t),
    task: (id) => tasks[id],
    start,
    answer: (id, questionId, optionId) => {
      setTasks((all) => (all[id] ? { ...all, [id]: answered(all[id], Date.now()) } : all));
      link.send({ type: "task.answer", taskId: id, questionId, optionId });
    },
    decide: (id, decision) => {
      setTasks((all) => (all[id] ? { ...all, [id]: decided(all[id], decision.decision, Date.now()) } : all));
      link.send({ type: "approval.decide", taskId: id, decision });
    },
    pause: (id) => {
      setTasks((all) => (all[id] ? { ...all, [id]: { ...all[id], phase: "paused" } } : all));
      link.send({ type: "task.pause", taskId: id });
    },
    resume: (id) => {
      setTasks((all) =>
        all[id]
          ? {
              ...all,
              [id]: {
                ...all[id],
                phase: all[id].approval ? "approval" : all[id].question ? "question" : "working",
              },
            }
          : all,
      );
      link.send({ type: "task.resume", taskId: id });
    },
    stop: (id) => link.send({ type: "task.stop", taskId: id }),
    stopAll: () => {
      // In the Mac app, main stops the agent and all synthetic input itself (and tells every window); sending
      // stop.all here too would echo every broadcast back.
      const h = link.simulated ? null : host();
      if (h) void h.stopAll();
      else link.send({ type: "stop.all" });
    },
    dismiss: (id) => {
      order.current = order.current.filter((x) => x !== id);
      setTasks((all) => {
        const next = { ...all };
        delete next[id];
        return next;
      });
    },
    simulated: link.simulated,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentState {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent outside AgentProvider");
  return ctx;
}
