/**
 * Cloudflare Pages Function for the web demo (/app/): Gemini plans the task the visitor chose with their eyes.
 *
 * POST /api/agent/plan  { goal, kind, selections }  ->  { steps: [{ title, risk, done }], model, ms }
 *
 * - The Gemini key is a Cloudflare secret (GEMINI_API_KEY), never in the page. Without it this answers 503 and the
 *   demo uses its built-in plan, saying so.
 * - Only plans: nothing is executed here. The demo carries out the plan on practice (simulated) services, and the
 *   step that pays, sends or calls still waits for the visitor's approval in the page.
 * - Small and bounded: short input, a fixed instruction, a JSON answer, a per-visitor rate limit.
 */

interface Env {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

type Risk = "read" | "reversible" | "consequential";
interface Step {
  title: string;
  risk: Risk;
  done: string;
}

const MODEL = "gemini-3.8-flash";
const PER_MINUTE = 8;
const seen = new Map<string, number[]>();

const SYSTEM = [
  "You are the planner inside AGENCY, an assistant for people who can only move their eyes.",
  "Plan the task the person chose as 3 to 6 short steps a careful agent would take on a computer.",
  'Each step: "title" (imperative, at most 8 words), "risk" ("read", "reversible" or "consequential"),',
  'and "done" (past tense, at most 10 words, what happened).',
  "Mark exactly one step consequential if the task pays, sends, calls, signs, submits or books; otherwise none.",
  "Never ask for or include passwords, card numbers or codes. Plain words. No emoji.",
  'Answer only JSON: {"steps":[...]}',
].join(" ");

function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (seen.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  seen.set(ip, recent);
  if (seen.size > 5000) seen.clear();
  return recent.length > PER_MINUTE;
}

function clean(text: unknown, max: number): string {
  return String(text ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, max);
}

function parseSteps(raw: string): Step[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = (data as { steps?: unknown }).steps;
  if (!Array.isArray(list) || list.length < 2 || list.length > 8) return null;
  const steps: Step[] = [];
  for (const s of list) {
    const risk = (s as { risk?: string }).risk;
    if (risk !== "read" && risk !== "reversible" && risk !== "consequential") return null;
    const title = clean((s as { title?: string }).title, 80);
    const done = clean((s as { done?: string }).done, 100);
    if (!title || !done) return null;
    steps.push({ title, risk, done });
  }
  if (steps.filter((s) => s.risk === "consequential").length > 1) return null;
  return steps;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Cloudflare Pages Functions context (only what this file uses, so no extra type package is needed). */
interface Context {
  request: Request;
  env: Env;
}

/** Whether the site's Gemini planner is set up (the web demo's status bar says which planner it has). */
export const onRequestGet = async ({ env }: Context): Promise<Response> =>
  json({ ready: !!env.GEMINI_API_KEY, model: env.GEMINI_MODEL || MODEL });

export const onRequestPost = async ({ request, env }: Context): Promise<Response> => {
  if (!env.GEMINI_API_KEY) return json({ error: "Gemini isn't set up on this site." }, 503);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (limited(ip)) return json({ error: "Too many plans in a minute. Try again shortly." }, 429);
  const text = await request.text();
  if (text.length > 2000) return json({ error: "Request too large." }, 413);
  let body: { goal?: unknown; kind?: unknown; selections?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Not JSON." }, 400);
  }
  const goal = clean(body.goal, 200);
  if (!goal) return json({ error: "No task." }, 400);
  const kind = clean(body.kind, 30);
  const selections = Object.entries((body.selections as Record<string, unknown>) ?? {})
    .slice(0, 12)
    .map(([k, v]) => `${clean(k, 30)}: ${clean(v, 80)}`)
    .join("; ");

  const model = env.GEMINI_MODEL || MODEL;
  const started = Date.now();
  const reply = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [
          { role: "user", parts: [{ text: `Task: ${goal}\nKind: ${kind}\nChoices: ${selections}` }] },
        ],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1024, temperature: 0.4 },
      }),
    },
  ).catch(() => null);
  if (!reply || !reply.ok) return json({ error: "Gemini didn't answer." }, 502);
  const data = (await reply.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  } | null;
  const out = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const steps = parseSteps(out);
  if (!steps) return json({ error: "Gemini's plan didn't pass the checks." }, 502);
  return json({ steps, model, ms: Date.now() - started });
};
