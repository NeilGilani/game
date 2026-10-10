import type { AgentEvent } from "@agency/contracts";
import { describe, expect, it } from "vitest";
import { turn } from "../evals/harness";
import { SandboxWeb } from "../evals/world/sandboxWeb";
import { ScriptedModel } from "../src/model/scripted";
import type { AgentModel, ModelSession, SessionOptions } from "../src/model/types";
import { AgentRuntime } from "../src/runtime/runtime";
import { HttpSynapseRouter, parseRoute, type SynapseRoute, type SynapseRouter } from "../src/synapse";

/** Records the session options the runtime gives the model, then plays a scripted give-up. */
class RecordingModel implements AgentModel {
  readonly provider = "scripted" as const;
  readonly model = "recording";
  readonly screenshotEveryComputerAction = false;
  starts: SessionOptions[] = [];
  private readonly inner = new ScriptedModel([turn(["give_up", { reason: "test" }])]);
  start(options: SessionOptions): ModelSession {
    this.starts.push(options);
    return this.inner.start(options);
  }
}

const route = (decision: SynapseRoute["decision"], extra: Partial<SynapseRoute> = {}): SynapseRoute => ({
  mode: decision === "gemini" ? "Ultra-Fusion" : decision === "gemini-lean" ? "Lean-Fusion" : "Safe-Mode",
  decision,
  brief:
    "Synapse-Mesh routed this request (Lean-Fusion). Weigh these expert lenses by their share:\n- legal (70%): …",
  note: "Lean-Fusion: Gemini with light thinking, weighted legal 70%, medical 30%.",
  router: "synapse",
  mixture: { legal: 0.7, medical: 0.3 },
  network: "slow",
  ...extra,
});

function runtime(model: AgentModel, router: SynapseRouter | null) {
  const rt = new AgentRuntime({
    model,
    bridge: new SandboxWeb(),
    native: null,
    memory: null,
    packs: [],
    router,
  });
  const events: AgentEvent[] = [];
  rt.onEvent((e) => events.push(e));
  return { rt, events };
}

describe("Synapse layer in the agent", () => {
  it("gives Gemini Synapse's expert lenses and light thinking under Lean-Fusion, and tells the person", async () => {
    const model = new RecordingModel();
    const texts: string[] = [];
    const { rt, events } = runtime(model, {
      route: async (text) => {
        texts.push(text);
        return route("gemini-lean");
      },
    });
    await rt.handle({
      type: "task.start",
      request: { id: "s1", goal: "Renew my parking placard", origin: "home", selections: { office: "DMV" } },
    });
    expect(texts[0]).toContain("Renew my parking placard");
    expect(texts[0]).toContain("DMV");
    expect(model.starts).toHaveLength(1);
    expect(model.starts[0]!.system).toContain("Synapse-Mesh routed this request (Lean-Fusion)");
    expect(model.starts[0]!.thinking).toBe("low");
    const note = events.find((e) => e.type === "task.step" && e.stepId === "synapse:route");
    expect(note).toMatchObject({
      status: "done",
      summary: expect.stringContaining("Synapse-Mesh: Lean-Fusion"),
    });
  });

  it("doesn't start a model task when the network is offline (Safe-Mode), and says why", async () => {
    const model = new RecordingModel();
    const { rt, events } = runtime(model, {
      route: async () => route("built-in", { note: "Safe-Mode: the network is offline." }),
    });
    await rt.handle({ type: "task.start", request: { id: "s2", goal: "Order lunch", origin: "home" } });
    expect(model.starts).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "task.failed",
      recoverable: true,
      reason: expect.stringContaining("Safe-Mode: the network is offline."),
    });
  });

  it("runs as before when there is no router or it can't be reached", async () => {
    for (const router of [null, { route: async () => null }]) {
      const model = new RecordingModel();
      const { rt, events } = runtime(model, router);
      await rt.handle({ type: "task.start", request: { id: "s3", goal: "x", origin: "home" } });
      expect(model.starts).toHaveLength(1);
      expect(model.starts[0]!.thinking).toBeUndefined();
      expect(events.some((e) => e.type === "task.step" && e.stepId === "synapse:route")).toBe(false);
    }
  });

  it("asks the coordinator over HTTP with the token, and survives errors", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ...route("gemini"), extra: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new HttpSynapseRouter("http://127.0.0.1:8000", "tok", ok).route("hello");
    expect(r?.decision).toBe("gemini");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8000/api/synapse/route");
    expect((calls[0]!.init.headers as Record<string, string>)["x-agency-token"]).toBe("tok");
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await new HttpSynapseRouter("http://x", undefined, down).route("hello")).toBeNull();
    const bad = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    expect(await new HttpSynapseRouter("http://x", undefined, bad).route("hello")).toBeNull();
  });

  it("parses only valid routes", () => {
    expect(parseRoute({ decision: "teleport" })).toBeNull();
    expect(parseRoute(null)).toBeNull();
    expect(parseRoute({ decision: "built-in", mixture: { a: 0.5, b: "x" }, router: "other" })).toMatchObject({
      decision: "built-in",
      router: "agency",
      mixture: { a: 0.5 },
    });
  });
});
