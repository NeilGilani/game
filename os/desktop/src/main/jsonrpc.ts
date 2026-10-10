/** Newline-delimited JSON-RPC 2.0 client for agency-native (os/contracts/src/native.ts). */

import type { NativeEvent, NativeMethod, NativeMethods } from "@agency/contracts";

export interface RpcTransport {
  write(line: string): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

export class NativeRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private transport: RpcTransport | null = null;

  constructor(
    private readonly onEvent: (event: NativeEvent) => void,
    private readonly timeoutMs = 10_000,
  ) {}

  attach(transport: RpcTransport): void {
    this.transport = transport;
  }

  /** The process went away: fail everything in flight. */
  detach(reason = "agency-native stopped"): void {
    this.transport = null;
    this.buffer = "";
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(reason, null));
      this.pending.delete(id);
    }
  }

  get connected(): boolean {
    return this.transport !== null;
  }

  call<M extends NativeMethod>(
    method: M,
    params: NativeMethods[M]["params"],
    timeoutMs = this.timeoutMs,
  ): Promise<NativeMethods[M]["result"]> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new RpcError("agency-native is not running", null));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out after ${timeoutMs} ms`, null));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Feed stdout data from the helper. */
  receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handle(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handle(line: string): void {
    let msg: {
      id?: number | null;
      result?: unknown;
      error?: { code?: number; message?: string };
      method?: string;
      params?: unknown;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Not JSON: ignore (the helper logs to stderr, but be tolerant).
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.message ?? "native error", msg.error.code ?? null));
      else p.resolve(msg.result);
      return;
    }
    // Notifications: {"jsonrpc":"2.0","method":"event","params":NativeEvent}
    if (msg.method === "event" && msg.params && typeof msg.params === "object") {
      this.onEvent(msg.params as NativeEvent);
    }
  }
}
