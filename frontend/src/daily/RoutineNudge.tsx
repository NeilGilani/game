/**
 * A gentle routine prompt on other screens ("Time to drink some water?"), with Done, put off, and Tell my carer.
 *
 * Nothing moves under the gaze: the prompt only appears when the screen changes, never in the middle of one. It
 * stays away from Lifeline, Talk, calibration and My day itself (which shows its own), and it never blocks
 * anything: ignoring it is fine.
 */
import { useEffect, useRef, useState } from "react";
import { readAloud } from "../papers/speak";
import { useRoute } from "../state/router";
import { dayKey, dueRoutines, routinePrompt } from "./day";
import { RoutineActions } from "./MyDay";
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

export function RoutineNudge() {
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

  // Decide what to show only when the screen changes.
  useEffect(() => {
    if (quiet || !state) {
      setShown(null);
      return;
    }
    const due = dueRoutines(state.routines, state.routine_state, new Date());
    setShown(due[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.path, quiet, state === null]);

  useEffect(() => {
    if (!shown || !state?.settings.speak_prompts || spoken.current.has(shown.id)) return;
    spoken.current.add(shown.id);
    readAloud(routinePrompt(shown));
  }, [shown, state?.settings.speak_prompts]);

  if (!shown || quiet) return null;
  return (
    <section className="panel day-nudge" aria-label="A gentle reminder" data-testid="day-nudge">
      <p className="day-nudge-text">{routinePrompt(shown)}</p>
      <RoutineActions
        routine={shown}
        compact
        onDone={() => {
          setShown(null);
          void dailySource()
            .state(dayKey(new Date()))
            .then(setState)
            .catch(() => undefined);
        }}
      />
    </section>
  );
}
