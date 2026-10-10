/**
 * The signing ceremony as a state machine, so its rules are tested independently of any
 * screen. The person must see every page, read the summary and what signing means, adopt a
 * signature, read the intent statement, then confirm twice: a long dwell, then a second
 * confirm placed somewhere else on the screen. Going back is always possible; nothing is
 * timed out.
 */

import type { SignatureStyle } from "./types";

export type CeremonyStage =
  "pages" | "summary" | "meaning" | "adopt" | "intent" | "confirm" | "reconfirm" | "approved";

export const CEREMONY_ORDER: CeremonyStage[] = [
  "pages",
  "summary",
  "meaning",
  "adopt",
  "intent",
  "confirm",
  "reconfirm",
  "approved",
];

export interface CeremonyState {
  stage: CeremonyStage;
  pageCount: number;
  pagesSeen: number[];
  style: SignatureStyle | null;
  /** Where the second confirm is shown: never where the first one was. */
  reconfirmSide: "left" | "right";
}

export type CeremonyEvent =
  | { type: "saw-page"; index: number }
  | { type: "next" }
  | { type: "back" }
  | { type: "adopt"; style: SignatureStyle }
  | { type: "confirmed" }
  | { type: "reconfirmed" };

export function startCeremony(
  pageCount: number,
  firstConfirmSide: "left" | "right" = "right",
): CeremonyState {
  return {
    stage: "pages",
    pageCount,
    pagesSeen: [],
    style: null,
    reconfirmSide: firstConfirmSide === "right" ? "left" : "right",
  };
}

export function allPagesSeen(s: CeremonyState): boolean {
  return s.pageCount > 0 && new Set(s.pagesSeen).size >= s.pageCount;
}

export function canAdvance(s: CeremonyState): boolean {
  switch (s.stage) {
    case "pages":
      return allPagesSeen(s);
    case "adopt":
      return s.style !== null;
    case "confirm":
    case "reconfirm":
    case "approved":
      return false; // only the dedicated confirm events move on from here
    default:
      return true;
  }
}

function move(s: CeremonyState, delta: 1 | -1): CeremonyState {
  const i = CEREMONY_ORDER.indexOf(s.stage);
  const next = CEREMONY_ORDER[Math.max(0, Math.min(CEREMONY_ORDER.length - 1, i + delta))]!;
  return { ...s, stage: next };
}

export function ceremonyReducer(s: CeremonyState, e: CeremonyEvent): CeremonyState {
  if (s.stage === "approved") return s;
  switch (e.type) {
    case "saw-page":
      if (e.index < 0 || e.index >= s.pageCount || s.pagesSeen.includes(e.index)) return s;
      return { ...s, pagesSeen: [...s.pagesSeen, e.index] };
    case "next":
      return canAdvance(s) ? move(s, 1) : s;
    case "back":
      // From either confirm step, back returns to the intent statement: both confirms restart.
      if (s.stage === "confirm" || s.stage === "reconfirm") return { ...s, stage: "intent" };
      return move(s, -1);
    case "adopt":
      return s.stage === "adopt" ? { ...s, style: e.style } : s;
    case "confirmed":
      return s.stage === "confirm" ? { ...s, stage: "reconfirm" } : s;
    case "reconfirmed":
      return s.stage === "reconfirm" ? { ...s, stage: "approved" } : s;
  }
}

/** Dwell multiplier for the first confirm: deliberately long (3x the person's dwell time). */
export const LONG_DWELL_SCALE = 3;
