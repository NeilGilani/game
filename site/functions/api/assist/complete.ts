/**
 * POST /api/assist/complete { text, recent } -> { completions, label }: ways to finish the sentence the person
 * started on the web demo's word board.
 */
import {
  ITEMS_SCHEMA,
  type Context,
  body,
  clean,
  gemini,
  items,
  json,
  limited,
  phrases,
} from "../../_lib/gemini";

const SYSTEM =
  "You help a person who speaks by choosing words with their eyes. Give 3 likely full sentences that begin " +
  "exactly with the started words, each at most 12 words, everyday and natural. " +
  'Answer only JSON: {"items": [...]}';

export const onRequestPost = async ({ request, env }: Context): Promise<Response> => {
  if (!env.GEMINI_API_KEY) return json({ error: "Gemini isn't set up on this site." }, 503);
  if (limited(request)) return json({ error: "Too many requests in a minute." }, 429);
  const b = await body(request);
  if (b instanceof Response) return b;
  // Cleaned the same way as the answers (single spaces), so "I  want" still matches "I want tea".
  const text = clean(b["text"], 200);
  if (!text) return json({ error: "Nothing started." }, 400);
  const recent = phrases(b["recent"]);
  const out = await gemini(
    env,
    SYSTEM,
    `<started>${text}</started>\nTheir phrases: ${recent.join(" | ") || "none"}`,
    500,
    0.5,
    ITEMS_SCHEMA,
  );
  const start = text.toLowerCase();
  const completions = items(out, 6, 90)
    .filter((s) => s.toLowerCase().startsWith(start) && s.toLowerCase() !== start)
    .slice(0, 3);
  return completions.length
    ? json({ completions, label: "Gemini" })
    : json({ error: "No usable completions." }, 502);
};
