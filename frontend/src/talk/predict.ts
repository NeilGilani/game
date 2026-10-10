/**
 * Word prediction for eye typing.
 *
 * Every letter costs someone typing with their eyes several seconds, so good suggestions
 * are the biggest speed-up available. The predictor ranks words that complete the current
 * prefix by three signals:
 *
 * - base rank in a built-in vocabulary (common words first),
 * - how often the person has used the word themselves,
 * - how often it has followed the previous word in what they've said (bigrams).
 *
 * Personal counts dominate quickly, so after a few days the suggestions are theirs.
 * State is a small JSON object, kept on this device only.
 */
import { BASE_PAIRS, BASE_WORDS } from "./vocabulary";

export interface PredictorState {
  version: 1;
  /** word -> times the person used it */
  unigrams: Record<string, number>;
  /** "previous next" -> times seen */
  bigrams: Record<string, number>;
}

export const EMPTY_STATE: PredictorState = { version: 1, unigrams: {}, bigrams: {} };

/** Caps keep stored state small no matter how long someone uses AGENCY. */
const MAX_UNIGRAMS = 3000;
const MAX_BIGRAMS = 6000;

const BASE_RANK = new Map(BASE_WORDS.map((w, i) => [w, i]));

/** Lower-case words with apostrophes kept ("don't"), everything else dropped. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []).filter((w) => w.length <= 30);
}

/** Splits typed text into the words before the cursor and the word being typed. */
export function splitDraft(text: string): { previous: string | null; prefix: string } {
  const endsWithSpace = /[\s.,!?]$/.test(text) || text.length === 0;
  const words = tokenize(text);
  if (endsWithSpace) return { previous: words.at(-1) ?? null, prefix: "" };
  const prefix = words.at(-1) ?? "";
  return { previous: words.at(-2) ?? null, prefix };
}

function prune(record: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(record);
  if (entries.length <= max) return record;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, max));
}

export class Predictor {
  private state: PredictorState;

  constructor(state: PredictorState = EMPTY_STATE) {
    this.state = {
      version: 1,
      unigrams: { ...(state?.unigrams ?? {}) },
      bigrams: { ...(state?.bigrams ?? {}) },
    };
  }

  snapshot(): PredictorState {
    return { version: 1, unigrams: { ...this.state.unigrams }, bigrams: { ...this.state.bigrams } };
  }

  /** Learn from something the person actually said. */
  learn(text: string): void {
    const words = tokenize(text);
    words.forEach((w, i) => {
      this.state.unigrams[w] = (this.state.unigrams[w] ?? 0) + 1;
      if (i > 0) {
        const key = `${words[i - 1]} ${w}`;
        this.state.bigrams[key] = (this.state.bigrams[key] ?? 0) + 1;
      }
    });
    this.state.unigrams = prune(this.state.unigrams, MAX_UNIGRAMS);
    this.state.bigrams = prune(this.state.bigrams, MAX_BIGRAMS);
  }

  /** Forget a single word (and pairs that include it), e.g. a typo that keeps appearing. */
  forget(word: string): void {
    const w = word.toLowerCase();
    delete this.state.unigrams[w];
    for (const key of Object.keys(this.state.bigrams)) {
      const [a, b] = key.split(" ");
      if (a === w || b === w) delete this.state.bigrams[key];
    }
  }

  private score(word: string, previous: string | null): number {
    const rank = BASE_RANK.get(word);
    // Base: 0..1, common words higher.
    const base = rank === undefined ? 0 : 1 - rank / (BASE_WORDS.length + 1);
    const own = this.state.unigrams[word] ?? 0;
    const pair = previous ? (this.state.bigrams[`${previous} ${word}`] ?? 0) : 0;
    // Built-in pairs: worth about two personal uses, earlier in the list a little more.
    const listed = BASE_PAIRS[previous ?? ""];
    const at = listed ? listed.indexOf(word) : -1;
    const builtIn = at < 0 ? 0 : 2 - at / listed!.length;
    // log keeps one very frequent word from crowding out everything else.
    return base + builtIn + 1.5 * Math.log1p(own) + 3 * Math.log1p(pair);
  }

  /**
   * Up to `n` words that complete `prefix`, best first. With an empty prefix it suggests
   * likely next words (from the person's own pairs, then common words).
   */
  suggest(prefix: string, previous: string | null, n = 4): string[] {
    const p = prefix.toLowerCase();
    const prev = previous?.toLowerCase() ?? null;
    const candidates = new Set<string>();
    for (const w of BASE_WORDS) if (w.startsWith(p) && w !== p) candidates.add(w);
    for (const w of Object.keys(this.state.unigrams)) if (w.startsWith(p) && w !== p) candidates.add(w);
    return [...candidates]
      .map((w) => ({ w, s: this.score(w, prev) }))
      .sort((a, b) => b.s - a.s || a.w.localeCompare(b.w))
      .slice(0, n)
      .map((x) => x.w);
  }
}

/**
 * Replace the word being typed with `word` and add a space, keeping capitalisation
 * of a sentence start ("i" is always "I").
 */
export function applySuggestion(text: string, word: string): string {
  const { prefix } = splitDraft(text);
  const head = prefix ? text.slice(0, text.length - prefix.length) : text;
  const before = head.trimEnd();
  const sentenceStart = before === "" || /[.!?]$/.test(before);
  let out = word === "i" || word.startsWith("i'") ? "I" + word.slice(1) : word;
  if (sentenceStart) out = out.charAt(0).toUpperCase() + out.slice(1);
  const spacer = head === "" || /\s$/.test(head) ? "" : " ";
  return `${head}${spacer}${out} `;
}
