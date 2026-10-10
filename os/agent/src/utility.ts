/**
 * Entry point for the Electron utility process (spawned by os/desktop, Instance 1).
 *
 * Protocol over process.parentPort (structured-clone messages):
 *   main → agent  { kind: "command", command: AgentCommand }
 *                 { kind: "rpc.result", id, result?, error? }        reply to an rpc below
 *   agent → main  { kind: "event", event: AgentEvent }
 *                 { kind: "rpc", id, target: "native" | "bridge", method, params }
 *                 { kind: "status", status }                         once at start
 *
 * The agent never talks to agency-native or Chrome directly; the main process forwards an allowlisted subset.
 * The API key is read here (environment or macOS keychain) and never leaves this process.
 */

import { readFileSync } from "node:fs";
import type { AgentCommand, AgentEvent, NativeMethod, NativeMethods } from "@agency/contracts";
import { AuditLog } from "./audit";
import { FakeAgent } from "./fake/fakeAgent";
import { HttpMemoryClient } from "./memory";
import { AnthropicModel } from "./model/anthropic";
import { GeminiModel, type GeminiThinkingLevel } from "./model/gemini";
import { findApiKey, type Provider } from "./model/keys";
import { HttpSynapseRouter } from "./synapse";
import type { AgentModel } from "./model/types";
import { DEFAULT_SETTINGS, type SafetySettings } from "./policy/settings";
import { AgentRuntime } from "./runtime/runtime";
import type { BrowserBridge, NativeClient, PageSnapshot, BridgeResult } from "./types";

interface ParentPort {
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

/** The native methods the agent may ask the main process to call. Nothing else is forwarded. */
export const AGENT_NATIVE_METHODS: readonly NativeMethod[] = [
  "ax.targets",
  "ax.press",
  "input.click",
  "input.scroll",
  "input.type",
  "input.key",
  "apps.frontmost",
  "apps.launch",
  "apps.activate",
  "screen.capture",
  "input.stopAll",
];

export class RpcPort {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  constructor(
    private readonly post: (m: unknown) => void,
    private readonly timeoutMs = 30_000,
  ) {}

  call(target: "native" | "bridge", method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${target} ${method} did not answer in time.`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.post({ kind: "rpc", id, target, method, params });
    });
  }

  settle(msg: { id: number; result?: unknown; error?: string }): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }
}

export function nativeOverRpc(rpc: RpcPort): NativeClient {
  return {
    call<M extends NativeMethod>(method: M, params: NativeMethods[M]["params"]) {
      if (!AGENT_NATIVE_METHODS.includes(method))
        return Promise.reject(new Error(`${method} is not available to the agent.`));
      return rpc.call("native", method, params) as Promise<NativeMethods[M]["result"]>;
    },
  };
}

export function bridgeOverRpc(rpc: RpcPort): BrowserBridge {
  return {
    snapshot: () => rpc.call("bridge", "snapshot", {}) as Promise<PageSnapshot>,
    click: (ref) => rpc.call("bridge", "click", { ref }) as Promise<BridgeResult>,
    type: (ref, text) => rpc.call("bridge", "type", { ref, text }) as Promise<BridgeResult>,
    navigate: (url) => rpc.call("bridge", "navigate", { url }) as Promise<BridgeResult>,
  };
}

/** Caregiver-set limits from a JSON file the Settings screen writes. Re-read on every check; the agent never writes it. */
export function settingsFromFile(path: string | undefined): () => SafetySettings {
  return () => {
    if (!path) return DEFAULT_SETTINGS;
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<SafetySettings>) };
    } catch {
      return DEFAULT_SETTINGS;
    }
  };
}

/**
 * The model for a provider. Gemini is the default (AGENCY_AGENT_MODEL, default gemini-3.8-flash;
 * AGENCY_AGENT_THINKING low | medium | high). Claude with AGENCY_AGENT_PROVIDER=anthropic
 * (AGENCY_AGENT_MODEL, default claude-opus-5-5; AGENCY_AGENT_EFFORT).
 */
export function modelFor(provider: Provider, apiKey: string, env: NodeJS.ProcessEnv): AgentModel {
  const model = env.AGENCY_AGENT_MODEL || undefined;
  if (provider === "anthropic") {
    const effort = env.AGENCY_AGENT_EFFORT as "low" | "medium" | "high" | "xhigh" | "max" | undefined;
    return new AnthropicModel({ apiKey, model, effort });
  }
  const thinking = (["minimal", "low", "medium", "high"] as const).find(
    (l) => l === env.AGENCY_AGENT_THINKING,
  ) as GeminiThinkingLevel | undefined;
  return new GeminiModel({ apiKey, model, thinkingLevel: thinking });
}

async function main(port: ParentPort): Promise<void> {
  const env = process.env;
  const rpc = new RpcPort((m) => port.postMessage(m));
  const send = (event: AgentEvent) => port.postMessage({ kind: "event", event });

  let agent: { handle(c: AgentCommand): Promise<void>; onEvent(l: (e: AgentEvent) => void): () => void };
  let status: Record<string, unknown>;
  if (env.AGENCY_AGENT_FAKE === "1") {
    agent = new FakeAgent();
    status = { fake: true, note: "Fake agent: scripted demo task only." };
  } else {
    const provider: Provider = env.AGENCY_AGENT_PROVIDER === "anthropic" ? "anthropic" : "gemini";
    const { key, source } = await findApiKey(provider);
    const runtime = new AgentRuntime({
      model: key ? modelFor(provider, key, env) : null,
      bridge: env.AGENCY_BRIDGE === "0" ? null : bridgeOverRpc(rpc),
      native: env.AGENCY_NATIVE === "0" ? null : nativeOverRpc(rpc),
      memory: env.AGENCY_COORDINATOR_URL
        ? new HttpMemoryClient(env.AGENCY_COORDINATOR_URL, env.AGENCY_COORDINATOR_TOKEN)
        : null,
      packs: [],
      audit: new AuditLog(env.AGENCY_AUDIT_FILE),
      settings: settingsFromFile(env.AGENCY_AGENT_SETTINGS),
      computerUse: env.AGENCY_COMPUTER_USE !== "0",
      router: env.AGENCY_COORDINATOR_URL
        ? new HttpSynapseRouter(env.AGENCY_COORDINATOR_URL, env.AGENCY_COORDINATOR_TOKEN)
        : null,
    });
    agent = runtime;
    status = { ...runtime.capabilities(), keySource: source };
  }
  agent.onEvent(send);
  port.postMessage({ kind: "status", status });

  port.on("message", ({ data }) => {
    const msg = data as { kind?: string };
    if (msg.kind === "command") {
      void agent.handle((msg as { command: AgentCommand }).command).catch(() => undefined);
    } else if (msg.kind === "rpc.result") {
      rpc.settle(msg as { id: number; result?: unknown; error?: string });
    } else if (msg.kind === "ping") {
      port.postMessage({ kind: "pong", id: (msg as { id: number }).id });
    }
  });
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parentPort) void main(parentPort);
