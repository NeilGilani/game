/**
 * In the Mac app, the shell is where the eyes are tracked: it runs the same calibrated camera pipeline as the web
 * app. This bridge shares two things with the desktop host (window.agency) so the system-wide overlay can work:
 *
 * - the calibrated pointer, as gaze samples in this window's client coordinates (main converts them to global
 *   screen points and forwards them to the overlay, for every other app);
 * - the shell's own selectable targets, so main knows AGENCY is in front and the overlay stands down instead of
 *   reading this window's accessibility tree.
 *
 * In a browser there is no host and this renders nothing. Camera frames never leave this window; only the
 * pointer position does.
 */
import { useEffect } from "react";
import type { GazeEvent, Target } from "./contracts";
import { useInput } from "./input";

interface GazeHost {
  gaze: { publish(event: GazeEvent): void };
  targets: { publishShell(targets: Target[]): void };
}

function gazeHost(): GazeHost | null {
  const h = (window as unknown as { agency?: Partial<GazeHost> & { role?: string } }).agency;
  if (!h || h.role !== "shell" || typeof h.gaze?.publish !== "function") return null;
  if (typeof h.targets?.publishShell !== "function") return null;
  return h as GazeHost;
}

const SAMPLE_INTERVAL_MS = 1000 / 30;

/** Every visible [data-dwell] element, as targets in client coordinates (CSS pixels). */
export function collectShellTargets(root: ParentNode = document): Target[] {
  const out: Target[] = [];
  const seen = new Map<string, number>();
  root.querySelectorAll<HTMLElement>("[data-dwell]").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return;
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const base = el.id || `shell:${label || el.tagName.toLowerCase()}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const scale = Number(el.dataset.dwellScale);
    out.push({
      id: n > 1 ? `${base}#${n}` : base,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
      label,
      source: "shell",
      ...(Number.isFinite(scale) && scale > 0 ? { dwellScale: scale } : {}),
    });
  });
  return out;
}

export function HostBridge() {
  const input = useInput();
  const { vision } = input;

  // The calibrated pointer, throttled to 30 Hz. Tracking state follows face loss.
  useEffect(() => {
    const host = gazeHost();
    if (!host) return;
    let last = 0;
    let lost = false;
    return vision.onFrame((f) => {
      if (input.eyeControlPaused) return;
      if (!f.face || f.trackingConfidence < 0.5) {
        if (!lost) host.gaze.publish({ type: "tracking", t: f.t, state: f.face ? "weak" : "lost" });
        lost = true;
        return;
      }
      if (lost) host.gaze.publish({ type: "tracking", t: f.t, state: "ok" });
      lost = false;
      if (!f.pointer || f.t - last < SAMPLE_INTERVAL_MS) return;
      last = f.t;
      host.gaze.publish({
        type: "sample",
        sample: {
          t: f.t,
          x: f.pointer.x,
          y: f.pointer.y,
          confidence: f.confidence,
          fixation: f.fixation,
          source: vision.kind === "head" ? "webcam-head" : "webcam-gaze",
        },
      });
    });
  }, [vision, input.eyeControlPaused]);

  // The shell's targets: on any change to the page, on resize and scroll, and twice a second as a backstop.
  useEffect(() => {
    const host = gazeHost();
    if (!host) return;
    let pending = 0;
    const publish = () => {
      pending = 0;
      host.targets.publishShell(collectShellTargets());
    };
    const schedule = () => {
      if (!pending) pending = window.setTimeout(publish, 120);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const timer = window.setInterval(publish, 500);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.clearInterval(timer);
      if (pending) window.clearTimeout(pending);
    };
  }, []);

  return null;
}
