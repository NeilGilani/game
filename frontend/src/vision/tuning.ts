/**
 * Eye-control tuning chosen in the Gaze lab (Settings › Gaze lab), kept on this device only: it is
 * measured from this person's eyes and this camera, so it doesn't travel with the preferences the
 * coordinator stores. Lock settings that already are preferences (snap distance, dwell steadiness)
 * are saved as preferences instead.
 */

import { useEffect, useState } from "react";
import type { FilterSettings } from "../../../os/gaze/src/lab";

export interface GazeTuning {
  /** Fixation filter settings picked by replaying the person's own 9-dot recording; null = defaults. */
  filter: FilterSettings | null;
  /** How much screen context counts when choosing a target, 0 (eyes only) to 1. */
  contextStrength: number;
  /** Pre-highlight a likely target the eyes are moving to, with a slightly shorter dwell. */
  prediction: boolean;
  /** Bigger, more spaced targets when tracking is rough; denser screens when it's sharp. */
  adaptiveLayout: boolean;
}

export const DEFAULT_TUNING: GazeTuning = {
  filter: null,
  contextStrength: 1,
  prediction: true,
  adaptiveLayout: true,
};

const KEY = "agency.gazeTuning";
const listeners = new Set<(t: GazeTuning) => void>();
let current: GazeTuning = load();

function load(): GazeTuning {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<GazeTuning>;
      return {
        filter: p.filter && typeof p.filter.z === "number" ? p.filter : null,
        contextStrength:
          typeof p.contextStrength === "number"
            ? Math.max(0, Math.min(1, p.contextStrength))
            : DEFAULT_TUNING.contextStrength,
        prediction: typeof p.prediction === "boolean" ? p.prediction : DEFAULT_TUNING.prediction,
        adaptiveLayout:
          typeof p.adaptiveLayout === "boolean" ? p.adaptiveLayout : DEFAULT_TUNING.adaptiveLayout,
      };
    }
  } catch {
    /* unavailable or corrupt: defaults */
  }
  return DEFAULT_TUNING;
}

export function gazeTuning(): GazeTuning {
  return current;
}

export function setGazeTuning(patch: Partial<GazeTuning>): GazeTuning {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* keep in memory only */
  }
  for (const l of listeners) l(current);
  return current;
}

/** Called whenever the tuning changes. Returns an unsubscribe function. */
export function onGazeTuning(listener: (t: GazeTuning) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useGazeTuning(): GazeTuning {
  const [t, setT] = useState(current);
  useEffect(() => {
    listeners.add(setT);
    setT(current);
    return () => {
      listeners.delete(setT);
    };
  }, []);
  return t;
}
