/** The web demo's Gemini functions (site/functions): input bounds, JSON parsing, error paths. No network. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestPost as plan } from "../../functions/api/agent/plan";
import { onRequestPost as complete } from "../../functions/api/assist/complete";
import { onRequestPost as replies } from "../../functions/api/assist/replies";

const env = { GEMINI_API_KEY: "test-key-not-real" };
let ip = 0;

function post(body: string, headers: Record<string, string> = {}): Request {
  ip += 1; // a fresh visitor per request, so the rate limit only applies where a test wants it
  return new Request("https://agency.example/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `10.0.0.${ip}`, ...headers },
    body,
  });
}

/** Gemini's generateContent answer with this text as the model's output. */
function gemini(text: string, status = 200): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status });
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const STEPS = JSON.stringify({
  steps: [
    { title: "Open the store", risk: "read", done: "Opened it" },
    { title: "Pay", risk: "consequential", done: "Paid" },
  ],
});

describe("POST /api/agent/plan", () => {
  it("answers a valid plan, with the model and the thinking level only for Gemini 3", async () => {
    fetchMock.mockResolvedValue(gemini(STEPS));
    const res = await plan({ request: post(JSON.stringify({ goal: "Order soup" })), env });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { steps: unknown[] }).steps).toHaveLength(2);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      generationConfig: { thinkingConfig?: unknown };
    };
    expect(sent.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });

    fetchMock.mockResolvedValue(gemini(STEPS));
    await plan({
      request: post(JSON.stringify({ goal: "Order soup" })),
      env: { ...env, GEMINI_MODEL: "gemini-2.5-flash" },
    });
    const older = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      generationConfig: { thinkingConfig?: unknown };
    };
    expect(older.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("answers 400, never crashes, on JSON that isn't an object", async () => {
    for (const body of ["null", "[]", "5", '"text"', "{", ""]) {
      const res = await plan({ request: post(body), env });
      expect(res.status, body).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502, never crashes, when Gemini's answer has the wrong shape", async () => {
    for (const text of [
      "null",
      "[]",
      '{"steps": null}',
      '{"steps": [null, null]}',
      '{"steps": ["a", "b"]}',
      "not json",
    ]) {
      fetchMock.mockResolvedValue(gemini(text));
      const res = await plan({ request: post(JSON.stringify({ goal: "Order soup" })), env });
      expect(res.status, text).toBe(502);
    }
  });

  it("refuses large requests and too many in a minute", async () => {
    const big = await plan({ request: post(JSON.stringify({ goal: "x".repeat(5000) })), env });
    expect(big.status).toBe(413);
    fetchMock.mockImplementation(async () => gemini(STEPS));
    const one = { "cf-connecting-ip": "192.0.2.1" };
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      codes.push((await plan({ request: post(JSON.stringify({ goal: "Soup" }), one), env })).status);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  it("answers 502 when Gemini doesn't answer in time", async () => {
    let signal: unknown = null;
    fetchMock.mockImplementation(async (_url, init) => {
      signal = init?.signal;
      throw new DOMException("timed out", "TimeoutError");
    });
    const res = await plan({ request: post(JSON.stringify({ goal: "Order soup" })), env });
    expect(res.status).toBe(502);
    expect(signal).toBeInstanceOf(AbortSignal); // every call to Gemini has a deadline
  });
});

describe("POST /api/assist/replies and /complete", () => {
  it("answers 400 on JSON that isn't an object, and 502 on an unusable answer", async () => {
    for (const fn of [replies, complete]) {
      for (const body of ["null", "[]", "{"]) {
        expect((await fn({ request: post(body), env })).status, body).toBe(400);
      }
    }
    for (const text of ["null", '{"items": null}', '{"items": [null]}', "nope"]) {
      fetchMock.mockResolvedValue(gemini(text));
      expect((await replies({ request: post(JSON.stringify({ heard: "Tea?" })), env })).status, text).toBe(
        502,
      );
    }
  });

  it("gives replies and completions that start with the started words", async () => {
    fetchMock.mockResolvedValue(gemini(JSON.stringify({ items: ["Yes please", "No thanks", "Yes please"] })));
    const r = await replies({ request: post(JSON.stringify({ heard: "Tea?", recent: ["hi"] })), env });
    expect(await r.json()).toEqual({ replies: ["Yes please", "No thanks"], label: "Gemini" });
    fetchMock.mockResolvedValue(gemini(JSON.stringify({ items: ["I want tea", "You want", "I want"] })));
    const c = await complete({ request: post(JSON.stringify({ text: "I  want" })), env });
    expect(await c.json()).toEqual({ completions: ["I want tea"], label: "Gemini" });
  });

  it("refuses oversized bodies without reading them into a prompt", async () => {
    const res = await replies({ request: post(JSON.stringify({ heard: "x".repeat(5000) })), env });
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("without a key answers 503 and never calls Gemini", async () => {
    expect((await replies({ request: post('{"heard":"hi"}'), env: {} })).status).toBe(503);
    expect((await plan({ request: post('{"goal":"hi"}'), env: {} })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
