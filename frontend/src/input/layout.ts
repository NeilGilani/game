/**
 * Adaptive layout from how precise eye control is right now (os/gaze/src/input/intent.ts PrecisionMeter):
 *
 * - rough (large error radius): likely targets grow and everything is spaced further apart; adventure
 *   flows show at most 4 choices per page.
 * - normal: as designed (6 per page).
 * - sharp (small error radius): denser screens are allowed (8 per page, tighter gaps).
 *
 * The meter updates the live level every frame, but the layout only follows it when the screen changes
 * (navigation, a new set of choices). Nothing moves or grows while the person is looking at it.
 * The level is shown on <html data-gaze-precision> for the CSS (styles/app.css, "Adaptive layout").
 */

import { useEffect, useState } from "react";
import type { PrecisionLevel } from "../../../os/gaze/src/input/intent";
import { SELECTION_RESET_EVENT } from "../components/common";

let live: PrecisionLevel = "normal";
let applied: PrecisionLevel = "normal";
let enabled = true;
const listeners = new Set<(level: PrecisionLevel) => void>();

/** Choices per page for each level (adventure flows). */
export const PAGE_SIZE: Record<PrecisionLevel, number> = { rough: 4, normal: 6, sharp: 8 };

/** From the input layer, every frame: the level the meter reports now. */
export function setLivePrecision(level: PrecisionLevel): void {
  live = level;
}

export function livePrecision(): PrecisionLevel {
  return live;
}

/** The level a screen that is appearing now should be laid out for. */
export function precisionForNewScreen(): PrecisionLevel {
  return enabled ? live : "normal";
}

/** The level the current screen is laid out for. */
export function appliedPrecision(): PrecisionLevel {
  return enabled ? applied : "normal";
}

/** Switch adaptive layout on or off (eye control off: always "normal"). */
export function setAdaptiveLayout(on: boolean): void {
  enabled = on;
  applyNow();
}

/** Lay the next screen out for the live level. Called when the screen changes. */
export function applyNow(): void {
  const next = enabled ? live : "normal";
  if (next !== applied || document.documentElement.dataset.gazePrecision !== next) {
    applied = next;
    document.documentElement.dataset.gazePrecision = next;
    for (const l of listeners) l(next);
  }
}

// The screen changes on navigation and when new choices appear (flows send SELECTION_RESET_EVENT).
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", applyNow);
  window.addEventListener(SELECTION_RESET_EVENT, applyNow);
}

/** The applied level, for components that lay themselves out by it. */
export function usePrecision(): PrecisionLevel {
  const [level, setLevel] = useState(appliedPrecision);
  useEffect(() => {
    listeners.add(setLevel);
    setLevel(appliedPrecision());
    return () => {
      listeners.delete(setLevel);
    };
  }, []);
  return level;
}
