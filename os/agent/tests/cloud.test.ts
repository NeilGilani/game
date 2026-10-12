/**
 * AGENCY Cloud for the agent (src/model/cloud.ts), run against the real relay handler (site/functions) with only
 * Google's side faked: registration, signatures, the agent's turn passing the relay's checks, refusals in plain
 * words, re-registering, the clock, retries, Stop, and the model choice. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestPost as interactions } from "../../../site/functions/api/relay/v1/interactions";
import { onRequestPost as register } from "../../../site/functions/api/relay/v1/register";
import { resetRelayState, type RelayEnv } from "../../../site/functions/_lib/relay";
import {
  AgencyCloud,
  cloudTransport,
  defaultIdentityStore,
  fileIdentityStore,
  keychainIdentityStore,
  memoryIdentityStore,
  relayUrlFromEnv,
  signature,
  type IdentityStore,
} from "../src/model/cloud";
import { GeminiModel } from "../src/model/gemini";
import { ModelUnavailable } from "../src/model/types";
import { AgentRuntime } from "../src/runtime/runtime";
import { chooseModel } from "../src/utility";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELAY = "https://relay.example";
let env: RelayEnv;
let googleAnswer: () => Response;
const googleBodies: Record<string, unknown>[] = [];
const relayCalls: string[] = [];

/** The agent's fetch, answered by the relay's own handlers; the relay's fetch to Google is the fake below. */
const viaRelay: typeof fetch = async (input, init) => {
  const request = new Request(input instanceof URL ? input.href : String(input), init);
  const path = new URL(request.url).pathname;
  relayCalls.push(path);
  if (path === "/api/relay/v1/register") return register({ request, env });
  if (path === "/api/relay/v1/interactions") return interactions({ request, env });
  return new Response("not found", { status: 404 });
};

const completed = (): Response =>
  new Response(
    JSON.stringify({
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "Done." }] }],
      usage: { total_input_tokens: 10, total_output_tokens: 2 },
    }),
  );

beforeEach(() => {
  resetRelayState();
  env = {
    GEMINI_API_KEY: "test-key-not-real",
    RELAY_SIGNING_SECRET: "test-signing-secret-not-real-0123456789",
  };
  googleAnswer = completed;
  googleBodies.length = 0;
  relayCalls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      googleBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return googleAnswer();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function cloudModel(store: IdentityStore = memoryIdentityStore(), now?: () => number) {
  const cloud = new AgencyCloud({
    baseUrl: RELAY,
    store,
    fetch: viaRelay,
    retryDelayMs: 0,
    ...(now ? { now } : {}),
  });
  return { cloud, model: new GeminiModel({ transport: cloudTransport(cloud), via: "agency-cloud" }) };
}

function session(model: GeminiModel, signal = new AbortController().signal) {
  return model.start({
    system: "You are the agent.",
    tools: [
      {
        name: "finish",
        description: "Finish",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
    ],
    computer: true,
    signal,
  });
}

describe("the agent through AGENCY Cloud", () => {
  it("registers once, signs each turn, and its turns with screenshots pass the relay's checks", async () => {
    const { model } = cloudModel();
    const s = session(model);
    const first = await s.next("Open the calendar");
    expect(first.stop).toBe("end");
    // A computer-use result with a screenshot, as the runtime sends it.
    await s.next([
      {
        callId: "c1",
        name: "click",
        computer: true,
        text: "ok",
        image: { data: "AAAA", mediaType: "image/jpeg" },
      },
    ]);
    expect(relayCalls.filter((p) => p.endsWith("/register"))).toHaveLength(1);
    expect(relayCalls.filter((p) => p.endsWith("/interactions"))).toHaveLength(2);
    expect(googleBodies).toHaveLength(2);
    const sent = googleBodies[1]!;
    expect(sent["store"]).toBe(false);
    expect(
      (sent["tools"] as { type: string; enable_prompt_injection_detection?: boolean }[])[1],
    ).toMatchObject({
      type: "computer_use",
      enable_prompt_injection_detection: true,
    });
    expect(JSON.stringify(sent["input"])).toContain('"type":"image"');
    expect(model.via).toBe("agency-cloud");
  });

  it("keeps the install in a private file and reuses it after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-cloud-"));
    const path = join(dir, "agency-cloud.json");
    await session(cloudModel(fileIdentityStore(path)).model).next("hi");
    const saved = JSON.parse(readFileSync(path, "utf8")) as { installId: string; relay: string };
    expect(saved.installId).toMatch(/^i_/);
    expect(saved.relay).toBe(RELAY);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await session(cloudModel(fileIdentityStore(path)).model).next("again");
    expect(relayCalls.filter((p) => p.endsWith("/register"))).toHaveLength(1);
  });

  it("turns the relay's refusals into plain words and stops", async () => {
    const { model } = cloudModel();
    await session(model).next("warm up");
    env = { ...env, RELAY_ENABLED: "0" };
    await expect(session(model).next("hi")).rejects.toMatchObject({
      message: "AGENCY's AI is switched off for now.",
      retryable: false,
    });
    env = { ...env, RELAY_ENABLED: "1", RELAY_INSTALL_PER_MINUTE: "1" };
    const err = await session(model)
      .next("hi")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailable);
    expect(err).toMatchObject({ message: "AGENCY's AI is busy. Try again in a minute.", retryable: true });
    resetRelayState();
    env = { ...env, RELAY_INSTALL_PER_MINUTE: "30", RELAY_DAILY_REQUEST_CAP: "0" };
    await expect(session(model).next("hi")).rejects.toMatchObject({
      message: "AGENCY's AI has reached its daily limit. Try again tomorrow.",
    });
  });

  it("passes Gemini's own errors on with their usual meaning, retrying a passing one once", async () => {
    const { model } = cloudModel();
    let calls = 0;
    googleAnswer = () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error: { code: 503, message: "overloaded" } }), { status: 503 })
        : completed();
    };
    expect((await session(model).next("hi")).stop).toBe("end"); // one retry, then the answer
    expect(calls).toBe(2);

    googleAnswer = () =>
      new Response(JSON.stringify({ error: { code: 429, message: "busy" } }), { status: 429 });
    await expect(session(model).next("hi")).rejects.toMatchObject({
      message: "Gemini is busy right now (rate limit).",
      retryable: true,
    });
    googleAnswer = () =>
      new Response(JSON.stringify({ error: { code: 403, message: "key" } }), { status: 403 });
    await expect(session(model).next("hi")).rejects.toMatchObject({
      message: "AGENCY's AI isn't available right now.",
    });
  });

  it("registers again when the relay's secret was rotated, and fixes a clock that is off", async () => {
    let offset = 0;
    const { model } = cloudModel(memoryIdentityStore(), () => Date.now() + offset);
    await session(model).next("hi");
    env = { ...env, RELAY_SIGNING_SECRET: `${env.RELAY_SIGNING_SECRET}-rotated` };
    expect((await session(model).next("hi")).stop).toBe("end");
    expect(relayCalls.filter((p) => p.endsWith("/register"))).toHaveLength(2);
    offset = -2 * 3600_000; // this computer's clock is two hours behind
    expect((await session(model).next("hi")).stop).toBe("end");
  });

  it("says plainly when it can't reach the relay, and Stop still stops", async () => {
    const offline = new AgencyCloud({
      baseUrl: RELAY,
      store: memoryIdentityStore(),
      fetch: async () => Promise.reject(new TypeError("fetch failed")),
      retryDelayMs: 0,
    });
    const model = new GeminiModel({ transport: cloudTransport(offline), via: "agency-cloud" });
    await expect(session(model).next("hi")).rejects.toMatchObject({
      message: "Can't reach AGENCY's AI (no connection).",
      retryable: true,
    });
    const stop = new AbortController();
    const hanging = new AgencyCloud({
      baseUrl: RELAY,
      store: memoryIdentityStore({ installId: `i_${"a".repeat(22)}`, secret: "s", relay: RELAY }),
      fetch: (_u, init) =>
        new Promise((_, reject) => {
          const stopped = () => reject(new DOMException("stopped", "AbortError"));
          if (init?.signal?.aborted) stopped(); // as fetch does
          init?.signal?.addEventListener("abort", stopped);
        }),
    });
    const pending = session(new GeminiModel({ transport: cloudTransport(hanging) }), stop.signal).next("hi");
    stop.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("choosing the agent's model", () => {
  it("uses a key of your own first, else AGENCY Cloud, and nothing with AGENCY_RELAY=off", () => {
    const store = memoryIdentityStore();
    const own = chooseModel("gemini", "k", {}, store);
    expect(own?.via).toBe("own-key");
    const cloud = chooseModel("gemini", null, {}, store);
    expect(cloud?.via).toBe("agency-cloud");
    expect(cloud?.model).toBe("gemini-3.8-flash");
    expect(chooseModel("gemini", null, { AGENCY_RELAY: "off" }, store)).toBeNull();
    expect(chooseModel("anthropic", null, {}, store)).toBeNull();
    expect(relayUrlFromEnv({})).toBe("https://getagencyos.pages.dev");
    expect(relayUrlFromEnv({ AGENCY_RELAY_URL: "http://127.0.0.1:8788/" })).toBe("http://127.0.0.1:8788");
  });

  it("shows AI: AGENCY Cloud in the status", () => {
    const deps = { bridge: null, native: null, memory: null, packs: [], computerUse: false, router: null };
    const cloud = new AgentRuntime({
      ...deps,
      model: chooseModel("gemini", null, {}, memoryIdentityStore()),
    });
    expect(cloud.capabilities()).toMatchObject({ ai: "AI: AGENCY Cloud", model: true });
    expect(cloud.capabilities().note).toBe("AI: AGENCY Cloud (Gemini, gemini-3.8-flash) is set up.");
    const off = new AgentRuntime({ ...deps, model: null });
    expect(off.capabilities().ai).toBe("AI: off");
  });

  it("keeps the install in the keychain on a Mac (the item the coordinator shares)", async () => {
    const calls: string[][] = [];
    const store = keychainIdentityStore(async (args) => {
      calls.push(args);
      return { ok: true, stdout: JSON.stringify({ installId: "i_x", secret: "s", relay: RELAY }) };
    });
    expect(await store.load()).toEqual({ installId: "i_x", secret: "s", relay: RELAY });
    await store.save({ installId: "i_y", secret: "s2", relay: RELAY });
    expect(calls[0]!.slice(0, 5)).toEqual([
      "find-generic-password",
      "-s",
      "AGENCY",
      "-a",
      "agency-cloud-install",
    ]);
    expect(calls[1]![0]).toBe("add-generic-password");
    expect(calls[1]!.at(-1)).toBe("-U");
    expect(defaultIdentityStore({ AGENCY_CLOUD_IDENTITY_FILE: "/tmp/x.json" }, "darwin")).not.toBe(null);
  });

  it("signs exactly like the relay and the coordinator (a fixed vector all three check)", () => {
    expect(signature("s3cret", "POST", "/api/relay/v1/generate", 1_700_000_000, '{"a":1}')).toBe(
      SIGNATURE_VECTOR,
    );
  });
});

/** HMAC-SHA256("s3cret", "AGENCY-CLOUD-1\nPOST\n/api/relay/v1/generate\n1700000000\n" + sha256('{"a":1}')). */
const SIGNATURE_VECTOR = "eb7f913af191f5d86cd4b354938bc3a52ebf5f117efaa7338052bd6c16db803c";
