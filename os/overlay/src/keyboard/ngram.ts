/**
 * A small local word predictor: unigram + bigram counts with prefix completion.
 *
 * It learns only from text the person typed with the on-screen keyboard into ordinary fields, keeps
 * everything in memory, and never sees anything typed into a password field (the keyboard refuses to
 * type there at all). Phrases from the memory tree (Instance 6) are merged in by the keyboard.
 */

/** Common English words so predictions are useful from the first keystroke. Rank = order. */
const SEED = (
  "i the you to a and it is that of in my me what for not this on be have do with can we are no yes " +
  "please thank thanks help need want like water hurts hurt pain cold hot tired sleep bed now later " +
  "good bad okay ok sorry love time today tomorrow call home here there how when where why who " +
  "will would could should just know think feel going go come see look get make take tell say " +
  "hello hi bye morning night food drink more less again stop wait move turn up down left right " +
  "your our they them he she him her it's i'm don't can't that's what's mom dad family doctor nurse"
)
  .split(" ")
  .filter(Boolean);

export interface Prediction {
  word: string;
  score: number;
}

export class NgramModel {
  private unigrams = new Map<string, number>();
  private bigrams = new Map<string, Map<string, number>>();

  constructor(seed: readonly string[] = SEED) {
    seed.forEach((w, i) => this.unigrams.set(w, Math.max(1, Math.round((seed.length - i) / 10))));
  }

  /** Learn from finished text. Callers must never pass text from a secure field. */
  learn(text: string): void {
    const words = tokenize(text);
    let prev: string | null = null;
    for (const w of words) {
      this.unigrams.set(w, (this.unigrams.get(w) ?? 0) + 3);
      if (prev) {
        const row = this.bigrams.get(prev) ?? new Map<string, number>();
        row.set(w, (row.get(w) ?? 0) + 1);
        this.bigrams.set(prev, row);
      }
      prev = w;
    }
  }

  /** Words starting with `prefix` (may be empty), ranked by bigram then unigram evidence. */
  predict(previous: string | null, prefix: string, limit = 4): Prediction[] {
    const p = prefix.toLowerCase();
    const prev = previous?.toLowerCase() ?? null;
    const row = prev ? this.bigrams.get(prev) : undefined;
    const scores = new Map<string, number>();
    for (const [w, n] of this.unigrams) {
      if (w.startsWith(p) && w !== p) scores.set(w, n);
    }
    if (row) {
      for (const [w, n] of row) {
        if (w.startsWith(p) && w !== p) scores.set(w, (scores.get(w) ?? 0) + n * 20);
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([word, score]) => ({ word, score }));
  }

  /** Plain JSON for the host to keep, if the person allows it. */
  export(): { unigrams: [string, number][]; bigrams: [string, [string, number][]][] } {
    return {
      unigrams: [...this.unigrams.entries()],
      bigrams: [...this.bigrams.entries()].map(([k, v]) => [k, [...v.entries()]]),
    };
  }
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 0);
}

/** The word being typed (after the last separator) and the word before it. */
export function currentWord(text: string): { previous: string | null; prefix: string } {
  const m = /([\p{L}\p{N}']*)$/u.exec(text);
  const prefix = m?.[1] ?? "";
  const before = tokenize(text.slice(0, text.length - prefix.length));
  return { previous: before[before.length - 1] ?? null, prefix };
}
