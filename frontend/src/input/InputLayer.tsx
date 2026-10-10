/**
 * Connects the camera pipeline (or a key switch) to the interface.
 *
 * Every interactive control that should work hands-free carries `data-dwell`. Selections
 * from any input method end in a normal `click()`, so the application logic is identical
 * whether a person uses gaze, a head pointer, a blink switch, a key, or a mouse.
 */

import { useEffect, useRef, useState } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { useAnnounce } from "../state/announcer";
import { MODE_LABELS, useInput } from "../state/input";
import { usePreferences } from "../state/preferences";
import { BlinkSwitch } from "../vision/blink";
import type { VisionFrame } from "../vision/tracker";
import { DwellEngine, type DwellEvent } from "./dwell";
import { ScanEngine, type ScanEvent } from "./scan";
import { findTarget, type TargetRect } from "./targets";

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
function collectTargets(onlyAlways: boolean): { list: TargetRect[]; byId: Map<string, HTMLElement> } {
  const scope = document.querySelector<HTMLElement>('[data-dwell-scope="modal"]') ?? document.body;
  const nodes = scope.querySelectorAll<HTMLElement>("[data-dwell]");
  const list: TargetRect[] = [];
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
    list.push({ id, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
  });
  return { list, byId };
}

function clearMarks(attr: string): void {
  document.querySelectorAll(`[${attr}]`).forEach((el) => {
    el.removeAttribute(attr);
    (el as HTMLElement).style.removeProperty("--dwell");
  });
}

function flash(el: HTMLElement): void {
  el.setAttribute("data-selected-flash", "");
  window.setTimeout(() => el.removeAttribute("data-selected-flash"), 450);
}

export function InputLayer() {
  const input = useInput();
  const { prefs } = usePreferences();
  const announce = useAnnounce();
  const cursorRef = useRef<HTMLDivElement>(null);
  const [blinkProgress, setBlinkProgress] = useState(0);
  const [scanPaused, setScanPaused] = useState(false);

  const dwell = useRef(new DwellEngine());
  const scan = useRef(new ScanEngine());
  const blink = useRef(new BlinkSwitch());
  const targets = useRef<{ list: TargetRect[]; byId: Map<string, HTMLElement>; at: number }>({
    list: [],
    byId: new Map(),
    at: 0,
  });
  const lowSince = useRef<number | null>(null);
  const dwellStart = useRef<{ id: string; t: number } | null>(null);
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
  const scanning = mode === "scan_key" || mode === "scan_blink" || fallbackActive;

  useEffect(() => {
    dwell.current.setConfig({
      dwellMs: prefs.dwell_ms,
      stabilityPx: prefs.dwell_stability_px,
    });
    scan.current.setConfig({ intervalMs: prefs.scan_interval_ms });
    blink.current.setOptions({ holdMs: prefs.blink_ms });
  }, [prefs.dwell_ms, prefs.dwell_stability_px, prefs.scan_interval_ms, prefs.blink_ms]);

  // Navigation: forget any half-finished dwell and pause selection briefly, so a control that
  // appears under the person's gaze is not selected by accident.
  useEffect(() => {
    const onNav = () => {
      dwell.current.reset(performance.now(), 1200);
      clearMarks("data-dwell-active");
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
      targets.current = { ...collectTargets(onlyAlways), at: now };
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
    const handle = (frame: VisionFrame) => {
      const now = frame.t;
      // Tracking state and automatic fallback to scanning. This follows the face, not the pointer:
      // the pointer's own confidence also dips on the frame of each eye jump, which isn't a loss.
      // While selection is suspended (calibration dots) there is no pointer by design: not a loss.
      if (suspended) {
        lowSince.current = null;
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
      if (cursor) {
        if (frame.pointer && prefs.show_gaze_cursor && !suspended) {
          cursor.style.opacity = frame.confidence >= 0.5 ? "1" : "0.35";
          cursor.style.transform = `translate(${frame.pointer.x}px, ${frame.pointer.y}px)`;
        } else {
          cursor.style.opacity = "0";
        }
      }
      if (suspended || fallbackActive || !frame.pointer) return;
      const { list, byId } = refreshTargets(now, eyeControlPaused);
      const targetId = findTarget(frame.pointer.x, frame.pointer.y, list, prefs.target_snap_px);
      const el = targetId ? byId.get(targetId) : undefined;
      const events: DwellEvent[] = dwell.current.update({
        t: now,
        x: frame.pointer.x,
        y: frame.pointer.y,
        confidence: frame.confidence,
        targetId,
        dwellScale: el?.hasAttribute("data-dwell-always") ? 2 : Number(el?.dataset.dwellScale ?? 1),
      });
      for (const ev of events) {
        const target = byId.get(ev.targetId);
        if (ev.type === "enter") {
          clearMarks("data-dwell-active");
          target?.setAttribute("data-dwell-active", "");
          dwellStart.current = { id: ev.targetId, t: now };
        } else if (ev.type === "progress" && target) {
          target.style.setProperty("--dwell", ev.progress.toFixed(3));
        } else if (ev.type === "cancel") {
          clearMarks("data-dwell-active");
        } else if (ev.type === "activate" && target) {
          target.style.setProperty("--dwell", "0");
          // Where the eyes were during this dwell teaches the engine where this person's gaze lands
          // (continuous recalibration: bounded, and only kept when it makes estimates better).
          const start = dwellStart.current?.id === ev.targetId ? dwellStart.current.t : now;
          vision.selected(ev.targetId, target.getBoundingClientRect(), now, start);
          dwellStart.current = null;
          activate(target);
          targets.current.at = 0;
        }
      }
    };
    const off = vision.onFrame(handle);
    return () => {
      off();
      clearMarks("data-dwell-active");
      if (cursor) cursor.style.opacity = "0";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointerMode, vision, prefs, suspended, eyeControlPaused, fallbackActive, calibration]);

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
