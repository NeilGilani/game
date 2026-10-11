/**
 * Keeps eye control working while the person moves about, tires, or the tracking drifts, using the
 * engine's advice (os/gaze/src/engine.ts EngineAdvice):
 *
 * - Posture: when the person has moved far from where they sat for the eye scan, one short line in
 *   plain words ("Lean back a little."), spoken once, gone when they're back.
 * - Touch-up: when choices keep landing off the same way, a dot in the middle for 2 seconds ("Look
 *   at the dot") instead of a full rescan. Selection pauses while it shows.
 * - Pace: when choosing takes more effort, targets grow a little (InputLayer lengthens the dwell),
 *   and the person is told why.
 * - Undo: a Back, Cancel or Undo chosen soon after another choice tells the engine that choice was
 *   a mistake (so it isn't learned from, and pace counts it).
 *
 * Nothing here takes the eyes anywhere they didn't choose to go: banners float and can't be
 * selected; the touch-up dot sits where the eyes already spend most time.
 */

import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { SELECTION_RESET_EVENT } from "../components/common";
import { useAnnounce } from "../state/announcer";
import { useInput } from "../state/input";
import { usePreferences } from "../state/preferences";
import { useRoute } from "../state/router";

const UNDO_LABEL = /^(back|cancel|undo|go back|not this)\b/i;
const PACE_MESSAGE_MS = 8000;

/** Scale for dwell targets as pace asks (1 = the person's own settings). */
export const PACE_TARGET_VAR = "--pace-target-scale";
/**
 * Bigger targets, hit areas included (InputLayer measures the scaled boxes). Only while pace asks
 * for it, so nothing changes for anyone else; "Resume eye control" style targets keep their size.
 */
const PACE_STYLE = `[data-dwell]:not([data-dwell-always]) { scale: var(${PACE_TARGET_VAR}, 1); transition: scale 400ms ease; }
@media (prefers-reduced-motion: reduce) { [data-dwell] { transition: none; } }`;

export function GazeAssist() {
  const input = useInput();
  const { prefs } = usePreferences();
  const announce = useAnnounce();
  const route = useRoute();
  const { vision, mode, calibration, suspended, setSuspended } = input;
  const [posture, setPosture] = useState<string | null>(null);
  const [paceNote, setPaceNote] = useState<string | null>(null);
  const [dot, setDot] = useState<{ x: number; y: number } | null>(null);
  const [targetScale, setTargetScale] = useState(1);
  const busy = useRef(false);
  const blocked = useRef(true);
  blocked.current =
    mode !== "gaze" ||
    !calibration ||
    suspended ||
    /^(calibrate|camera|welcome)/.test(route.segments[0] ?? "");

  // Engine advice.
  useEffect(() => {
    let paceTimer: ReturnType<typeof setTimeout> | undefined;
    const off = vision.onAdvice((a) => {
      if (a.type === "posture") {
        setPosture(a.message);
        if (a.message) announce(a.message);
      } else if (a.type === "pace") {
        document.documentElement.style.setProperty(PACE_TARGET_VAR, String(a.targetScale));
        setTargetScale(a.targetScale);
        setPaceNote(a.message);
        announce(a.message);
        clearTimeout(paceTimer);
        paceTimer = setTimeout(() => setPaceNote(null), PACE_MESSAGE_MS);
      } else if (a.type === "touch-up" && !busy.current && !blocked.current) {
        busy.current = true;
        setSuspended(true);
        announce("Look at the dot for a moment.", true);
        const run = vision.startTouchUp();
        setDot({ x: run.x, y: run.y });
        void run.done.then((result) => {
          busy.current = false;
          setDot(null);
          setSuspended(false);
          // The eyes were on the dot: don't select whatever sits under it the moment it goes.
          window.dispatchEvent(new CustomEvent(SELECTION_RESET_EVENT, { detail: { holdMs: 1500 } }));
          announce(result.kind === "done" ? "Thanks. Eye control is back on target." : result.reason);
        });
      }
    });
    return () => {
      off();
      clearTimeout(paceTimer);
    };
  }, [vision, announce, setSuspended]);

  // Leaving gaze mode (or the app) mid touch-up: stop it and give selection back.
  useEffect(
    () => () => {
      if (busy.current) {
        vision.cancelTouchUp();
        setSuspended(false);
      }
    },
    [vision, setSuspended],
  );

  // The person changed their dwell settings: pace measures afresh.
  useEffect(() => vision.rebasePace(), [vision, prefs.dwell_ms, prefs.target_snap_px]);

  // Undo: Back, Cancel or Undo soon after another choice.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-dwell]") : null;
      if (!el) return;
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
      if (el.hasAttribute("data-dwell-undo") || UNDO_LABEL.test(label)) {
        vision.undoPrevious(vision.last?.t ?? performance.now());
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [vision]);

  const showPosture = posture && mode === "gaze" && !dot;
  return (
    <>
      {targetScale > 1 && <style>{PACE_STYLE}</style>}
      {showPosture && (
        <div className="banner banner-warn banner-float" role="status" data-testid="posture">
          <Icon name="head" />
          <span>{posture}</span>
        </div>
      )}
      {paceNote && !showPosture && !dot && (
        <div className="banner banner-ok banner-float" role="status" data-testid="pace">
          <Icon name="clock" />
          <span>{paceNote}</span>
        </div>
      )}
      {dot && (
        <div
          role="dialog"
          aria-label="Look at the dot"
          data-testid="touch-up"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 950,
            background: "var(--surface)",
            pointerEvents: "none",
          }}
        >
          <p
            style={{
              position: "absolute",
              top: "18%",
              width: "100%",
              textAlign: "center",
              fontSize: "calc(28px * var(--text-scale, 1))",
              color: "var(--ink)",
              margin: 0,
            }}
          >
            Look at the dot
          </p>
          <div
            style={{
              position: "absolute",
              left: dot.x - 14,
              top: dot.y - 14,
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "var(--accent)",
              boxShadow: "0 0 0 10px color-mix(in srgb, var(--accent) 25%, transparent)",
            }}
          />
        </div>
      )}
    </>
  );
}
