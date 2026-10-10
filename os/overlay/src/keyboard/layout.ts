/**
 * On-screen keyboard layout. Keys are at least 96 pt with 24 pt gaps, so a full QWERTY row needs about
 * 1180 pt; on narrower displays the keyboard falls back to an alphabetical layout with fewer columns
 * (common on AAC devices) rather than shrinking keys.
 */

import type { ScreenRect } from "../contracts";
import { GAP, MIN_TARGET } from "../core/layout";

export type KeyAction =
  | { kind: "char"; char: string }
  | { kind: "space" }
  | { kind: "delete" }
  | { kind: "return" }
  | { kind: "shift" }
  | { kind: "page"; page: KeyboardPage }
  | { kind: "predict"; slot: number }
  | { kind: "hide" };

export type KeyboardPage = "letters" | "symbols";

export interface KeySpec {
  id: string;
  label: string;
  /** Spoken / screen-reader name. */
  name: string;
  action: KeyAction;
  /** Width in columns. */
  span: number;
  /** Longer dwell for keys with bigger consequences (Return may send a message). */
  dwellScale?: number;
}

export interface PlacedKey extends KeySpec {
  rect: ScreenRect;
}

const char = (c: string): KeySpec => ({
  id: `key:${c}`,
  label: c,
  name: c === "'" ? "apostrophe" : c === "," ? "comma" : c === "." ? "full stop" : c,
  action: { kind: "char", char: c },
  span: 1,
});

function bottomRow(page: KeyboardPage, columns: number): KeySpec[] {
  const toggle: KeySpec =
    page === "letters"
      ? {
          id: "key:page-symbols",
          label: "123",
          name: "Numbers and symbols",
          action: { kind: "page", page: "symbols" },
          span: 1,
        }
      : {
          id: "key:page-letters",
          label: "ABC",
          name: "Letters",
          action: { kind: "page", page: "letters" },
          span: 1,
        };
  const fixed = 1 + 2 + 2 + 1; // toggle, delete, return, hide
  return [
    toggle,
    {
      id: "key:space",
      label: "space",
      name: "Space",
      action: { kind: "space" },
      span: Math.max(1, columns - fixed),
    },
    { id: "key:delete", label: "⌫ delete", name: "Delete", action: { kind: "delete" }, span: 2 },
    {
      id: "key:return",
      label: "return",
      name: "Return",
      action: { kind: "return" },
      span: 2,
      dwellScale: 1.5,
    },
    { id: "key:hide", label: "hide", name: "Hide keyboard", action: { kind: "hide" }, span: 1 },
  ];
}

const QWERTY = ["qwertyuiop", "asdfghjkl'", "zxcvbnm,."];
const SYMBOLS = ["1234567890", '-/:;()$&@"', "?!_*+=#%."];
const ABC = "abcdefghijklmnopqrstuvwxyz',.";

export function keyRows(page: KeyboardPage, columns: number): KeySpec[][] {
  const shift: KeySpec = {
    id: "key:shift",
    label: "⇧ shift",
    name: "Shift",
    action: { kind: "shift" },
    span: 1,
  };
  let rows: KeySpec[][];
  if (columns >= 10) {
    const src = page === "letters" ? QWERTY : SYMBOLS;
    rows = src.map((r) => [...r].map(char));
    if (page === "letters") rows[2] = [shift, ...(rows[2] ?? [])];
    else rows[2] = [...(rows[2] ?? []), char(",")];
  } else {
    const keys = [...(page === "letters" ? ABC : SYMBOLS.join(""))].map(char);
    if (page === "letters") keys.push(shift);
    rows = [];
    for (let i = 0; i < keys.length; i += columns) rows.push(keys.slice(i, i + columns));
  }
  return [...rows, bottomRow(page, Math.max(columns, 7))];
}

export interface KeyboardLayout {
  columns: number;
  keySize: number;
  size: { width: number; height: number };
  /** Keys positioned relative to (0,0); `placeKeyboard` moves them into the panel. */
  keys: PlacedKey[];
}

export const PREDICTION_SLOTS = 4;

/** Lay out the keyboard to fit `maxWidth`, with a prediction row on top. */
export function layoutKeyboard(page: KeyboardPage, maxWidth: number, keySize = 104): KeyboardLayout {
  // Prefer a full QWERTY row: use the biggest key size (down to the 96 pt minimum) that fits ten columns.
  const fitsTen = Math.floor((maxWidth - 9 * GAP) / 10);
  const size = Math.max(MIN_TARGET, Math.min(keySize, fitsTen));
  const columns = Math.max(7, Math.min(10, Math.floor((maxWidth + GAP) / (size + GAP))));
  const rows = keyRows(page, columns);
  const cols = Math.max(columns, 7);
  const keys: PlacedKey[] = [];
  const predW = (cols * size + (cols - 1) * GAP - (PREDICTION_SLOTS - 1) * GAP) / PREDICTION_SLOTS;
  for (let i = 0; i < PREDICTION_SLOTS; i++) {
    keys.push({
      id: `key:predict-${i}`,
      label: "",
      name: "Prediction",
      action: { kind: "predict", slot: i },
      span: 0,
      rect: { x: i * (predW + GAP), y: 0, width: predW, height: size },
    });
  }
  rows.forEach((row, r) => {
    let col = 0;
    for (const k of row) {
      const width = k.span * size + (k.span - 1) * GAP;
      keys.push({ ...k, rect: { x: col * (size + GAP), y: (r + 1) * (size + GAP), width, height: size } });
      col += k.span;
    }
  });
  const width = cols * size + (cols - 1) * GAP;
  const height = (rows.length + 1) * size + rows.length * GAP;
  return { columns: cols, keySize: size, size: { width, height }, keys };
}

export function placeKeyboard(layout: KeyboardLayout, origin: { x: number; y: number }): PlacedKey[] {
  return layout.keys.map((k) => ({
    ...k,
    rect: { ...k.rect, x: k.rect.x + origin.x, y: k.rect.y + origin.y },
  }));
}
