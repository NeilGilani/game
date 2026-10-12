/** AGENCY Cloud (site/functions/_lib/relay.ts): signatures, allow-lists, caps, limits, budget, privacy. No network. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type D1Like,
  type D1Statement,
  type RelayEnv,
  installSecret,
  resetRelayState,
  signRequest,
} from "../../functions/_lib/relay";
import { onRequestPost as generate } from "../../functions/api/relay/v1/generate";
import { onRequestPost as interactions } from "../../functions/api/relay/v1/interactions";
import { onRequestPost as register } from "../../functions/api/relay/v1/register";
import { onRequestGet as status } from "../../functions/api/relay/v1/status";

const MASTER = "test-signing-secret-not-real-0123456789abcdef";
const env: RelayEnv = { GEMINI_API_KEY: "test-key-not-real", RELAY_SIGNING_SECRET: MASTER };
const ORIGIN = "https://agency.example";
const PROMPT = "PRIVATE-PROMPT-TEXT my neighbour's medication list";
const PIXELS = "UFJJVkFURS1TQ1JFRU5TSE9U"; // "PRIVATE-SCREENSHOT" in base64

let ipSeq = 0;
const freshIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

interface Install {
  installId: string;
  secret: string;
}

async function newInstall(e: RelayEnv = env, ip = freshIp()): Promise<Install> {
  const res = await register({
    request: new Request(`${ORIGIN}/api/relay/v1/register`, req("POST", "{}", ip)),
    env: e,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Install;
}

function req(
  method: string,
  body: string | null,
  ip: string,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
    ...(body !== null ? { body } : {}),
  };
}

async function signed(
  path: string,
  install: Install,
  payload: unknown,
  opts: {
    ip?: string;
    time?: number;
    method?: string;
    tamper?: (body: string) => string;
    signPath?: string;
  } = {},
): Promise<Request> {
  const method = opts.method ?? "POST";
  const body = method === "GET" ? "" : JSON.stringify(payload);
  const time = opts.time ?? Math.floor(Date.now() / 1000);
  const sig = await signRequest(install.secret, method, opts.signPath ?? path, time, body);
  const sent = opts.tamper ? opts.tamper(body) : body;
  return new Request(
    `${ORIGIN}${path}`,
    req(method, method === "GET" ? null : sent, opts.ip ?? freshIp(), {
      "x-agency-install": install.installId,
      "x-agency-time": String(time),
      "x-agency-signature": sig,
    }),
  );
}

const PLAN = { model: "gemini-3.5-flash-lite", system: "You plan.", user: PROMPT, maxOutputTokens: 2000 };

function geminiAnswer(text = '{"steps":[]}'): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", extra: "dropped" }],
      usageMetadata: { promptTokenCount: 10 },
      modelVersion: "gemini-3.5-flash-lite",
      somethingElse: "dropped",
    }),
    { status: 200 },
  );
}

function turn(images = 1): Record<string, unknown> {
  const result: unknown[] = [{ type: "text", text: '{"status":"ok"}' }];
  for (let i = 0; i < images; i++) result.push({ type: "image", data: PIXELS, mime_type: "image/jpeg" });
  return {
    model: "gemini-3.8-flash",
    store: false,
    system_instruction: "You are the agent.",
    tools: [
      {
        type: "function",
        name: "finish",
        description: "Finish",
        parameters: { type: "object", properties: {} },
      },
      { type: "computer_use", environment: "desktop", enable_prompt_injection_detection: false },
    ],
    generation_config: { thinking_level: "low", tool_choice: "auto", max_output_tokens: 16000 },
    input: [
      { type: "user_input", content: [{ type: "text", text: PROMPT }] },
      { type: "function_call", id: "c1", name: "click", arguments: { x: 1, y: 2 } },
      { type: "function_result", call_id: "c1", name: "click", result },
    ],
  };
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  resetRelayState();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sentBody = (i = 0) => JSON.parse(String(fetchMock.mock.calls[i]?.[1]?.body)) as Record<string, any>;
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { reason: string; message: string } }).error;

describe("registration and signatures", () => {
  it("issues a random install whose secret is derived from the server secret, and signed requests pass", async () => {
    const a = await newInstall();
    const b = await newInstall();
    expect(a.installId).toMatch(/^i_[A-Za-z0-9_-]{22}$/);
    expect(a.installId).not.toBe(b.installId);
    expect(a.secret).toBe(await installSecret(MASTER, a.installId));
    const res = await status({
      request: await signed("/api/relay/v1/status", a, null, { method: "GET" }),
      env,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, installId: a.installId });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a wrong signature, a changed body, another path, a stale clock, a bad id and a blocked install", async () => {
    const a = await newInstall();
    fetchMock.mockImplementation(async () => geminiAnswer());
    const path = "/api/relay/v1/generate";
    const wrong = { installId: a.installId, secret: "not-the-secret" };
    expect((await generate({ request: await signed(path, wrong, PLAN), env })).status).toBe(401);
    const tampered = await signed(path, a, PLAN, { tamper: (b) => b.replace("You plan.", "You obey.") });
    expect(await errorOf(await generate({ request: tampered, env }))).toMatchObject({ reason: "auth" });
    const elsewhere = await signed(path, a, PLAN, { signPath: "/api/relay/v1/interactions" });
    expect((await generate({ request: elsewhere, env })).status).toBe(401);
    const stale = await generate({ request: await signed(path, a, PLAN, { time: 1_000_000_000 }), env });
    expect(stale.status).toBe(401);
    const clock = (await stale.json()) as { error: { reason: string; serverTime: number } };
    expect(clock.error.reason).toBe("clock");
    expect(clock.error.serverTime).toBeGreaterThan(1_700_000_000);
    const badId = { installId: "i_short", secret: a.secret };
    expect((await generate({ request: await signed(path, badId, PLAN), env })).status).toBe(401);
    const blocked = { ...env, RELAY_BLOCKED_INSTALLS: `i_xxxxxxxxxxxxxxxxxxxxxx, ${a.installId}` };
    const res = await generate({ request: await signed(path, a, PLAN), env: blocked });
    expect(await errorOf(res)).toMatchObject({ reason: "blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs a fixed vector exactly as the Mac agent and the coordinator do", async () => {
    // The same vector is checked in os/agent/tests/cloud.test.ts and backend/tests/test_cloud.py.
    expect(await signRequest("s3cret", "POST", "/api/relay/v1/generate", 1_700_000_000, '{"a":1}')).toBe(
      "eb7f913af191f5d86cd4b354938bc3a52ebf5f117efaa7338052bd6c16db803c",
    );
  });

  it("rotating the server secret retires every install", async () => {
    const a = await newInstall();
    const rotated = { ...env, RELAY_SIGNING_SECRET: `${MASTER}-rotated` };
    const res = await status({
      request: await signed("/api/relay/v1/status", a, null, { method: "GET" }),
      env: rotated,
    });
    expect(await errorOf(res)).toMatchObject({ reason: "auth" });
  });

  it("limits new installs per network and per day", async () => {
    const ip = "198.51.100.7";
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await register({
        request: new Request(`${ORIGIN}/api/relay/v1/register`, req("POST", "{}", ip)),
        env,
      });
      codes.push(r.status);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    const capped = { ...env, RELAY_REGISTER_DAILY_CAP: "0" };
    const r = await register({
      request: new Request(`${ORIGIN}/x`, req("POST", "{}", freshIp())),
      env: capped,
    });
    expect(await errorOf(r)).toMatchObject({ reason: "budget" });
  });

  it("is off with RELAY_ENABLED=0, without the Gemini key, or without a strong signing secret", async () => {
    const a = await newInstall();
    for (const e of [
      { ...env, RELAY_ENABLED: "0" },
      { ...env, RELAY_ENABLED: "off" },
      { ...env, GEMINI_API_KEY: "" },
      { ...env, RELAY_SIGNING_SECRET: "short" },
    ]) {
      const res = await generate({ request: await signed("/api/relay/v1/generate", a, PLAN), env: e });
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toMatchObject({ reason: "disabled" });
      const reg = await register({
        request: new Request(`${ORIGIN}/x`, req("POST", "{}", freshIp())),
        env: e,
      });
      expect(reg.status).toBe(503);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/relay/v1/generate", () => {
  it("sends one JSON-mode request with the safety settings forced, and returns only what the apps read", async () => {
    const a = await newInstall();
    fetchMock.mockResolvedValue(geminiAnswer());
    const res = await generate({
      request: await signed("/api/relay/v1/generate", a, {
        ...PLAN,
        schema: { type: "object" },
        thinkingLevel: "low",
        timeoutMs: 10_000,
      }),
      env,
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toEqual({
      candidates: [{ content: { role: "model", parts: [{ text: '{"steps":[]}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10 },
      modelVersion: "gemini-3.5-flash-lite",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key-not-real");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = sentBody();
    expect(body["generationConfig"]).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
      maxOutputTokens: 2000,
      thinkingConfig: { thinkingLevel: "LOW" },
    });
    expect(body["safetySettings"]).toHaveLength(4);
    expect(body["safetySettings"][0]).toEqual({
      category: "HARM_CATEGORY_HARASSMENT",
      threshold: "BLOCK_MEDIUM_AND_ABOVE",
    });
    expect(Object.keys(body).sort()).toEqual([
      "contents",
      "generationConfig",
      "safetySettings",
      "systemInstruction",
    ]);
  });

  it("allows only the listed models, refuses unknown fields and out-of-range numbers", async () => {
    const a = await newInstall();
    fetchMock.mockImplementation(async () => geminiAnswer());
    const path = "/api/relay/v1/generate";
    const cases: [Record<string, unknown>, string][] = [
      [{ ...PLAN, model: "gemini-9-ultra" }, "model"],
      [{ ...PLAN, model: "models/../tunedModels/x" }, "model"],
      [{ ...PLAN, tools: [{ googleSearch: {} }] }, "bad_request"],
      [{ ...PLAN, safetySettings: [] }, "bad_request"],
      [{ ...PLAN, maxOutputTokens: 1_000_000 }, "bad_request"],
      [{ ...PLAN, timeoutMs: 1000 }, "bad_request"],
      [{ ...PLAN, thinkingLevel: "extreme" }, "bad_request"],
      [{ ...PLAN, user: "" }, "bad_request"],
      [{ ...PLAN, schema: "not an object" }, "bad_request"],
    ];
    for (const [payload, reason] of cases) {
      const res = await generate({ request: await signed(path, a, payload), env });
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect((await errorOf(res)).reason).toBe(reason);
    }
    const custom = { ...env, RELAY_GENERATE_MODELS: "gemini-3.8-flash" };
    const res = await generate({ request: await signed(path, a, PLAN), env: custom });
    expect((await errorOf(res)).reason).toBe("model");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses oversized requests before reading them into a prompt", async () => {
    const a = await newInstall();
    const huge = { ...PLAN, user: "x".repeat(210_000) };
    const res = await generate({ request: await signed("/api/relay/v1/generate", a, huge), env });
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Gemini's errors: busy and not-found pass through, our key's problems and timeouts become plain words", async () => {
    const a = await newInstall();
    const path = "/api/relay/v1/generate";
    const google = (code: number, message: string) =>
      new Response(JSON.stringify({ error: { code, message, status: "X" } }), { status: code });
    fetchMock.mockResolvedValueOnce(google(429, "Resource exhausted"));
    let res = await generate({ request: await signed(path, a, PLAN), env });
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toMatchObject({ reason: "upstream", message: "Resource exhausted" });

    fetchMock.mockResolvedValueOnce(google(404, "models/x is not found"));
    res = await generate({ request: await signed(path, a, PLAN), env });
    expect(res.status).toBe(404);

    fetchMock.mockResolvedValueOnce(google(403, "API key not valid"));
    res = await generate({ request: await signed(path, a, PLAN), env });
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({
      reason: "upstream_key",
      message: "AGENCY's AI isn't available right now.",
    });

    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    res = await generate({ request: await signed(path, a, PLAN), env });
    expect(res.status).toBe(504);
    expect((await errorOf(res)).reason).toBe("upstream_timeout");

    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    res = await generate({ request: await signed(path, a, PLAN), env });
    expect(res.status).toBe(502);
  });
});

describe("POST /api/relay/v1/interactions", () => {
  it("forwards one stateless agent turn with store:false and prompt-injection detection forced on", async () => {
    const a = await newInstall();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ id: "x", status: "completed", steps: [], usage: {}, model: "m", other: 1 }),
      ),
    );
    const res = await interactions({ request: await signed("/api/relay/v1/interactions", a, turn(3)), env });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "x", status: "completed", steps: [], usage: {}, model: "m" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
    const body = sentBody();
    expect(body["store"]).toBe(false);
    expect(body["tools"][1]).toMatchObject({ type: "computer_use", enable_prompt_injection_detection: true });

    const unset = turn();
    delete unset["store"];
    await interactions({ request: await signed("/api/relay/v1/interactions", a, unset), env });
    expect(sentBody(1)["store"]).toBe(false);
  });

  it("caps screenshots, refuses links, audio and video, server-side tools, other fields and other models", async () => {
    const a = await newInstall();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: "completed" })));
    const path = "/api/relay/v1/interactions";
    const withResult = (part: unknown) => {
      const t = turn(0);
      (t["input"] as Record<string, unknown>[])[2]!["result"] = [part];
      return t;
    };
    const cases: [Record<string, unknown>, number][] = [
      [turn(5), 400],
      [withResult({ type: "image", uri: "https://example.com/cat.png", mime_type: "image/png" }), 400],
      [withResult({ type: "image", data: PIXELS, mime_type: "image/gif" }), 400],
      [withResult({ type: "image", data: "A".repeat(3_000_001), mime_type: "image/png" }), 413],
      [withResult({ type: "video", data: PIXELS, mime_type: "video/mp4" }), 400],
      [withResult({ type: "audio", data: PIXELS, mime_type: "audio/wav" }), 400],
      [{ ...turn(), store: true }, 400],
      [{ ...turn(), background: true }, 400],
      [{ ...turn(), previous_interaction_id: "abc" }, 400],
      [{ ...turn(), tools: [{ type: "google_search" }] }, 400],
      [{ ...turn(), tools: [{ type: "url_context" }] }, 400],
      [{ ...turn(), generation_config: { thinking_level: "low", speech_config: {} } }, 400],
      [{ ...turn(), generation_config: { max_output_tokens: 100_000 } }, 400],
      [{ ...turn(), input: [{ type: "google_search_call" }] }, 400],
      [{ ...turn(), input: [] }, 400],
      [{ ...turn(), model: "gemini-3.5-flash-lite" }, 400],
    ];
    for (const [payload, code] of cases) {
      const res = await interactions({ request: await signed(path, a, payload), env });
      expect(res.status, JSON.stringify(payload).slice(0, 200)).toBe(code);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("limits and the daily budget", () => {
  it("holds an install over its minute limit, says when to come back, and keeps other installs going", async () => {
    const a = await newInstall();
    const b = await newInstall();
    fetchMock.mockImplementation(async () => geminiAnswer());
    const tight = { ...env, RELAY_INSTALL_PER_MINUTE: "3" };
    const codes: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 5; i++) {
      last = await generate({ request: await signed("/api/relay/v1/generate", a, PLAN), env: tight });
      codes.push(last.status);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect(await errorOf(last!)).toMatchObject({
      reason: "busy",
      message: "AGENCY's AI is busy. Try again in a minute.",
    });
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const other = await generate({ request: await signed("/api/relay/v1/generate", b, PLAN), env: tight });
    expect(other.status).toBe(200);
  });

  it("limits each install and each network per day", async () => {
    const a = await newInstall();
    fetchMock.mockImplementation(async () => geminiAnswer());
    const perDay = { ...env, RELAY_INSTALL_PER_DAY: "2" };
    const codes: number[] = [];
    for (let i = 0; i < 3; i++)
      codes.push(
        (await generate({ request: await signed("/api/relay/v1/generate", a, PLAN), env: perDay })).status,
      );
    expect(codes).toEqual([200, 200, 429]);

    const ip = "203.0.113.9";
    const network = { ...env, RELAY_IP_PER_DAY: "2" };
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const install = await newInstall(env, freshIp());
      const res = await generate({
        request: await signed("/api/relay/v1/generate", install, PLAN, { ip }),
        env: network,
      });
      results.push(res.status === 200 ? "ok" : (await errorOf(res)).reason);
    }
    expect(results).toEqual(["ok", "ok", "daily_limit"]);
  });

  it("stops everyone at the global daily cap, and refused requests don't use the budget up", async () => {
    fetchMock.mockImplementation(async () => geminiAnswer());
    const capped = { ...env, RELAY_DAILY_REQUEST_CAP: "3", RELAY_INSTALL_PER_MINUTE: "1" };
    const noisy = await newInstall();
    // One install hammering past its own limit: only its first request counts toward the day's budget.
    for (let i = 0; i < 6; i++)
      await generate({ request: await signed("/api/relay/v1/generate", noisy, PLAN), env: capped });
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const install = await newInstall();
      const res = await generate({
        request: await signed("/api/relay/v1/generate", install, PLAN),
        env: capped,
      });
      results.push(res.status === 200 ? "ok" : (await errorOf(res)).reason);
    }
    expect(results).toEqual(["ok", "ok", "budget"]);
    const res = await generate({
      request: await signed("/api/relay/v1/generate", await newInstall(), PLAN),
      env: capped,
    });
    expect(await errorOf(res)).toMatchObject({
      reason: "budget",
      message: "AGENCY's AI has reached its daily limit, so the built-in plan is used until tomorrow.",
    });
    // Raising the cap takes effect at once.
    const raised = { ...capped, RELAY_DAILY_REQUEST_CAP: "100" };
    const again = await generate({
      request: await signed("/api/relay/v1/generate", await newInstall(), PLAN),
      env: raised,
    });
    expect(again.status).toBe(200);
  });

  it("counts in D1 when the binding exists, and in memory if D1 fails", async () => {
    const db = new FakeD1();
    fetchMock.mockImplementation(async () => geminiAnswer());
    const withDb = { ...env, RELAY_DB: db, RELAY_INSTALL_PER_MINUTE: "2" };
    const a = await newInstall(withDb);
    const codes: number[] = [];
    for (let i = 0; i < 3; i++)
      codes.push(
        (await generate({ request: await signed("/api/relay/v1/generate", a, PLAN), env: withDb })).status,
      );
    expect(codes).toEqual([200, 200, 429]);
    expect(db.created).toBe(true);
    expect([...db.rows.keys()].some((k) => k.startsWith(`im:${a.installId}:`))).toBe(true);
    // Networks are counted under a keyed hash: no address is stored.
    expect([...db.rows.keys()].some((k) => k.includes("10.1."))).toBe(false);

    const failing = new FakeD1();
    failing.broken = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = await newInstall();
    const res = await generate({
      request: await signed("/api/relay/v1/generate", b, PLAN),
      env: { ...env, RELAY_DB: failing },
    });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
  });
});

describe("privacy", () => {
  it("never logs request content, whatever happens", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const a = await newInstall();
    const google = (code: number) =>
      new Response(JSON.stringify({ error: { code, message: "failed" } }), { status: code });
    fetchMock
      .mockResolvedValueOnce(geminiAnswer(PROMPT))
      .mockResolvedValueOnce(google(500))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(google(403));
    for (let i = 0; i < 5; i++) {
      await generate({ request: await signed("/api/relay/v1/generate", a, PLAN), env });
      await interactions({ request: await signed("/api/relay/v1/interactions", a, turn()), env });
    }
    await generate({ request: await signed("/api/relay/v1/generate", a, { ...PLAN, junk: PROMPT }), env });
    await generate({
      request: await signed("/api/relay/v1/generate", a, PLAN, { tamper: (b) => `${b} ` }),
      env,
    });
    await generate({
      request: await signed("/api/relay/v1/generate", a, PLAN),
      env: { ...env, RELAY_DB: Object.assign(new FakeD1(), { broken: true }) },
    });
    const logged = spies
      .flatMap((s) => s.mock.calls.flat())
      .map(String)
      .join("\n");
    expect(spies.some((s) => s.mock.calls.length > 0)).toBe(true); // the failures above were noted...
    expect(logged).not.toContain("PRIVATE"); // ...without any of the content
    expect(logged).not.toContain(PIXELS);
    expect(logged).not.toContain("You plan.");
    expect(logged).not.toContain(a.installId);
  });
});

/** Enough of D1 for the counters: one table, upsert-and-return, delete. */
class FakeD1 implements D1Like {
  rows = new Map<string, { n: number; exp: number }>();
  created = false;
  broken = false;

  prepare(sql: string): D1Statement {
    let values: unknown[] = [];
    const statement: D1Statement & { exec: () => { results: unknown[] } } = {
      bind: (...v: unknown[]) => {
        values = v;
        return statement;
      },
      run: async () => statement.exec(),
      exec: () => {
        if (this.broken) throw new Error("D1 unavailable");
        if (sql.startsWith("CREATE TABLE")) {
          this.created = true;
          return { results: [] };
        }
        if (sql.startsWith("INSERT")) {
          const [k, exp] = values as [string, number];
          const row = this.rows.get(k) ?? { n: 0, exp };
          row.n += 1;
          this.rows.set(k, row);
          return { results: [{ n: row.n }] };
        }
        if (sql.startsWith("DELETE")) {
          for (const [k, r] of this.rows) if (r.exp < (values[0] as number)) this.rows.delete(k);
          return { results: [] };
        }
        throw new Error(`unexpected SQL ${sql}`);
      },
    };
    return statement;
  }

  async batch(statements: D1Statement[]): Promise<{ results?: unknown[] }[]> {
    if (this.broken) throw new Error("D1 unavailable");
    return statements.map((s) => (s as unknown as { exec: () => { results: unknown[] } }).exec());
  }
}
