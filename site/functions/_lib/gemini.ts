/** Shared by the site's AI functions: the Gemini call (key from a Cloudflare secret) and a per-visitor limit. */

export interface Env {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

/** Cloudflare Pages Functions context (only what these files use, so no extra type package is needed). */
export interface Context {
  request: Request;
  env: Env;
}

export const MODEL = "gemini-3.5-flash-lite"; // about a second; GEMINI_MODEL overrides
const PER_MINUTE = 12;
const MAX_VISITORS = 5000;
// The API's own minimum deadline is 10 s; past this the page uses its built-in behaviour anyway.
const TIMEOUT_MS = 15_000;
const seen = new Map<string, number[]>();

export const modelOf = (env: Env): string => env.GEMINI_MODEL || MODEL;

/** True when this visitor has sent more than `perMinute` requests in the last minute. */
export function limited(request: Request, perMinute = PER_MINUTE): boolean {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const now = Date.now();
  const recent = (seen.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  seen.delete(ip);
  seen.set(ip, recent); // most recent visitors last
  if (seen.size > MAX_VISITORS) {
    // Forget visitors who have been quiet for a minute, then the oldest, but never everyone's limits at once.
    for (const [key, times] of seen) if (!times.some((t) => now - t < 60_000)) seen.delete(key);
    for (const key of seen.keys()) {
      if (seen.size <= MAX_VISITORS) break;
      seen.delete(key);
    }
  }
  return recent.length > perMinute;
}

/** One line of plain text: no control characters, single spaces, at most `max` characters. */
export function clean(text: unknown, max: number): string {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** The answer shape for replies and sentence endings: {"items": [strings]}. */
export const ITEMS_SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "string" } } },
  required: ["items"],
};

/**
 * One JSON answer from Gemini (any JSON value), or null when it fails, times out or isn't JSON. With a schema,
 * Gemini's structured output keeps the answer in that shape (without one it sometimes drops the wrapper object).
 */
export async function gemini(
  env: Env,
  system: string,
  user: string,
  maxTokens = 1024,
  temperature = 0.5,
  schema?: Record<string, unknown>,
): Promise<unknown> {
  const model = modelOf(env);
  const reply = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY ?? "" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: maxTokens,
          temperature,
          ...(schema ? { responseJsonSchema: schema } : {}),
          // Replies, sentence endings and short plans need speed, not deep thought (Gemini 3 models take a level).
          ...(model.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  ).catch(() => null);
  if (!reply || !reply.ok) return null;
  const data = (await reply.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  } | null;
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => (p && !p.thought ? (p.text ?? "") : "")).join("") : "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Short, distinct strings from {"items": [...]} (or a bare list); anything else gives none. */
export function items(data: unknown, count: number, max: number): string[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? (data as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const text = clean(item, max);
    if (text && !out.some((o) => o.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out.slice(0, count);
}

/** The request's JSON object, or the error response to send instead (too large, not JSON, not an object). */
export async function body(request: Request, maxBytes = 4000): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return json({ error: "Request too large." }, 413);
  const text = await request.text();
  if (text.length > maxBytes) return json({ error: "Request too large." }, 413);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return json({ error: "Not JSON." }, 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return json({ error: "Expected a JSON object." }, 400);
  return value as Record<string, unknown>;
}

/** Up to 20 short phrases from a list (anything else gives none). */
export function phrases(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .slice(0, 20)
        .map((p) => clean(p, 80))
        .filter(Boolean)
    : [];
}
