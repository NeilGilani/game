/**
 * AGENCY's side of the bridge, for the Electron main process (or the agent utility process): a Unix
 * socket server the native host connects to, the authenticated session with the extension, and a typed
 * `call()` for every bridge method.
 *
 *   const bridge = new BridgeServer({ socketPath, token });
 *   await bridge.start();
 *   bridge.onEvent((e) => { if (e.type === "targets") overlay.send(e.snapshot); });
 *   const tabs = await bridge.call("tabs.list", {});
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { SignedChannel, hmac, hmacKey, hmacVerify, randomHex, readyText, welcomeText } from "../auth.ts";
import { LineDecoder } from "../host/framing.ts";
import { hostAuthMac } from "../host/host.ts";
import type {
  BridgeError,
  BridgeEvent,
  BridgeMethod,
  BridgeRequest,
  BridgeResponse,
  ParamsOf,
  ResultOf,
  WireMessage,
} from "../protocol.ts";

export type BridgeConnection = "no-host" | "host-connected" | "ready";

export interface CallOptions {
  /** Milliseconds; null waits forever (policy.requestAllowance waits for the person). Default 30 s. */
  timeoutMs?: number | null;
}

/** What the agent and the main process program against; FakeBridge implements it too. */
export interface BridgeApi {
  call<M extends BridgeMethod>(method: M, params: ParamsOf<M>, opts?: CallOptions): Promise<ResultOf<M>>;
  onEvent(fn: (e: BridgeEvent) => void): () => void;
  onConnection(fn: (c: BridgeConnection, info?: { extensionVersion?: string }) => void): () => void;
  readonly connection: BridgeConnection;
}

export class BridgeCallError extends Error {
  constructor(readonly error: BridgeError) {
    super(`${error.code}: ${error.message}`);
  }
  get code(): BridgeError["code"] {
    return this.error.code;
  }
}

export interface BridgeServerOptions {
  socketPath: string;
  /** 64 hex chars, from the pairing file (see pairing.ts). */
  token: string;
  log?: (msg: string) => void;
}

const DEFAULT_TIMEOUTS: Partial<Record<BridgeMethod, number | null>> = {
  "policy.requestAllowance": null,
  "page.waitFor": 125_000,
  "tabs.open": 40_000,
  "tabs.navigate": 40_000,
  "page.click": 40_000,
};

export class BridgeServer implements BridgeApi {
  private server: Server | null = null;
  private sock: Socket | null = null;
  private channel: SignedChannel | null = null;
  private pendingWelcome: { session: string } | null = null;
  private keyP: Promise<CryptoKey>;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private eventFns = new Set<(e: BridgeEvent) => void>();
  private connFns = new Set<(c: BridgeConnection, info?: { extensionVersion?: string }) => void>();
  private _connection: BridgeConnection = "no-host";
  private extensionVersion: string | undefined;

  constructor(private readonly opts: BridgeServerOptions) {
    this.keyP = hmacKey(opts.token);
  }

  get connection(): BridgeConnection {
    return this._connection;
  }

  async start(): Promise<void> {
    const path = this.opts.socketPath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) unlinkSync(path);
    this.server = createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(path, () => resolve());
    });
    chmodSync(path, 0o600);
  }

  async stop(): Promise<void> {
    this.failAll("The bridge is shutting down.");
    this.sock?.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    if (existsSync(this.opts.socketPath)) unlinkSync(this.opts.socketPath);
  }

  onEvent(fn: (e: BridgeEvent) => void): () => void {
    this.eventFns.add(fn);
    return () => this.eventFns.delete(fn);
  }

  onConnection(fn: (c: BridgeConnection, info?: { extensionVersion?: string }) => void): () => void {
    this.connFns.add(fn);
    return () => this.connFns.delete(fn);
  }

  /** Resolves when the extension has completed the handshake. */
  waitUntilReady(timeoutMs = 30_000): Promise<void> {
    if (this._connection === "ready") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        off();
        reject(new Error("The AGENCY Bridge extension didn't connect in time."));
      }, timeoutMs);
      const off = this.onConnection((c) => {
        if (c === "ready") {
          clearTimeout(t);
          off();
          resolve();
        }
      });
    });
  }

  async call<M extends BridgeMethod>(method: M, params: ParamsOf<M>, opts: CallOptions = {}): Promise<ResultOf<M>> {
    const ch = this.channel;
    const sock = this.sock;
    if (!ch || !sock || this._connection !== "ready")
      throw new BridgeCallError({ code: "not-paired", message: "Chrome with the AGENCY Bridge isn't connected." });
    const id = String(this.nextId++);
    const req: BridgeRequest = { id, method, params };
    const timeout = opts.timeoutMs !== undefined ? opts.timeoutMs : (DEFAULT_TIMEOUTS[method] ?? 30_000);
    const result = new Promise<unknown>((resolve, reject) => {
      const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
      if (timeout !== null)
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new BridgeCallError({ code: "timeout", message: `${method} took longer than ${timeout} ms.` }));
        }, timeout);
      this.pending.set(id, entry);
    });
    sock.write(JSON.stringify(await ch.seal("cmd", req)) + "\n");
    return result as Promise<ResultOf<M>>;
  }

  private setConnection(c: BridgeConnection): void {
    if (this._connection === c) return;
    this._connection = c;
    const info = c === "ready" && this.extensionVersion !== undefined ? { extensionVersion: this.extensionVersion } : undefined;
    for (const fn of this.connFns) fn(c, info);
  }

  private log(m: string): void {
    this.opts.log?.(m);
  }

  private failAll(message: string): void {
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new BridgeCallError({ code: "not-paired", message }));
      this.pending.delete(id);
    }
  }

  private accept(s: Socket): void {
    const nonce = randomBytes(16).toString("hex");
    let authed = false;
    const lines = new LineDecoder();
    s.write(JSON.stringify({ t: "challenge", nonce }) + "\n");
    const authTimer = setTimeout(() => {
      if (!authed) s.destroy();
    }, 5000);

    s.on("data", (chunk: Buffer) => {
      let ls: string[];
      try {
        ls = lines.push(chunk);
      } catch {
        s.destroy();
        return;
      }
      for (const line of ls) {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!authed) {
          const expected = Buffer.from(hostAuthMac(this.opts.token, nonce), "hex");
          const got = typeof m.mac === "string" && /^[0-9a-f]{64}$/.test(m.mac) ? Buffer.from(m.mac, "hex") : Buffer.alloc(32);
          if (m.t !== "auth" || !timingSafeEqual(expected, got)) {
            this.log("refused a socket connection that doesn't know the pairing token");
            s.destroy();
            return;
          }
          authed = true;
          clearTimeout(authTimer);
          // The newest host wins (Chrome restarted, or a new profile was opened).
          if (this.sock && this.sock !== s) this.sock.destroy();
          this.sock = s;
          this.channel = null;
          this.failAll("Chrome reconnected.");
          s.write(JSON.stringify({ t: "ok" }) + "\n");
          this.setConnection("host-connected");
          continue;
        }
        void this.onWire(s, m as unknown as WireMessage).catch((e) => this.log(`wire error: ${(e as Error).message}`));
      }
    });
    s.on("error", () => undefined);
    s.on("close", () => {
      clearTimeout(authTimer);
      if (this.sock !== s) return;
      this.sock = null;
      this.channel = null;
      this.failAll("Chrome disconnected.");
      this.setConnection("no-host");
    });
  }

  private async onWire(s: Socket, m: WireMessage): Promise<void> {
    if (s !== this.sock) return;
    const key = await this.keyP;
    switch (m.k) {
      case "hello": {
        if (typeof m.extNonce !== "string" || !/^[0-9a-f]{32}$/.test(m.extNonce)) return;
        this.channel = null;
        this.setConnection("host-connected");
        const appNonce = randomHex(16);
        this.pendingWelcome = { session: `${m.extNonce}.${appNonce}` };
        this.extensionVersion = typeof m.extensionVersion === "string" ? m.extensionVersion : undefined;
        s.write(JSON.stringify({ k: "welcome", appNonce, mac: await hmac(key, welcomeText(m.extNonce, appNonce)) }) + "\n");
        return;
      }
      case "ready": {
        const pw = this.pendingWelcome;
        this.pendingWelcome = null;
        if (!pw || !(await hmacVerify(key, readyText(pw.session), m.mac))) {
          this.log("the extension couldn't prove it holds the pairing token");
          return;
        }
        this.channel = new SignedChannel(key, pw.session, ["cmd"]);
        this.setConnection("ready");
        return;
      }
      case "res":
      case "evt": {
        const ch = this.channel;
        if (!ch) return;
        const payload = await ch.open(m);
        if (payload === null) {
          this.log(`dropped an unauthenticated ${m.k}`);
          return;
        }
        if (m.k === "res") {
          const r = payload as BridgeResponse;
          const p = this.pending.get(r.id);
          if (!p) return;
          this.pending.delete(r.id);
          if (p.timer) clearTimeout(p.timer);
          if (r.ok) p.resolve(r.result);
          else p.reject(new BridgeCallError(r.error));
        } else {
          for (const fn of this.eventFns) fn(payload as BridgeEvent);
        }
        return;
      }
      default:
        return;
    }
  }
}

/** For tests and diagnostics: the MAC the host must answer the challenge with. */
export function expectedHostMac(token: string, nonce: string): string {
  return createHmac("sha256", Buffer.from(token, "hex")).update(`host|${nonce}`).digest("hex");
}
