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

export const MODEL = "gemini-3.8-flash";
const PER_MINUTE = 12;
const seen = new Map<string, number[]>();

export function limited(request: Request): boolean {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const now = Date.now();
  const recent = (seen.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  seen.set(ip, recent);
  if (seen.size > 5000) seen.clear();
  return recent.length > PER_MINUTE;
}

export function clean(text: unknown, max: number): string {
  return String(text ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, max);
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** One JSON answer from Gemini, or null. */
export async function gemini(env: Env, system: string, user: string, maxTokens = 1024): Promise<unknown> {
  const model = env.GEMINI_MODEL || MODEL;
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
          temperature: 0.5,
        },
      }),
    },
  ).catch(() => null);
  if (!reply || !reply.ok) return null;
  const data = (await reply.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  } | null;
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Short, distinct strings from {"items": [...]}. */
export function items(data: unknown, count: number, max: number): string[] {
  const list = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const text = clean(item, max);
    if (text && !out.some((o) => o.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out.slice(0, count);
}

export async function body(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > 4000) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
