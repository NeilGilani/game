/**
 * A gentle routine prompt everywhere else: a dock button ("Drink some water?") and a line on Home's My day tile.
 *
 * Nothing moves under the gaze: the dock button only appears when the screen changes, never in the middle of one.
 * It stays away from Lifeline, Talk, calibration and My day itself (which shows its own), and it never blocks
 * anything: ignoring it is fine.
 */
import { useEffect, useRef, useState } from "react";
import { readAloud } from "../papers/speak";
import { navigate, useRoute } from "../state/router";
import { dayKey, dueRoutines, routinePrompt } from "./day";
import { Icon } from "../components/Icon";
import { dailySource } from "./source";
import type { DailyState, Routine } from "./types";

/** Screens the prompt never appears on. */
export const QUIET_SCREENS = new Set([
  "lifeline",
  "talk",
  "calibrate",
  "camera",
  "welcome",
  "day",
  "phones",
  "onboarding",
]);

const CHECK_MS = 60_000;

/** For Home's My day tile: the routine waiting for an answer ("Time to drink some water?"), or null. */
export function useDueNote(): string | null {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    dailySource()
      .state(dayKey(new Date()))
      .then((s) => {
        const due = dueRoutines(s.routines, s.routine_state, new Date());
        if (live) setNote(due[0] ? routinePrompt(due[0]) : null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return note;
}

/**
 * The dock button for a waiting routine ("Drink some water?"). It opens Routines, where Done and Later are one look
 * away. In the dock it never pushes a screen's choices around, and it only appears when the screen changes.
 */
export function RoutineDockButton() {
  const route = useRoute();
  const [state, setState] = useState<DailyState | null>(null);
  const [shown, setShown] = useState<Routine | null>(null);
  const spoken = useRef(new Set<string>());
  const quiet = QUIET_SCREENS.has(route.segments[0] ?? "");

  // Keep the data fresh in the background.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const s = await dailySource().state(dayKey(new Date()));
          if (!stopped) setState(s);
        } catch {
          /* the coordinator may be away: no prompt */
        }
      }
      if (!stopped) timer = setTimeout(tick, CHECK_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Decide what to show only when the screen changes, never in the middle of one. Fresh data each time, so a
  // routine just answered or put off doesn't come back.
  useEffect(() => {
    if (quiet) {
      setShown(null);
      return;
    }
    let live = true;
    dailySource()
      .state(dayKey(new Date()))
      .then((s) => {
        if (!live) return;
        setState(s);
        setShown(dueRoutines(s.routines, s.routine_state, new Date())[0] ?? null);
      })
      .catch(() => live && setShown(null));
    return () => {
      live = false;
    };
  }, [route.path, quiet]);

  useEffect(() => {
    if (!shown || !state?.settings.speak_prompts || spoken.current.has(shown.id)) return;
    spoken.current.add(shown.id);
    readAloud(routinePrompt(shown));
  }, [shown, state?.settings.speak_prompts]);

  if (!shown || quiet) return null;
  const label = shown.title.length > 22 ? `${shown.title.slice(0, 21)}…` : shown.title;
  return (
    <button
      className="btn dock-btn day-dock"
      onClick={() => navigate("/day/routines")}
      data-dwell
      data-testid="day-nudge"
      aria-label={`${routinePrompt(shown)} Open routines.`}
    >
      <Icon name="bell" size={30} />
      <span>{label}?</span>
    </button>
  );
}
