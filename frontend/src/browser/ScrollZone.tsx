/**
 * Scrolling with the eyes: look at "Scroll down" and the page glides, slowly at first and faster the longer the eyes
 * stay; look away and it stops at once. While it glides nothing can be chosen, so the page moving under the cursor
 * never picks anything. A click (mouse, switch, a finished dwell) scrolls one step. "Page up" and "Page down" are
 * plain buttons: one look, one page.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { useInput } from "../state/input";
import { contains } from "./geometry";
import { GLIDE_DELAY_MS, glideSpeed } from "./glide";

export function ScrollZone({
  direction,
  onScroll,
  disabled,
}: {
  direction: 1 | -1;
  /** Scroll by this many pixels (positive is down). */
  onScroll: (dy: number) => void;
  disabled?: boolean;
}) {
  const input = useInput();
  const ref = useRef<HTMLButtonElement>(null);
  const [gliding, setGliding] = useState(false);
  const scrollRef = useRef(onScroll);
  scrollRef.current = onScroll;
  const { vision, mode, setSuspended } = input;

  useEffect(() => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    let since: number | null = null;
    let active = false;
    let last = 0;
    let raf = 0;
    let owns = false;
    let mouseInside = false;
    const set = (on: boolean) => {
      if (on === active) return;
      active = on;
      setGliding(on);
      // Nothing can be chosen while the page glides (the cursor goes quiet too).
      if (on && !owns) {
        owns = true;
        setSuspended(true);
      } else if (!on && owns) {
        owns = false;
        setSuspended(false);
      }
    };
    const update = (now: number, inside: boolean) => {
      if (!inside) {
        since = null;
        set(false);
        return;
      }
      since ??= now;
      if (now - since >= GLIDE_DELAY_MS) set(true);
    };
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!active || since === null) {
        last = now;
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const dy = direction * glideSpeed(now - since - GLIDE_DELAY_MS) * dt;
      if (Math.abs(dy) >= 1) scrollRef.current(dy);
    };
    raf = requestAnimationFrame(tick);
    const pointer = mode === "gaze" || mode === "head";
    const off = pointer
      ? vision.onFrame((f) => {
          const at = (mode === "head" && vision.cursorAt(f.t)) || f.pointer;
          const r = el.getBoundingClientRect();
          update(
            performance.now(),
            !!at && contains({ x: r.left, y: r.top, width: r.width, height: r.height }, at),
          );
        })
      : () => undefined;
    // A mouse resting on it glides too (helpers, and people who use a head mouse).
    const enter = () => (mouseInside = true);
    const leave = () => {
      mouseInside = false;
      update(performance.now(), false);
    };
    const hover = window.setInterval(() => mouseInside && update(performance.now(), true), 50);
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    return () => {
      off();
      cancelAnimationFrame(raf);
      window.clearInterval(hover);
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
      if (owns) setSuspended(false);
    };
  }, [vision, mode, direction, disabled, setSuspended]);

  const label = direction > 0 ? "Scroll down" : "Scroll up";
  return (
    <button
      ref={ref}
      className="bw-rail-btn bw-scroll"
      data-gliding={gliding || undefined}
      data-dir={direction > 0 ? "down" : "up"}
      onClick={() => scrollRef.current(direction * 220)}
      disabled={disabled}
      data-dwell
      aria-label={`${label}. Keep looking to keep scrolling.`}
    >
      <Icon name={direction > 0 ? "down" : "up"} size={34} flat />
      <span>{gliding ? "Scrolling…" : label}</span>
    </button>
  );
}
