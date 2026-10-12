/**
 * Explaining a letter: what is sent (only the text, bounded, card numbers removed), how a
 * model's answer is checked before the person sees it, and the basic on-device version.
 *
 * Every date and amount must come with the line it was read from, and that line must really
 * be in the letter: a fact whose quote isn't found, or whose numbers aren't in its quote, is
 * dropped. The letter is untrusted data; nothing in it is ever followed.
 */

import { redactSecrets } from "../policy/secrets";

/** At most this much letter text is sent. Send the minimum. */
export const EXPLAIN_CHAR_LIMIT = 12000;

export interface QuotedFact {
  /** The fact in plain words: "Reply by November 30, 2026". */
  text: string;
  /** The line of the letter it came from, word for word. */
  quote: string;
}

export interface LetterExplanation {
  /** "gemini": checked model answer. "basic": found on this computer by simple patterns, no AI. */
  source: "gemini" | "basic";
  what: string;
  from: string;
  fromQuote?: string;
  wants: string;
  deadlines: QuotedFact[];
  amounts: QuotedFact[];
  nextSteps: string[];
  /** Facts removed because their quoted line isn't in the letter. */
  dropped: number;
}

/** The text that would be sent: card-like numbers removed, cut to the limit. */
export function letterText(pages: readonly string[]): { text: string; truncated: boolean } {
  const full = redactSecrets(pages.join("\n\n")).trim();
  const truncated = full.length > EXPLAIN_CHAR_LIMIT;
  return { text: truncated ? full.slice(0, EXPLAIN_CHAR_LIMIT) : full, truncated };
}

/** True when there is enough text to explain (a scanned page has none). */
export function hasReadableText(text: string): boolean {
  return (text.match(/[A-Za-z]{2,}/g) ?? []).length >= 8;
}

/** Lowercase, one space, plain quotes and dashes: how quotes and the letter are compared. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does this quote appear in the letter, word for word (ignoring case and spacing)? */
export function quoteAppears(quote: string, text: string): boolean {
  const q = normalize(quote).replace(/^["'.\s]+|["'.\s]+$/g, "");
  if (q.length < 4) return false;
  return normalize(text).includes(q);
}

/** Numbers in a claim, without thousands separators: "$1,240.00" gives "1240.00". */
function numbers(s: string): string[] {
  return (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

/** A fact stands only if its quote is in the letter and every number it states is in that quote. */
export function factHolds(fact: QuotedFact, text: string): boolean {
  if (!fact.text.trim() || !quoteAppears(fact.quote, text)) return false;
  const inQuote = new Set(numbers(fact.quote));
  return numbers(fact.text).every((n) => inQuote.has(n));
}

function str(v: unknown, limit: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function facts(v: unknown, text: string, max: number): { kept: QuotedFact[]; dropped: number } {
  const kept: QuotedFact[] = [];
  let dropped = 0;
  for (const item of Array.isArray(v) ? v.slice(0, 12) : []) {
    const o = (item ?? {}) as Record<string, unknown>;
    const fact = { text: str(o.text, 160), quote: str(o.quote, 300) };
    if (!fact.text) continue;
    if (!factHolds(fact, text)) dropped += 1;
    else if (kept.length < max) kept.push(fact);
  }
  return { kept, dropped };
}

/**
 * Check a model's answer against the letter. Returns null when nothing usable is left. The
 * same checks run on the coordinator; they run here again so the screen never trusts the wire.
 */
export function validateExplanation(raw: unknown, text: string): LetterExplanation | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const what = str(o.what, 300);
  const wants = str(o.wants, 400);
  if (!what && !wants) return null;
  const deadlines = facts(o.deadlines, text, 4);
  const amounts = facts(o.amounts, text, 4);
  const fromQuote = str(o.from_quote ?? o.fromQuote, 200);
  const nextSteps = (
    Array.isArray(o.next_steps ?? o.nextSteps) ? ((o.next_steps ?? o.nextSteps) as unknown[]) : []
  )
    .map((s) => str(s, 160))
    .filter(Boolean)
    .slice(0, 4);
  return {
    source: "gemini",
    what,
    from: str(o.from, 120),
    ...(fromQuote && quoteAppears(fromQuote, text) ? { fromQuote } : {}),
    wants,
    deadlines: deadlines.kept,
    amounts: amounts.kept,
    nextSteps,
    dropped: deadlines.dropped + amounts.dropped,
  };
}

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const DATE = new RegExp(
  `\\b(?:(?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}|\\d{1,2} (?:${MONTHS}) \\d{4}|\\d{1,2}/\\d{1,2}/\\d{2,4}|\\d{4}-\\d{2}-\\d{2})\\b`,
  "g",
);
const AMOUNT = /(?:\$|USD ?|€|£)\s?\d[\d,]*(?:\.\d{2})?/g;
const DEADLINE_WORDS = /\b(by|before|due|deadline|no later than|until|expires?|must)\b/i;

/** The letter's lines, for quoting: one per line of text, trimmed. */
function lines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

/**
 * The basic explanation, made on this computer with no AI: dates and amounts by simple
 * patterns, each with the line it was found in. Honest about being basic.
 */
export function basicExplanation(text: string): LetterExplanation {
  const all = lines(text);
  const deadlines: QuotedFact[] = [];
  const amounts: QuotedFact[] = [];
  const seenDates = new Set<string>();
  const seenAmounts = new Set<string>();
  for (const line of all) {
    for (const d of line.match(DATE) ?? []) {
      if (seenDates.has(d) || deadlines.length >= 4) continue;
      seenDates.add(d);
      deadlines.push({
        text: DEADLINE_WORDS.test(line) ? `Possible deadline: ${d}` : `Date: ${d}`,
        quote: line,
      });
    }
    for (const a of line.match(AMOUNT) ?? []) {
      const clean = a.replace(/\s+/g, "");
      if (seenAmounts.has(clean) || amounts.length >= 4) continue;
      seenAmounts.add(clean);
      amounts.push({ text: `Amount: ${clean}`, quote: line });
    }
  }
  const first = all.find((l) => l.length > 3) ?? "";
  return {
    source: "basic",
    what: first ? `It starts: "${first.slice(0, 120)}"` : "AGENCY couldn't find any words in it.",
    from: "",
    wants: "",
    deadlines,
    amounts,
    nextSteps: [],
    dropped: 0,
  };
}

/** The words read aloud for an explanation: the cards in order, nothing else. */
export function explanationSpeech(e: LetterExplanation): string {
  const parts: string[] = [];
  if (e.what) parts.push(e.what);
  if (e.from) parts.push(`It's from ${e.from}.`);
  if (e.wants) parts.push(`What they want: ${e.wants}`);
  for (const d of e.deadlines) parts.push(`${d.text}.`);
  for (const a of e.amounts) parts.push(`${a.text}.`);
  if (e.nextSteps.length) parts.push(`What you might do next: ${e.nextSteps.join(". ")}.`);
  return parts.join(" ").replace(/\.\./g, ".");
}
