/**
 * Word and phrase prediction for Talk. Everything here is local and explainable: counts from
 * the person's own history (what they said before, word after word), suggestions from the
 * memory tree (surface "talk" and "keyboard"), and a small built-in fallback. No model.
 */

import type { Suggestion } from "../contracts";
import { CORE_WORDS } from "./vocabulary";

export interface Prediction {
  text: string;
  /** Plain-language reason, shown to the person on request. */
  reason: string;
  score: number;
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Bigram and unigram counts learned from spoken history. */
export class WordModel {
  private readonly unigrams = new Map<string, number>();
  private readonly bigrams = new Map<string, Map<string, number>>();

  constructor(history: readonly string[] = []) {
    for (const h of history) this.learn(h);
  }

  learn(utterance: string): void {
    const ws = words(utterance);
    let prev = "<s>";
    for (const w of ws) {
      this.unigrams.set(w, (this.unigrams.get(w) ?? 0) + 1);
      const next = this.bigrams.get(prev) ?? new Map<string, number>();
      next.set(w, (next.get(w) ?? 0) + 1);
      this.bigrams.set(prev, next);
      prev = w;
    }
  }

  /** Next words after `message` (or completions of a partly typed last word). */
  next(message: string, limit = 6): Prediction[] {
    const trailingSpace = message === "" || /\s$/.test(message);
    const ws = words(message);
    const partial = trailingSpace ? "" : (ws.pop() ?? "");
    const prev = ws.at(-1) ?? "<s>";
    const scores = new Map<string, Prediction>();
    const add = (text: string, score: number, reason: string) => {
      if (partial && !text.startsWith(partial)) return;
      if (text === partial) return;
      const current = scores.get(text);
      if (!current || current.score < score) scores.set(text, { text, score, reason });
    };
    const after = this.bigrams.get(prev);
    if (after) {
      const total = [...after.values()].reduce((a, b) => a + b, 0);
      for (const [w, n] of after)
        add(
          w,
          2 + n / total,
          `You said "${w}" after "${prev === "<s>" ? "the start" : prev}" ${n} time${n === 1 ? "" : "s"}`,
        );
    }
    const totalUni = [...this.unigrams.values()].reduce((a, b) => a + b, 0) || 1;
    for (const [w, n] of this.unigrams)
      add(w, 1 + n / totalUni, `You've used "${w}" ${n} time${n === 1 ? "" : "s"}`);
    CORE_WORDS.forEach((c, i) => add(c.text.toLowerCase(), 0.5 - i / 1000, "A common word"));
    return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/** Whole phrases to offer: memory suggestions first (with their reasons), then history. */
export function predictPhrases(
  message: string,
  history: readonly string[],
  memory: readonly Suggestion[],
  limit = 4,
): Prediction[] {
  const prefix = message.trim().toLowerCase();
  const out = new Map<string, Prediction>();
  const add = (text: string, score: number, reason: string) => {
    const key = text.trim().toLowerCase();
    if (!key || key === prefix) return;
    if (prefix && !key.startsWith(prefix)) return;
    if (!out.has(key)) out.set(key, { text: text.trim(), score, reason });
  };
  for (const s of memory) add(s.label, 2 + s.score, s.reason);
  const counts = new Map<string, number>();
  for (const h of history) counts.set(h.trim(), (counts.get(h.trim()) ?? 0) + 1);
  for (const [text, n] of counts)
    add(text, 1 + Math.min(n, 20) / 20, `You've said this ${n} time${n === 1 ? "" : "s"}`);
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Append a predicted word to the message, replacing a partly typed last word. */
export function applyWord(message: string, word: string): string {
  if (message === "" || /\s$/.test(message)) return `${message}${word} `;
  return message.replace(/\S+$/, `${word} `);
}
