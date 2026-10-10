import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorClient, type FetchLike } from "../src/main/coordinator";
import { LifelineHost, type HeartbeatBody } from "../src/main/lifeline";
import { stopAll } from "../src/main/stop";
import { quietLog } from "./helpers";

const beat: HeartbeatBody = {
  signal_ready: false,
  camera: "off",
  face_visible: false,
  page_visible: true,
  input_mode: "pointer",
};

function client(fetchImpl: FetchLike) {
  const c = new CoordinatorClient(fetchImpl);
  c.set({ mode: "bundled", url: "http://127.0.0.1:9", token: "secret" });
  return c;
}

describe("LifelineHost", () => {
  afterEach(() => vi.useRealTimers());

  it("surfaces before posting, sends the token, and reports delivery", async () => {
    const order: string[] = [];
    const calls: { url: string; init?: RequestInit }[] = [];
    const host = new LifelineHost({
      client: client(async (url, init) => {
        order.push("post");
        calls.push({ url, ...(init ? { init } : {}) });
        return Response.json({ alert: { id: "a1" }, created: true });
      }),
      log: quietLog(),
      surface: () => order.push("surface"),
      heartbeat: () => beat,
    });
    const res = await host.help("help_button");
    expect(order).toEqual(["surface", "post"]);
    expect(res).toEqual({ delivered: true, alertId: "a1", created: true });
    expect(calls[0]!.url).toBe("http://127.0.0.1:9/api/lifeline/help");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ source: "help_button", test: false });
    expect((calls[0]!.init?.headers as Record<string, string>)["X-Agency-Token"]).toBe("secret");
  });

  it("still surfaces and keeps retrying when the coordinator is down", async () => {
    vi.useFakeTimers();
    let up = false;
    let posts = 0;
    let surfaced = 0;
    const host = new LifelineHost({
      client: client(async () => {
        posts += 1;
        if (!up) throw new Error("ECONNREFUSED");
        return Response.json({ alert: { id: "a2" }, created: true });
      }),
      log: quietLog(),
      surface: () => (surfaced += 1),
      heartbeat: () => beat,
      firstAttemptMs: 100,
      retryMs: { initial: 1000, max: 4000 },
    });
    const res = await host.help("eye_signal");
    expect(surfaced).toBe(1);
    expect(res.delivered).toBe(false);
    expect(host.helpPending).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(posts).toBe(3);
    up = true;
    await vi.advanceTimersByTimeAsync(4000);
    expect(posts).toBe(4);
    expect(host.helpPending).toBe(false);
    host.stop();
  });

  it("a throwing surface never blocks the request", async () => {
    let posted = false;
    const host = new LifelineHost({
      client: client(async () => {
        posted = true;
        return Response.json({ alert: { id: "a3" }, created: false });
      }),
      log: quietLog(),
      surface: () => {
        throw new Error("no window");
      },
      heartbeat: () => beat,
    });
    const res = await host.help("switch");
    expect(posted).toBe(true);
    expect(res.delivered).toBe(true);
  });

  it("sends heartbeats and records the result", async () => {
    const bodies: unknown[] = [];
    const host = new LifelineHost({
      client: client(async (_u, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      }),
      log: quietLog(),
      surface: () => undefined,
      heartbeat: () => beat,
    });
    expect(await host.beat()).toBe(true);
    expect(bodies[0]).toEqual(beat);
    expect(host.heartbeatStatus.lastHeartbeatOk).toBe(true);
  });
});

describe("stopAll", () => {
  it("fires the agent and native stops before awaiting either", async () => {
    const order: string[] = [];
    let resolveNative!: (v: boolean) => void;
    const p = stopAll(
      {
        agent: () => {
          order.push("agent");
          return true;
        },
        native: () => {
          order.push("native");
          return new Promise<boolean>((r) => (resolveNative = r));
        },
      },
      quietLog(),
    );
    expect(order).toEqual(["agent", "native"]);
    resolveNative(true);
    const res = await p;
    expect(res.agent).toBe("sent");
    expect(res.native).toBe("ok");
  });

  it("reports a hung or failing native helper without hanging", async () => {
    const res = await stopAll(
      { agent: () => false, native: () => new Promise<boolean>(() => undefined) },
      quietLog(),
      50,
    );
    expect(res).toMatchObject({ agent: "unavailable", native: "failed" });
    const res2 = await stopAll(
      {
        agent: () => {
          throw new Error("boom");
        },
        native: () => null,
      },
      quietLog(),
    );
    expect(res2).toMatchObject({ agent: "unavailable", native: "unavailable" });
  });
});
