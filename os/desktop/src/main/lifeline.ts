/**
 * Lifeline in the main process. Main is more reliable than any renderer, so it sends the heartbeat and owns
 * the help path. A help request surfaces the emergency screen first (synchronously), then posts to the
 * coordinator and keeps retrying in the background until it is accepted. Nothing awaits anything else first.
 */

import type { HelpResult, HelpSource } from "@agency/contracts";
import type { CoordinatorClient } from "./coordinator";
import type { Logger } from "./log";

export interface HeartbeatBody {
  signal_ready: boolean;
  camera: string;
  face_visible: boolean;
  page_visible: boolean;
  input_mode: string;
}

export interface LifelineOptions {
  client: CoordinatorClient;
  log: Logger;
  /** Bring the shell to the front with the emergency screen. Must not throw or block. */
  surface: () => void;
  heartbeat: () => HeartbeatBody;
  heartbeatMs?: number;
  /** How long help() waits for the first attempt before answering the caller. Retries continue regardless. */
  firstAttemptMs?: number;
  retryMs?: { initial: number; max: number };
}

interface HelpResponse {
  alert?: { id?: string } | null;
  created?: boolean;
}

export class LifelineHost {
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private lastBeatAt: string | null = null;
  private lastBeatOk = false;
  private pendingHelp: { source: HelpSource; test: boolean } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay: number;
  private inFlight: Promise<HelpResult> | null = null;

  constructor(private readonly opts: LifelineOptions) {
    this.retryDelay = opts.retryMs?.initial ?? 1_000;
  }

  start(): void {
    if (this.beatTimer) return;
    void this.beat();
    this.beatTimer = setInterval(() => void this.beat(), this.opts.heartbeatMs ?? 5_000);
  }

  stop(): void {
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  get heartbeatStatus(): { lastHeartbeatAt: string | null; lastHeartbeatOk: boolean } {
    return { lastHeartbeatAt: this.lastBeatAt, lastHeartbeatOk: this.lastBeatOk };
  }

  get helpPending(): boolean {
    return this.pendingHelp !== null;
  }

  async beat(): Promise<boolean> {
    try {
      await this.opts.client.request("POST", "/api/lifeline/heartbeat", this.opts.heartbeat(), 3_000);
      this.lastBeatAt = new Date().toISOString();
      this.lastBeatOk = true;
    } catch (err) {
      if (this.lastBeatOk) this.opts.log.warn(`heartbeat failed: ${(err as Error).message}`);
      this.lastBeatOk = false;
    }
    return this.lastBeatOk;
  }

  help(source: HelpSource, test = false): Promise<HelpResult> {
    // 1. Surface first. Never let a surfacing failure stop the request.
    try {
      this.opts.surface();
    } catch (err) {
      this.opts.log.error(`surface failed: ${(err as Error).message}`);
    }
    // 2. A real request upgrades a pending test request; otherwise keep the first one.
    if (!this.pendingHelp || (this.pendingHelp.test && !test)) this.pendingHelp = { source, test };
    this.opts.log.info(`help requested (source=${source}${test ? ", test" : ""})`);
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const attempt = this.inFlight ?? this.attempt();
    // 3. Answer the caller quickly; retries continue in the background.
    const wait = this.opts.firstAttemptMs ?? 2_500;
    return Promise.race([
      attempt,
      new Promise<HelpResult>((resolve) =>
        setTimeout(() => resolve({ delivered: false, alertId: null, created: false }), wait),
      ),
    ]);
  }

  private attempt(): Promise<HelpResult> {
    const req = this.pendingHelp;
    if (!req) return Promise.resolve({ delivered: true, alertId: null, created: false });
    const run = (async (): Promise<HelpResult> => {
      try {
        const res = await this.opts.client.request<HelpResponse>("POST", "/api/lifeline/help", req, 5_000);
        if (this.pendingHelp === req) this.pendingHelp = null;
        this.retryDelay = this.opts.retryMs?.initial ?? 1_000;
        const alertId = res.alert?.id ?? null;
        this.opts.log.info(`help delivered (alert ${alertId ?? "?"}, created=${Boolean(res.created)})`);
        return { delivered: true, alertId, created: Boolean(res.created) };
      } catch (err) {
        this.opts.log.error(
          `help not delivered yet: ${(err as Error).message}; retrying in ${this.retryDelay} ms`,
        );
        this.scheduleRetry();
        return { delivered: false, alertId: null, created: false };
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = run;
    return run;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.pendingHelp) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.opts.retryMs?.max ?? 15_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attempt();
    }, delay);
  }
}
