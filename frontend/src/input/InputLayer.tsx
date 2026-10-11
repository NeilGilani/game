/**
 * Connects the camera pipeline (or a key switch) to the interface.
 *
 * Every interactive control that should work hands-free carries `data-dwell`. Selections
 * from any input method end in a normal `click()`, so the application logic is identical
 * whether a person uses gaze, a head pointer, a blink switch, a key, or a mouse.
 *
 * With gaze or the head pointer, selection is locked in: GazeSelector picks the most likely target
 * for the pointer and the engine's error radius, holds it with hysteresis, and the cursor sits in
 * the middle of the held target (marked data-dwell-locked) instead of wobbling. A glance away or a
 * blink pauses the dwell ring (data-dwell-paused) rather than resetting it.
 *
 * Each target carries a context prior (input/context.ts, os/gaze/src/input/intent.ts priorsOf): what is
 * likely on this screen weighs the magnet's evidence when the tracker can't tell neighbours apart.
 * Approval gates never get more than neutral; Stop, Help and Lifeline never less than the top. The
 * precision meter drives the adaptive layout (input/layout.ts).
 */

import { useEffect, useRef, useState } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { useAnnounce } from "../state/announcer";
import { MODE_LABELS, useInput } from "../state/input";
import { usePreferences } from "../state/preferences";
import { navigate } from "../state/router";
import { BlinkSwitch } from "../vision/blink";
import type { VisionFrame } from "../vision/tracker";
import {
  APP_SELECTOR,
  GazeSelector,
  type SelectorEvent,
  type SelectorTarget,
} from "../../../os/gaze/src/input/selector";
import { DEFAULT_INTENT, PrecisionMeter, priorsOf } from "../../../os/gaze/src/input/intent";
import { useGazeTuning } from "../vision/tuning";
import { formNextElements, readContext } from "./context";
import { setAdaptiveLayout, setLivePrecision } from "./layout";
import { ScanEngine, type ScanEvent } from "./scan";

const AUTO_CALIBRATE_KEY = "agency.autoCalibrated";

const ids = new WeakMap<Element, string>();
let nextId = 1;
function idFor(el: Element): string {
  let id = ids.get(el);
  if (!id) {
    id = `t${nextId++}`;
    ids.set(el, id);
  }
  return id;
}

function labelOf(el: HTMLElement): string {
  return (el.getAttribute("aria-label") || el.textContent || "item").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Visible, enabled dwell targets, limited to an open dialog if there is one. */
function collectTargets(
  onlyAlways: boolean,
  contextStrength: number,
): { list: SelectorTarget[]; byId: Map<string, HTMLElement> } {
  const scope = document.querySelector<HTMLElement>('[data-dwell-scope="modal"]') ?? document.body;
  const nodes = scope.querySelectorAll<HTMLElement>("[data-dwell]");
  const list: SelectorTarget[] = [];
  const contexts: ReturnType<typeof readContext>[] = [];
  const formNext = formNextElements(scope);
  const byId = new Map<string, HTMLElement>();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  nodes.forEach((el) => {
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return;
    if (onlyAlways && !el.hasAttribute("data-dwell-always")) return;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return;
    if (el.closest("[inert]")) return;
    const id = idFor(el);
    byId.set(id, el);
    contexts.push(readContext(el, formNext));
    list.push({
      id,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      dwellScale: el.hasAttribute("data-dwell-always") ? 2 : Number(el.dataset.dwellScale ?? 1),
    });
  });
  const priors = priorsOf(
    list.map((t, i) => ({ ...t, ...contexts[i]! })),
    { ...DEFAULT_INTENT, strength: contextStrength },
  );
  list.forEach((t, i) => (t.prior = priors[i]));
  return { list, byId };
}

/** Remove a marker attribute everywhere; the dwell ring's fill goes too unless keepRing. */
function clearMarks(attr: string, keepRing = false): void {
  document.querySelectorAll(`[${attr}]`).forEach((el) => {
    el.removeAttribute(attr);
    if (!keepRing) (el as HTMLElement).style.removeProperty("--dwell");
  });
}

function clearDwellMarks(): void {
  clearMarks("data-dwell-active");
  clearMarks("data-dwell-locked", true);
  clearMarks("data-dwell-paused", true);
}

function flash(el: HTMLElement): void {
  el.setAttribute("data-selected-flash", "");
  window.setTimeout(() => el.removeAttribute("data-selected-flash"), 450);
}

/** How far outside a control the eye cursor can still choose it (px). */
const EYE_CURSOR_SNAP_PX = 6;

export function InputLayer() {
  const input = useInput();
  const { prefs } = usePreferences();
  const announce = useAnnounce();
  const cursorRef = useRef<HTMLDivElement>(null);
  /** What the camera frames last said about the cursor; drawn on every animation frame. */
  const shown = useRef<{ on: boolean; lockAt: { x: number; y: number } | null }>({ on: false, lockAt: null });
  const [blinkProgress, setBlinkProgress] = useState(0);
  const [scanPaused, setScanPaused] = useState(false);

  const tuning = useGazeTuning();
  const meter = useRef(new PrecisionMeter());
  const selector = useRef(new GazeSelector(APP_SELECTOR));
  const scan = useRef(new ScanEngine());
  const blink = useRef(new BlinkSwitch());
  const targets = useRef<{ list: SelectorTarget[]; byId: Map<string, HTMLElement>; at: number }>({
    list: [],
    byId: new Map(),
    at: 0,
  });
  const lowSince = useRef<number | null>(null);
  const goodSince = useRef<number | null>(null);

  const {
    mode,
    vision,
    eyeControlPaused,
    suspended,
    fallbackActive,
    setFallbackActive,
    setTracking,
    calibration,
  } = input;
  const pointerMode = mode === "gaze" || mode === "head";

  // Adaptive layout only while a pointer drives selection, and only if the person wants it.
  useEffect(() => {
    setAdaptiveLayout(tuning.adaptiveLayout && pointerMode);
    if (!pointerMode) meter.current.reset();
  }, [tuning.adaptiveLayout, pointerMode]);
  const scanning = mode === "scan_key" || mode === "scan_blink" || fallbackActive;

  useEffect(() => {
    selector.current.setOptions({
      // Pace (os/gaze/src/input/pace.ts) lengthens the dwell a little when choosing gets harder.
      dwell: { dwellMs: prefs.dwell_ms * vision.pace.dwellScale, stabilityPx: prefs.dwell_stability_px },
      // The eye cursor is exactly where it is drawn: only what is under it can be chosen (a few px of
      // slack). Gaze, with its error circle, keeps the person's snap distance.
      magnet: { snapPx: mode === "head" ? EYE_CURSOR_SNAP_PX : prefs.target_snap_px },
    });
    scan.current.setConfig({ intervalMs: prefs.scan_interval_ms });
    blink.current.setOptions({ holdMs: prefs.blink_ms });
  }, [
    vision,
    prefs.dwell_ms,
    prefs.dwell_stability_px,
    prefs.target_snap_px,
    prefs.scan_interval_ms,
    mode,
    prefs.blink_ms,
  ]);

  // Pace changes during a session: apply the new dwell time at once (GazeAssist shows the message).
  useEffect(
    () =>
      vision.onAdvice((a) => {
        if (a.type === "pace")
          selector.current.setOptions({ dwell: { dwellMs: prefs.dwell_ms * a.dwellScale } });
      }),
    [vision, prefs.dwell_ms],
  );

  // Navigation: forget any half-finished dwell and pause selection briefly, so a control that
  // appears under the person's gaze is not selected by accident.
  useEffect(() => {
    const onNav = (e: Event) => {
      // A screen can ask for a longer pause (the eye scan ends with the eyes on whatever is in the middle).
      const hold = e instanceof CustomEvent && typeof e.detail?.holdMs === "number" ? e.detail.holdMs : 1200;
      selector.current.reset(performance.now(), Math.max(1200, hold));
      clearDwellMarks();
      targets.current.at = 0;
    };
    window.addEventListener("hashchange", onNav);
    window.addEventListener(SELECTION_RESET_EVENT, onNav);
    return () => {
      window.removeEventListener("hashchange", onNav);
      window.removeEventListener(SELECTION_RESET_EVENT, onNav);
    };
  }, []);

  const refreshTargets = (now: number, onlyAlways = false) => {
    if (now - targets.current.at > 250) {
      targets.current = { ...collectTargets(onlyAlways, tuning.contextStrength), at: now };
    }
    return targets.current;
  };

  const activate = (el: HTMLElement) => {
    flash(el);
    announce(`Selected: ${labelOf(el)}`);
    el.click();
  };

  // --- Dwell with gaze or head pointer ------------------------------------------------
  useEffect(() => {
    if (!pointerMode) return;
    const cursor = cursorRef.current;
    const sel = selector.current;
    const handle = (frame: VisionFrame) => {
      const now = frame.t;
      // Tracking state and automatic fallback to scanning. This follows the face, not the pointer:
      // the pointer's own confidence also dips on the frame of each eye jump, which isn't a loss.
      // While selection is suspended (calibration dots), or eye gaze isn't calibrated yet, there is
      // no pointer by design: that's not a loss, and it must never switch the person to scanning.
      const expectPointer = mode === "head" || !!calibration;
      if (suspended || !expectPointer) {
        lowSince.current = null;
        setTracking(frame.trackingConfidence >= 0.5 ? "ok" : "weak");
      } else if (frame.trackingConfidence < 0.5 || !frame.pointer) {
        lowSince.current ??= now;
        goodSince.current = null;
        const lostFor = now - lowSince.current;
        setTracking(lostFor > 1500 ? "lost" : "weak");
        if (lostFor > 10000 && prefs.auto_fallback_to_scan && !fallbackActive) {
          setFallbackActive(true);
          announce("Eye tracking lost. Switched to scanning: press Space to select.", true);
        }
      } else {
        lowSince.current = null;
        goodSince.current ??= now;
        setTracking("ok");
        if (fallbackActive && now - goodSince.current > 2000) {
          setFallbackActive(false);
          announce("Tracking is back. Dwell selection is on again.");
        }
      }
      // Where the cursor goes: the middle of the held target while there is a lock, else the pointer.
      // The held target is highlighted, but the cursor keeps following the eyes (no snapping).
      let held = false;
      if (mode === "gaze" && frame.pointer && frame.confidence >= 0.5 && !suspended) {
        setLivePrecision(meter.current.update(now, vision.errorRadius));
      }
      if (!suspended && !fallbackActive && frame.pointer) {
        const { list, byId } = refreshTargets(now, eyeControlPaused);
        // The eye cursor selects where it is drawn, with no error circle (that belongs to calibrated gaze).
        const at = (mode === "head" && vision.cursorAt(now)) || frame.pointer;
        const events: SelectorEvent[] = sel.update(
          {
            t: now,
            x: at.x,
            y: at.y,
            confidence: frame.confidence,
            errorRadius: mode === "head" ? 0 : vision.errorRadius,
          },
          list,
        );
        for (const ev of events) {
          if (ev.type === "lock") {
            clearMarks("data-dwell-locked", true);
            if (ev.targetId) byId.get(ev.targetId)?.setAttribute("data-dwell-locked", "");
            continue;
          }
          const target = byId.get(ev.targetId);
          if (ev.type === "enter") {
            clearMarks("data-dwell-active");
            clearMarks("data-dwell-paused", true);
            target?.setAttribute("data-dwell-active", "");
          } else if (ev.type === "progress" && target) {
            target.style.setProperty("--dwell", ev.progress.toFixed(3));
          } else if (ev.type === "cancel") {
            clearMarks("data-dwell-active");
            clearMarks("data-dwell-paused", true);
          } else if (ev.type === "selected" && target) {
            target.style.setProperty("--dwell", "0");
            // Where the eyes were during this dwell teaches the engine where this person's gaze lands
            // (continuous recalibration: bounded, and only kept when it makes estimates better).
            vision.selected(ev.targetId, target.getBoundingClientRect(), now, ev.dwellStartT);
            activate(target);
            targets.current.at = 0;
          }
        }
        // The ring dims while it's paused (a glance away, a blink): it hasn't reset.
        const dwelling = sel.dwell.snapshot().targetId;
        const ring = dwelling ? byId.get(dwelling) : undefined;
        if (ring) ring.toggleAttribute("data-dwell-paused", sel.locked !== dwelling || !sel.supported);
        held = !!sel.locked;
      }
      const on = !!frame.pointer && prefs.show_gaze_cursor && !suspended;
      shown.current = { on, lockAt: null };
      if (cursor) {
        cursor.style.opacity = on ? (held || frame.confidence >= 0.5 ? "1" : "0.35") : "0";
        cursor.removeAttribute("data-locked");
      }
    };
    const off = vision.onFrame(handle);

    // Draw on every animation frame (60 a second), not on camera frames (30): the engine's cursor
    // glides between frames by itself. Moving onto or off a locked target, or between two, glides
    // too (160 ms ease-out) instead of jumping.
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let raf = 0;
    let drawn: { x: number; y: number } | null = null;
    let lastLock: { x: number; y: number } | null = null;
    let blend: { from: { x: number; y: number }; t0: number } | null = null;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { on, lockAt } = shown.current;
      if (!cursor || !on) {
        drawn = null;
        return;
      }
      const now = performance.now();
      const goal = lockAt ?? vision.cursorAt(now);
      if (!goal) return;
      const switched =
        !!lockAt !== !!lastLock ||
        (lockAt && lastLock && (lockAt.x !== lastLock.x || lockAt.y !== lastLock.y));
      lastLock = lockAt;
      if (switched && drawn && !reduceMotion) blend = { from: drawn, t0: now };
      let p = goal;
      if (blend) {
        const u = (now - blend.t0) / 160;
        if (u >= 1) blend = null;
        else {
          const e = 1 - (1 - u) ** 3;
          p = {
            x: blend.from.x + (goal.x - blend.from.x) * e,
            y: blend.from.y + (goal.y - blend.from.y) * e,
          };
        }
      }
      drawn = p;
      cursor.style.transform = `translate(${p.x}px, ${p.y}px)`;
    };
    raf = requestAnimationFrame(draw);

    return () => {
      off();
      cancelAnimationFrame(raf);
      shown.current = { on: false, lockAt: null };
      sel.reset(performance.now(), 0);
      clearDwellMarks();
      if (cursor) {
        cursor.style.opacity = "0";
        cursor.removeAttribute("data-locked");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pointerMode,
    vision,
    prefs,
    suspended,
    eyeControlPaused,
    fallbackActive,
    calibration,
    tuning.contextStrength,
  ]);

  // --- Eye gaze without a calibration: start calibrating by itself ----------------------
  // Someone who can only move their eyes can't click "Calibrate". Once the camera sees a face for a
  // moment, calibration opens on its own (once per session; the Home card stays if they leave it).
  useEffect(() => {
    if (mode !== "gaze" || calibration || input.status !== "running") return;
    let seenSince: number | null = null;
    return vision.onFrame((frame) => {
      const route = window.location.hash.replace(/^#/, "") || "/";
      const busy = /^\/(calibrate|camera|welcome|onboarding|lifeline|respond)/.test(route);
      let done = false;
      try {
        done = sessionStorage.getItem(AUTO_CALIBRATE_KEY) === "1";
      } catch {
        done = false;
      }
      if (done || busy || !frame.features) {
        seenSince = null;
        return;
      }
      seenSince ??= frame.t;
      if (frame.t - seenSince < 1500) return;
      try {
        sessionStorage.setItem(AUTO_CALIBRATE_KEY, "1");
      } catch {
        /* storage unavailable: still calibrate */
      }
      announce("Let's teach AGENCY your eyes: follow the dots.");
      navigate("/calibrate");
    });
  }, [mode, calibration, input.status, vision, announce]);

  // --- Scanning with a key or a long blink --------------------------------------------
  useEffect(() => {
    if (!scanning || suspended) {
      clearMarks("data-scan-active");
      return;
    }
    const s = scan.current;
    const apply = (events: ScanEvent[]) => {
      for (const ev of events) {
        if (ev.type === "highlight") {
          clearMarks("data-scan-active");
          const el = ev.id ? targets.current.byId.get(ev.id) : undefined;
          el?.setAttribute("data-scan-active", "");
          el?.scrollIntoView({ block: "nearest" });
          setScanPaused(false);
        } else if (ev.type === "select") {
          const el = targets.current.byId.get(ev.id);
          if (el) activate(el);
          targets.current.at = 0;
        } else if (ev.type === "paused") {
          setScanPaused(true);
          announce("Scanning paused. Press the switch to start again.");
        }
      }
    };
    const timer = window.setInterval(() => {
      const now = performance.now();
      const { list } = refreshTargets(now, eyeControlPaused);
      apply(
        s.setItems(
          list.map((t) => t.id),
          now,
        ),
      );
      apply(s.tick(now));
    }, 60);
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select");
      if (typing) return;
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) apply(s.press(performance.now()));
      }
    };
    // Space/Enter always work as a switch while scanning, including as a backup to the blink switch.
    const keySwitch = mode === "scan_key" || mode === "scan_blink" || fallbackActive;
    if (keySwitch) window.addEventListener("keydown", onKey, true);
    const offBlink =
      mode === "scan_blink" && !fallbackActive
        ? vision.onFrame((frame) => {
            const state = blink.current.update(frame.t, frame.face ? frame.blink : null);
            setBlinkProgress(state.closed ? state.progress : 0);
            setTracking(frame.face ? "ok" : "lost");
            if (state.fired) apply(s.press(frame.t));
          })
        : () => undefined;
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKey, true);
      offBlink();
      clearMarks("data-scan-active");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, suspended, mode, vision, fallbackActive, eyeControlPaused]);

  return (
    <>
      <div ref={cursorRef} className="gaze-cursor" aria-hidden="true" />
      {mode === "scan_blink" && blinkProgress > 0 && (
        <div className="blink-meter" aria-hidden="true">
          <span style={{ transform: `scaleX(${blinkProgress})` }} />
          Hold blink to select
        </div>
      )}
      {scanning && scanPaused && (
        <div className="scan-paused" role="status">
          Scanning paused. {mode === "scan_blink" && !fallbackActive ? "Long blink" : "Press Space"} to start
          again.
        </div>
      )}
      {fallbackActive && (
        <div className="fallback-banner" role="status">
          {MODE_LABELS[mode].short} tracking was lost, so scanning is on: press Space to select. It switches
          back when tracking returns.
        </div>
      )}
    </>
  );
}
