/**
 * Keeps a child process alive: start, health checks, restart with exponential backoff, and a clean stop.
 * Process-agnostic so it can supervise agency-native (child_process), the agent (utilityProcess) and the
 * coordinator sidecar, and be unit-tested with fakes.
 */

import type { ProcessState } from "@agency/contracts";
import type { Logger } from "./log";

export interface Running {
  /** Resolves with the exit code (or null) when the process ends for any reason. */
  exited: Promise<number | null>;
  kill(): void;
}

export interface SupervisorOptions {
  name: string;
  start(): Promise<Running>;
  /**
   * Abandon a start still in progress (stop() was called while waiting for the process to become ready): kill what
   * is starting so start() settles promptly. Without it, stop() waits for start() to settle and then kills the result.
   */
  cancelStart?(): void;
  /** Resolves true when healthy. Called every `healthIntervalMs` while running. */
  health?: () => Promise<boolean>;
  healthIntervalMs?: number;
  /** Consecutive failed health checks before a restart. */
  healthFailures?: number;
  backoffMs?: { initial: number; max: number };
  /** A run that lasts this long resets the backoff. */
  stableMs?: number;
  /** Give up (state "failed") after this many restarts in a row without a stable run. */
  maxRestarts?: number;
  log: Logger;
  onState?: (state: ProcessState) => void;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; now: () => number };
}

export class Supervisor {
  private state: ProcessState = "stopped";
  private current: Running | null = null;
  private starting: Promise<Running> | null = null;
  private stopping = false;
  private restarts = 0;
  private backoff: number;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failedChecks = 0;
  private readonly t: NonNullable<SupervisorOptions["timers"]>;

  constructor(private readonly opts: SupervisorOptions) {
    this.backoff = opts.backoffMs?.initial ?? 500;
    this.t = opts.timers ?? { setTimeout, clearTimeout, now: () => Date.now() };
  }

  get status(): ProcessState {
    return this.state;
  }

  get restartCount(): number {
    return this.restarts;
  }

  private set(state: ProcessState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState?.(state);
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.launch();
  }

  private async launch(): Promise<void> {
    if (this.stopping) return;
    this.set(this.restarts === 0 ? "starting" : "restarting");
    let running: Running;
    const starting = this.opts.start();
    this.starting = starting;
    try {
      running = await starting;
    } catch (err) {
      if (this.stopping) return;
      this.opts.log.error(`start failed: ${(err as Error).message}`);
      this.scheduleRestart();
      return;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
    if (this.stopping) {
      running.kill();
      return;
    }
    this.current = running;
    const startedAt = this.t.now();
    this.set("running");
    this.failedChecks = 0;
    this.scheduleHealth();
    void running.exited.then((code) => {
      if (this.current !== running) return;
      this.current = null;
      this.clearHealth();
      if (this.stopping) {
        this.set("stopped");
        return;
      }
      this.opts.log.warn(`exited with code ${code}`);
      if (this.t.now() - startedAt >= (this.opts.stableMs ?? 30_000)) {
        this.restarts = 0;
        this.backoff = this.opts.backoffMs?.initial ?? 500;
      }
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    const max = this.opts.maxRestarts ?? 20;
    if (this.restarts >= max) {
      this.opts.log.error(`giving up after ${this.restarts} restarts`);
      this.set("failed");
      return;
    }
    this.restarts += 1;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.backoffMs?.max ?? 30_000);
    this.set("restarting");
    this.opts.log.info(`restarting in ${delay} ms (attempt ${this.restarts})`);
    this.restartTimer = this.t.setTimeout(() => {
      this.restartTimer = null;
      void this.launch();
    }, delay);
  }

  private scheduleHealth(): void {
    const check = this.opts.health;
    if (!check) return;
    this.healthTimer = this.t.setTimeout(async () => {
      this.healthTimer = null;
      const running = this.current;
      if (!running) return;
      let ok = false;
      try {
        ok = await check();
      } catch {
        ok = false;
      }
      if (this.current !== running) return;
      this.failedChecks = ok ? 0 : this.failedChecks + 1;
      if (this.failedChecks >= (this.opts.healthFailures ?? 3)) {
        this.opts.log.warn(`unhealthy (${this.failedChecks} failed checks), killing`);
        this.failedChecks = 0;
        running.kill(); // the exit handler restarts it
        return;
      }
      this.scheduleHealth();
    }, this.opts.healthIntervalMs ?? 5_000);
  }

  private clearHealth(): void {
    if (this.healthTimer) this.t.clearTimeout(this.healthTimer);
    this.healthTimer = null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearHealth();
    if (this.restartTimer) this.t.clearTimeout(this.restartTimer);
    this.restartTimer = null;
    // Stopped while still starting (quitting during the coordinator's startup): never leave that process behind.
    const starting = this.starting;
    if (starting) {
      this.opts.cancelStart?.();
      const late = await starting.catch(() => null);
      if (late) {
        late.kill();
        await late.exited;
      }
    }
    const running = this.current;
    if (running) {
      running.kill();
      await running.exited;
    }
    this.current = null;
    this.set("stopped");
  }
}
