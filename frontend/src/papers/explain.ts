/**
 * Explaining a letter: with Gemini through the coordinator (only after the person agreed on screen, and only if a
 * helper hasn't turned it off), or the basic version made on this computer. A model's answer is checked against
 * the letter here too (os/tasks explain.ts): any date or amount whose quoted line isn't in the letter is dropped.
 */
import { accessToken, coordinatorUrl } from "../api/client";
import {
  basicExplanation,
  validateExplanation,
  type LetterExplanation,
} from "../../../os/tasks/src/documents/explain";

export interface Explained {
  explanation: LetterExplanation;
  /** Who explained it, for the badge: "Gemini (gemini-2.5-flash)". */
  label?: string;
  /** Why it's the basic version, when it is. */
  note?: string;
}

/** POSTs JSON to the coordinator; the status and body, or throws on a network error or Stop. */
export type Poster = (
  path: string,
  body: unknown,
  signal: AbortSignal,
) => Promise<{ status: number; body: unknown }>;

export const coordinatorPost: Poster = async (path, body, signal) => {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = accessToken();
  if (token) headers.set("X-Agency-Token", token);
  const timeout = AbortSignal.timeout(45_000);
  const r = await fetch(`${coordinatorUrl()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, timeout]),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

export const BASIC_NOTE_OFF =
  "Explaining with Gemini is turned off in Settings, so these are the basics AGENCY found on this computer.";
export const BASIC_NOTE_CHOSEN =
  "You chose the basics: nothing was sent. AGENCY found these on this computer.";

/**
 * Explain `text`. With `cloud` false nothing is sent at all. Stop (the signal) cancels the request; that throws, so
 * the caller can say it stopped.
 */
export async function explainLetter(
  text: string,
  opts: { cloud: boolean; signal: AbortSignal; post?: Poster; reason?: "off" | "chosen" },
): Promise<Explained> {
  if (!opts.cloud)
    return {
      explanation: basicExplanation(text),
      note: opts.reason === "chosen" ? BASIC_NOTE_CHOSEN : BASIC_NOTE_OFF,
    };
  const post = opts.post ?? coordinatorPost;
  let res: { status: number; body: unknown };
  try {
    res = await post("/api/assist/letter", { text }, opts.signal);
  } catch (err) {
    if (opts.signal.aborted) throw err;
    return {
      explanation: basicExplanation(text),
      note: "AGENCY couldn't reach Gemini, so these are the basics it found on this computer.",
    };
  }
  const body = (res.body ?? {}) as { explanation?: unknown; label?: string };
  const checked = res.status === 200 ? validateExplanation(body.explanation, text) : null;
  if (checked) return { explanation: checked, ...(body.label ? { label: body.label } : {}) };
  return {
    explanation: basicExplanation(text),
    note:
      res.status === 503
        ? "Gemini isn't set up or the network is too poor right now, so these are the basics AGENCY found on this computer."
        : "Gemini's explanation didn't pass AGENCY's checks, so these are the basics AGENCY found on this computer.",
  };
}
