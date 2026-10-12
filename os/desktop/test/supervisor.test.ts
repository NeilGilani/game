import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Supervisor, type Running } from "../src/main/supervisor";
import { deferred, quietLog } from "./helpers";

function fakeProcess() {
  const exit = deferred<number | null>();
  let killed = false;
  const running: Running = {
    exited: exit.promise,
    kill: () => {
      killed = true;
      exit.resolve(null);
    },
  };
  return { running, exit, killed: () => killed };
}

describe("Supervisor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("restarts with exponential backoff and reports states", async () => {
    const procs: ReturnType<typeof fakeProcess>[] = [];
    const states: string[] = [];
    const sup = new Supervisor({
      name: "x",
      start: async () => {
        const p = fakeProcess();
        procs.push(p);
        return p.running;
      },
      backoffMs: { initial: 100, max: 400 },
      log: quietLog(),
      onState: (s) => states.push(s),
    });
    await sup.start();
    expect(sup.status).toBe("running");

    procs[0]!.exit.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.status).toBe("restarting");
    await vi.advanceTimersByTimeAsync(99);
    expect(procs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(procs).toHaveLength(2);

    procs[1]!.exit.resolve(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(procs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(procs).toHaveLength(3);

    // Capped at max.
    procs[2]!.exit.resolve(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(procs).toHaveLength(4);
    procs[3]!.exit.resolve(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(procs).toHaveLength(5);
    expect(states).toContain("starting");
    expect(states).toContain("restarting");
    await sup.stop();
    expect(sup.status).toBe("stopped");
  });

  it("kills and restarts after repeated failed health checks", async () => {
    const procs: ReturnType<typeof fakeProcess>[] = [];
    let healthy = true;
    const sup = new Supervisor({
      name: "x",
      start: async () => {
        const p = fakeProcess();
        procs.push(p);
        return p.running;
      },
      health: async () => healthy,
      healthIntervalMs: 1000,
      healthFailures: 2,
      backoffMs: { initial: 50, max: 50 },
      log: quietLog(),
    });
    await sup.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(procs).toHaveLength(1);
    healthy = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(procs[0]!.killed()).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(procs).toHaveLength(2);
    await sup.stop();
  });

  it("gives up after maxRestarts and reports failed", async () => {
    const sup = new Supervisor({
      name: "x",
      start: async () => {
        throw new Error("no binary");
      },
      backoffMs: { initial: 10, max: 10 },
      maxRestarts: 3,
      log: quietLog(),
    });
    await sup.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(sup.status).toBe("failed");
    expect(sup.restartCount).toBe(3);
  });

  it("does not restart after stop()", async () => {
    let starts = 0;
    const sup = new Supervisor({
      name: "x",
      start: async () => {
        starts += 1;
        return fakeProcess().running;
      },
      log: quietLog(),
    });
    await sup.start();
    await sup.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toBe(1);
    expect(sup.status).toBe("stopped");
  });

  it("stop() while still starting cancels the start and leaves no process behind (quit during startup)", async () => {
    // Like the coordinator: the process exists at once, but start() only resolves once it is healthy.
    const proc = fakeProcess();
    const ready = deferred<void>();
    let cancelled = false;
    const sup = new Supervisor({
      name: "coordinator",
      start: async () => {
        await ready.promise;
        if (proc.killed()) throw new Error("coordinator exited during startup");
        return proc.running;
      },
      cancelStart: () => {
        cancelled = true;
        proc.running.kill();
        ready.resolve();
      },
      log: quietLog(),
    });
    void sup.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(sup.status).toBe("starting");
    await sup.stop();
    expect(cancelled).toBe(true);
    expect(proc.killed()).toBe(true);
    expect(sup.status).toBe("stopped");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sup.status).toBe("stopped"); // and no restart
  });

  it("stop() while starting still kills a process that came up anyway", async () => {
    const proc = fakeProcess();
    const ready = deferred<void>();
    const sup = new Supervisor({
      name: "x",
      start: async () => {
        await ready.promise;
        return proc.running;
      },
      log: quietLog(),
    });
    void sup.start();
    const stopped = sup.stop();
    ready.resolve();
    await stopped;
    expect(proc.killed()).toBe(true);
  });
});
