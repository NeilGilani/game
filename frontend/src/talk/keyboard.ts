/**
 * Keyboard layouts for eye typing.
 *
 * Webcam gaze is accurate to a few degrees, about the size of a normal key, so two layouts:
 *
 * - "groups": six big keys of letters; choose a group, then a letter from it. Two choices
 *   per letter, but every target is large, which suits weak calibration and scanning.
 * - "letters": every letter on screen at once; one choice per letter for good calibration.
 *
 * Letters are ordered by frequency in English within each group, so common letters sit in
 * the first slots where scanning reaches them soonest.
 */

export type Layout = "groups" | "letters";

export const GROUPS: readonly string[][] = [
  ["e", "a", "o", "i", "u", "y"],
  ["t", "n", "s", "h", "r", "d"],
  ["l", "c", "m", "w", "f", "g"],
  ["p", "b", "v", "k", "j", "x"],
  ["q", "z", "'", ",", ".", "?"],
];

/** Alphabetical, for the all-letters layout (easier to find by eye). */
export const LETTERS: readonly string[] = [..."abcdefghijklmnopqrstuvwxyz", "'", ",", ".", "?"];

export function groupLabel(group: readonly string[]): string {
  return group.join(" ").toUpperCase();
}

/**
 * Apply a typed character: letters are capitalised at the start of a sentence,
 * punctuation removes a preceding space and adds one after (except the apostrophe).
 */
export function typeChar(text: string, ch: string): string {
  if (/^[a-z]$/.test(ch)) {
    const before = text.trimEnd();
    const startOfSentence = before === "" || /[.!?]$/.test(before);
    const loneI = ch === "i" && (text === "" || /\s$/.test(text));
    return text + (startOfSentence || loneI ? ch.toUpperCase() : ch);
  }
  if (ch === "'") return text + ch;
  return text.replace(/\s+$/, "") + ch + " ";
}

/** Delete one character; a trailing "word " counts the space and the character before it. */
export function backspace(text: string): string {
  if (text.endsWith(" ") && text.length > 1) return text.slice(0, -2);
  return text.slice(0, -1);
}

/** Delete the last word (and the space after it). */
export function deleteWord(text: string): string {
  return text.replace(/\s*[^\s]+\s*$/, (m) => (m.startsWith(" ") ? " " : "")).replace(/^\s+$/, "");
}
