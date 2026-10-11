/**
 * Squint to scroll: squint (narrow the eyes, a deliberate gesture unlike a blink or a downward look), then move the
 * head up or down. The further from where the squint started, the faster it scrolls; open the eyes to stop. While
 * scrolling, nothing can be selected, so a page sliding under the cursor never chooses anything.
 *
 * It scrolls whatever is under the cursor that can scroll (else the screen itself). Works with the eye cursor and
 * calibrated gaze, in the app and in the browser version.
 */
import { useEffect, useRef, useState } from "react";
import { useInput } from "../state/input";
import type { VisionFrame } from "../vision/tracker";
import { SquintGesture } from "./squintGesture";

function scrollableAt(x: number, y: number): Element {
  let el: Element | null = document.elementFromPoint(x, y);
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
    el = el.parentElement;
  }
  const main = document.getElementById("main");
  if (main && main.scrollHeight > main.clientHeight + 4) return main;
  return document.scrollingElement ?? document.documentElement;
}

export function SquintScroll() {
  const input = useInput();
  const gestureOwnsPause = useRef(false);
  const { vision, mode, setSuspended, suspended } = input;
  // Selection already paused by something else (the eye scan): leave it alone.
  const pausedElsewhere = useRef(suspended);
  pausedElsewhere.current = suspended && !gestureOwnsPause.current;
  const [dir, setDir] = useState<-1 | 0 | 1 | null>(null);
  const gesture = useRef(new SquintGesture());
  const pointerMode = mode === "gaze" || mode === "head";

  useEffect(() => {
    if (!pointerMode) return;
    const g = gesture.current;
    let target: Element | null = null;
    let last = 0;
    let speed = 0;
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!g.active || !target) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (speed) target.scrollBy({ top: speed * dt });
    };
    const off = vision.onFrame((f: VisionFrame) => {
      const y = f.pointer?.y ?? null;
      if (pausedElsewhere.current && !g.active) return;
      const change = g.update(f.t, f.squint, y);
      if (change === "start" && f.pointer) {
        target = scrollableAt(f.pointer.x, f.pointer.y);
        last = performance.now();
        gestureOwnsPause.current = true;
        setSuspended(true);
        setDir(0);
      } else if (change === "stop") {
        target = null;
        speed = 0;
        gestureOwnsPause.current = false;
        setSuspended(false);
        setDir(null);
      }
      if (g.active && y !== null) {
        speed = g.speed(y);
        setDir(speed > 0 ? 1 : speed < 0 ? -1 : 0);
      }
    });
    raf = requestAnimationFrame(tick);
    return () => {
      off();
      cancelAnimationFrame(raf);
      if (g.active && gestureOwnsPause.current) setSuspended(false);
      gestureOwnsPause.current = false;
      g.active = false;
    };
  }, [vision, pointerMode, setSuspended]);

  if (dir === null) return null;
  return (
    <div className="squint-scroll" role="status" aria-live="polite">
      <span className="squint-scroll-arrow" data-dir={dir} aria-hidden>
        {dir < 0 ? "▲" : dir > 0 ? "▼" : "↕"}
      </span>
      <span>
        <strong>Scrolling</strong>
        <br />
        Move your head up or down. Open your eyes to stop.
      </span>
    </div>
  );
}
