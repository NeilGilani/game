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
import { STOP_ALL_EVENT } from "../components/common";
import { useConnection } from "./connection";
import { FakeAgent } from "./fakeAgent";
import { fakeForced, host } from "./host";
import { answered, decided, newTask, reduceTask, type TaskView } from "./tasks";

interface AgentLink {
  send(command: AgentCommand): void;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /** True when this is the in-page fake: everything it does is simulated. */
  simulated: boolean;
  /** Mac app only: stop the practice tasks (main stops its own agent; this must not echo stop.all to it). */
  stopPractice?: () => void;
}

function fakeDelay(): number {
  try {
    const v = Number(localStorage.getItem("agency.fakeAgentDelayMs"));
    return Number.isFinite(v) && v > 0 ? v : 450;
  } catch {
    return 450;
  }
}

/**
 * Tasks done on practice services (food, shopping, calls, messages, papers): the same practice world in the Mac app
 * as in the browser, so they take seconds (Gemini plans through Synapse, then the steps run). The Mac app's agent
 * runtime, which works the real Mac by reading the screen, keeps everything that needs the real Mac (Music, Chrome,
 * opening apps).
 */
const PRACTICE_KINDS = new Set(["food", "shopping", "call", "message", "papers"]);

export function practiceTask(request: TaskRequest): boolean {
  return PRACTICE_KINDS.has(request.selections?.kind ?? "");
}

function connect(): AgentLink {
  const h = host();
  const fake = new FakeAgent(fakeDelay());
  if (!h || fakeForced("agent")) {
    return { send: (c) => fake.send(c), onEvent: (l) => fake.onEvent(l), simulated: true };
  }
  // Each task goes to one of the two, and every later command for it follows.
  const practice = new Set<string>();
  return {
    send: (c) => {
      if (c.type === "task.start") {
        if (practiceTask(c.request)) {
          practice.add(c.request.id);
          fake.send(c);
        } else h.agent.send(c);
      } else if (c.type === "stop.all") {
        fake.send(c);
        h.agent.send(c);
      } else if (practice.has(c.taskId)) fake.send(c);
      else h.agent.send(c);
    },
    onEvent: (l) => {
      const offFake = fake.onEvent(l);
      const offHost = h.agent.onEvent(l);
      return () => {
        offFake();
        offHost();
      };
    },
    simulated: false,
    stopPractice: () => fake.send({ type: "stop.all" }),
  };
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

  // Stop agent pauses all automation on the coordinator; until Resume agent, no new task may start here either
  // (the banner promises that nothing runs).
  const { health } = useConnection();
  const halted = useRef(false);
  halted.current = !!health?.automation_paused;

  const start = useCallback(
    (req: Omit<TaskRequest, "id"> & { id?: string }) => {
      const request: TaskRequest = { dryRun: true, ...req, id: req.id ?? taskId() };
      order.current = [request.id, ...order.current];
      if (halted.current) {
        const now = Date.now();
        const refused = reduceTask(
          newTask(request, now),
          {
            type: "task.failed",
            taskId: request.id,
            reason: "All automation is stopped, so nothing was done. Press Resume agent, then try again.",
            recoverable: true,
          },
          now,
        );
        setTasks((all) => ({ ...all, [request.id]: refused }));
        return request.id;
      }
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
      window.dispatchEvent(new Event(STOP_ALL_EVENT));
      const h = link.simulated ? null : host();
      if (h) {
        void h.stopAll();
        link.stopPractice?.();
      } else link.send({ type: "stop.all" });
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
