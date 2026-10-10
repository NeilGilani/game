/**
 * PackAgent: an in-process agent that only runs task packs. It speaks the contract exactly
 * (AgentCommand in, AgentEvent out), so the Talk screens and Instance 7's task UI can use it
 * before the real agent (os/agent) lands, and the real agent can embed it for its pack tier.
 * It never calls a model.
 */

import type { AgentCommand, AgentEvent, TaskRequest } from "../contracts";
import type { TaskPack } from "./pack";
import { PackRun, type AuditEntry } from "./runner";

export type AgentListener = (event: AgentEvent) => void;

export function choosePack(packs: readonly TaskPack[], request: TaskRequest): TaskPack | null {
  const named = request.selections?.pack;
  if (named) return packs.find((p) => p.id === named) ?? null;
  let best: { pack: TaskPack; score: number } | null = null;
  for (const pack of packs) {
    const score = pack.matches(request);
    if (score > 0.5 && (!best || score > best.score)) best = { pack, score };
  }
  return best?.pack ?? null;
}

export class PackAgent {
  private readonly listeners = new Set<AgentListener>();
  private readonly runs = new Map<string, PackRun>();
  readonly auditLog: AuditEntry[] = [];
  readonly events: AgentEvent[] = [];

  constructor(private readonly packs: readonly TaskPack[]) {}

  subscribe(listener: AgentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit = (event: AgentEvent): void => {
    this.events.push(event);
    for (const l of this.listeners) l(event);
  };

  send(command: AgentCommand): void {
    if (command.type === "task.start") {
      void this.start(command.request);
      return;
    }
    if (command.type === "stop.all") {
      for (const run of this.runs.values()) run.handle(command);
      return;
    }
    this.runs.get(command.taskId)?.handle(command);
  }

  /** Start a task and resolve when it ends (done, failed or stopped). */
  async start(request: TaskRequest): Promise<void> {
    const pack = choosePack(this.packs, request);
    if (!pack) {
      this.emit({
        type: "task.started",
        taskId: request.id,
        goal: request.goal,
        dryRun: request.dryRun ?? true,
      });
      this.emit({
        type: "task.failed",
        taskId: request.id,
        reason: "No task pack can do this yet. The full agent is needed for it.",
        recoverable: false,
      });
      return;
    }
    const run = new PackRun(pack, request, { emit: this.emit, audit: (e) => this.auditLog.push(e) });
    this.runs.set(request.id, run);
    await run.start();
  }
}
