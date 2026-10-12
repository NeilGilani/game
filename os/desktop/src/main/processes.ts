/** The three supervised processes: agency-native, the agent utility process and the coordinator sidecar. */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type {
  AgentCommand,
  AgentEvent,
  AgentToHost,
  HostToAgent,
  NativeEvent,
  NativeMethod,
  NativeMethods,
} from "@agency/contracts";
import type { CoordinatorClient } from "./coordinator";
import { NativeRpcClient } from "./jsonrpc";
import type { Logger } from "./log";
import type { Running } from "./supervisor";

function pipeLines(stream: NodeJS.ReadableStream | null | undefined, onLine: (line: string) => void): void {
  if (!stream) return;
  let buf = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  });
}

function childRunning(child: ChildProcess): Running {
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  return {
    exited,
    kill: () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 3_000).unref();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// agency-native

export class NativeHost {
  readonly rpc: NativeRpcClient;
  private child: ChildProcess | null = null;

  constructor(
    private readonly spec: { command: string; args: string[]; fake: boolean },
    private readonly log: Logger,
    onEvent: (event: NativeEvent) => void,
    private readonly env: Record<string, string> = {},
  ) {
    this.rpc = new NativeRpcClient(onEvent);
  }

  get fake(): boolean {
    return this.spec.fake;
  }

  async start(): Promise<Running> {
    const child = spawn(this.spec.command, this.spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env, ...(this.spec.fake ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.rpc.receive(chunk));
    pipeLines(child.stderr, (line) => this.log.raw(line));
    child.stdin?.on("error", () => undefined);
    this.rpc.attach({ write: (line) => child.stdin?.write(line) });
    const running = childRunning(child);
    void running.exited.then(() => {
      if (this.child === child) {
        this.child = null;
        this.rpc.detach();
      }
    });
    this.log.info(`started ${this.spec.fake ? "fake " : ""}agency-native (pid ${child.pid})`);
    return running;
  }

  call<M extends NativeMethod>(
    method: M,
    params: NativeMethods[M]["params"],
    timeoutMs?: number,
  ): Promise<NativeMethods[M]["result"]> {
    return this.rpc.call(method, params, timeoutMs);
  }

  async health(): Promise<boolean> {
    await this.rpc.call("permissions.status", {}, 2_000);
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Agent utility process

/** The subset of Electron's UtilityProcess we use (so this file stays testable). */
export interface UtilityLike {
  pid?: number | undefined;
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  kill(): boolean;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
}

export type AgentRpc = (target: "native" | "bridge", method: string, params: unknown) => Promise<unknown>;

export class AgentHost {
  private proc: UtilityLike | null = null;
  private pingId = 0;
  private readonly pongs = new Map<number, () => void>();
  /** Set once the agent has answered a ping; until then health is process liveness only. */
  private answersPing = false;
  status: Record<string, unknown> | null = null;

  constructor(
    private readonly fork: () => UtilityLike,
    private readonly log: Logger,
    private readonly onEvent: (event: AgentEvent) => void,
    private readonly rpc: AgentRpc,
    readonly fake: boolean,
  ) {}

  get running(): boolean {
    return this.proc !== null;
  }

  async start(): Promise<Running> {
    const proc = this.fork();
    this.proc = proc;
    this.status = null;
    pipeLines(proc.stdout, (line) => this.log.raw(line));
    pipeLines(proc.stderr, (line) => this.log.raw(line));
    proc.on("message", (raw) => this.handle(raw as AgentToHost));
    const exited = new Promise<number | null>((resolve) =>
      proc.on("exit", (code) => {
        if (this.proc === proc) this.proc = null;
        resolve(code);
      }),
    );
    this.log.info(`started ${this.fake ? "fake " : ""}agent (pid ${proc.pid ?? "?"})`);
    // Probe once: agents that answer pings get real health checks.
    void this.ping(2_000).then((ok) => (this.answersPing = ok));
    return { exited, kill: () => void proc.kill() };
  }

  /** Returns false when no agent is running. */
  send(command: AgentCommand): boolean {
    if (!this.proc) return false;
    const msg: HostToAgent = { kind: "command", command };
    try {
      this.proc.postMessage(msg);
      return true;
    } catch {
      return false;
    }
  }

  async health(timeoutMs = 2_000): Promise<boolean> {
    if (!this.proc) return false;
    return this.answersPing ? this.ping(timeoutMs) : true;
  }

  private ping(timeoutMs: number): Promise<boolean> {
    const proc = this.proc;
    if (!proc) return Promise.resolve(false);
    const id = ++this.pingId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pongs.delete(id);
        resolve(false);
      }, timeoutMs);
      this.pongs.set(id, () => {
        clearTimeout(timer);
        resolve(true);
      });
      try {
        proc.postMessage({ kind: "ping", id } satisfies HostToAgent);
      } catch {
        // The process is going away: unhealthy, never an unhandled rejection in main.
        clearTimeout(timer);
        this.pongs.delete(id);
        resolve(false);
      }
    });
  }

  private reply(msg: HostToAgent): void {
    try {
      this.proc?.postMessage(msg);
    } catch {
      // The agent went away; its supervisor restarts it.
    }
  }

  private handle(msg: AgentToHost): void {
    if (!msg || typeof msg !== "object") return;
    switch (msg.kind) {
      case "event":
        this.onEvent(msg.event);
        break;
      case "status":
        this.status = msg.status;
        this.log.info(`agent status: ${JSON.stringify(msg.status)}`);
        break;
      case "pong":
        this.pongs.get(msg.id)?.();
        this.pongs.delete(msg.id);
        break;
      case "rpc":
        this.rpc(msg.target, msg.method, msg.params).then(
          (result) => this.reply({ kind: "rpc.result", id: msg.id, result }),
          (err: Error) => this.reply({ kind: "rpc.result", id: msg.id, error: err.message }),
        );
        break;
      case "log":
        if (msg.level === "info" || msg.level === "warn" || msg.level === "error")
          this.log[msg.level](msg.message);
        break;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Coordinator sidecar

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface SidecarSpec {
  command: string;
  args: string[];
  cwd: string;
  dataDir: string;
}

export class Sidecar {
  /** Generated once per app launch; the coordinator only accepts requests that carry it. */
  readonly token = randomBytes(24).toString("base64url");
  startupMs: number | null = null;

  constructor(
    private readonly spec: SidecarSpec,
    private readonly client: CoordinatorClient,
    private readonly log: Logger,
    private readonly readyTimeoutMs = 60_000,
  ) {}

  private port: number | null = null;

  async start(): Promise<Running> {
    // Keep the same address across restarts so the agent and any open pages keep working.
    const port = this.port ?? (await freePort());
    this.port = port;
    const t0 = Date.now();
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENCY_HOST: "127.0.0.1",
        AGENCY_PORT: String(port),
        AGENCY_API_TOKEN: this.token,
        AGENCY_DB_PATH: `${this.spec.dataDir}/agency.db`,
        // The desktop app serves the interface itself (agency://shell).
        AGENCY_FRONTEND_DIST: "/nonexistent",
        PYTHONUNBUFFERED: "1",
      },
    });
    pipeLines(child.stdout, (line) => this.log.raw(line));
    pipeLines(child.stderr, (line) => this.log.raw(line));
    const running = childRunning(child);
    this.starting = running;
    const url = `http://127.0.0.1:${port}`;
    this.client.set({ mode: "bundled", url, token: this.token });
    let exited = false;
    void running.exited.then(() => (exited = true));
    try {
      return await this.waitReady(running, url, t0, () => exited, child.pid);
    } finally {
      if (this.starting === running) this.starting = null;
    }
  }

  private starting: Running | null = null;

  /** AGENCY is quitting while the coordinator is still starting: end it now rather than leave it running. */
  cancelStart(): void {
    this.starting?.kill();
  }

  private async waitReady(
    running: Running,
    url: string,
    t0: number,
    exited: () => boolean,
    pid: number | undefined,
  ): Promise<Running> {
    while (!exited() && Date.now() - t0 < this.readyTimeoutMs) {
      if (await this.client.healthy(1_000)) {
        this.startupMs = Date.now() - t0;
        this.log.info(`coordinator ready on ${url} in ${this.startupMs} ms (pid ${pid})`);
        return running;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    running.kill();
    this.port = null; // maybe the port was taken: pick a new one next time
    throw new Error(
      exited() ? "coordinator exited during startup" : "coordinator did not become healthy in time",
    );
  }

  health(): Promise<boolean> {
    return this.client.healthy();
  }
}
