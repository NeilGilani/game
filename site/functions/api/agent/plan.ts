/**
 * Cloudflare Pages Function for the web demo (/app/): Gemini plans the task the visitor chose with their eyes.
 *
 * POST /api/agent/plan  { goal, kind, selections }  ->  { steps: [{ title, risk, done }], model, ms }
 *
 * - The Gemini key is a Cloudflare secret (GEMINI_API_KEY), never in the page. Without it this answers 503 and the
 *   demo uses its built-in plan, saying so.
 * - Only plans: nothing is executed here. The demo carries out the plan on practice (simulated) services, and the
 *   step that pays, sends or calls still waits for the visitor's approval in the page.
 * - Small and bounded: short input, a fixed instruction, a JSON answer, a per-visitor rate limit, a deadline.
 */
import { type Context, body, clean, gemini, json, limited, modelOf } from "../../_lib/gemini";

type Risk = "read" | "reversible" | "consequential";
interface Step {
  title: string;
  risk: Risk;
  done: string;
}

const PER_MINUTE = 8;

const SYSTEM = [
  "You are the planner inside AGENCY, an assistant for people who can only move their eyes.",
  "Plan the task the person chose as 3 to 6 short steps a careful agent would take on a computer.",
  'Each step: "title" (imperative, at most 8 words), "risk" ("read", "reversible" or "consequential"),',
  'and "done" (past tense, at most 10 words, what happened).',
  "Mark exactly one step consequential if the task pays, sends, calls, signs, submits or books; otherwise none.",
  "Never ask for or include passwords, card numbers or codes. Plain words. No emoji.",
  'Answer only JSON: {"steps":[...]}',
].join(" ");

/** Gemini's plan if it passes the checks, else null. Any shape of answer is handled, none throws. */
function parseSteps(data: unknown): Step[] | null {
  const list = data && typeof data === "object" ? (data as { steps?: unknown }).steps : undefined;
  if (!Array.isArray(list) || list.length < 2 || list.length > 8) return null;
  const steps: Step[] = [];
  for (const s of list) {
    if (!s || typeof s !== "object") return null;
    const { risk, title, done } = s as { risk?: unknown; title?: unknown; done?: unknown };
    if (risk !== "read" && risk !== "reversible" && risk !== "consequential") return null;
    if (typeof title !== "string" || typeof done !== "string") return null;
    const step: Step = { title: clean(title, 80), risk, done: clean(done, 100) };
    if (!step.title || !step.done) return null;
    steps.push(step);
  }
  if (steps.filter((s) => s.risk === "consequential").length > 1) return null;
  return steps;
}

/** Whether the site's Gemini planner is set up (the web demo's status bar says which planner it has). */
export const onRequestGet = async ({ env }: Context): Promise<Response> =>
  json({ ready: !!env.GEMINI_API_KEY, model: modelOf(env) });

export const onRequestPost = async ({ request, env }: Context): Promise<Response> => {
  if (!env.GEMINI_API_KEY) return json({ error: "Gemini isn't set up on this site." }, 503);
  if (limited(request, PER_MINUTE))
    return json({ error: "Too many plans in a minute. Try again shortly." }, 429);
  const b = await body(request, 2000);
  if (b instanceof Response) return b;
  const goal = clean(b["goal"], 200);
  if (!goal) return json({ error: "No task." }, 400);
  const kind = clean(b["kind"], 30);
  const chosen = b["selections"];
  const selections = (
    chosen && typeof chosen === "object" && !Array.isArray(chosen) ? Object.entries(chosen) : []
  )
    .slice(0, 12)
    .map(([k, v]) => `${clean(k, 30)}: ${clean(v, 80)}`)
    .join("; ");

  const started = Date.now();
  const out = await gemini(env, SYSTEM, `Task: ${goal}\nKind: ${kind}\nChoices: ${selections}`, 1024, 0.4);
  if (out === null) return json({ error: "Gemini didn't answer." }, 502);
  const steps = parseSteps(out);
  if (!steps) return json({ error: "Gemini's plan didn't pass the checks." }, 502);
  return json({ steps, model: modelOf(env), ms: Date.now() - started });
};
