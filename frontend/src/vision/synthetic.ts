/**
 * TEST ONLY: a simulated person in front of the screen, for end-to-end tests of eye control
 * (calibration, pointer, dwell) through the real gaze engine in a real browser. Loaded only when
 * the test hooks are on (localStorage "agency.testHooks" = "1", see main.tsx), as its own chunk.
 *
 * It renders MediaPipe-shaped landmarks from a geometric face with webcam-like noise
 * (os/gaze/src/synth), not from a camera. A passing test proves the app's wiring and the engine,
 * not accuracy for a real person: real faces, cameras and light add error this model doesn't have.
 */

import {
  type Display,
  MACBOOK_DISPLAY,
  SyntheticFace,
  TYPICAL_NOISE,
  WEBCAM_640,
  randomAnatomy,
} from "../../../os/gaze/src/synth/face";
import { HeadMotion, type HeadMotionKind } from "../../../os/gaze/src/synth/scenarios";
import type { VisionEngine } from "./tracker";

export interface SyntheticEyesOptions {
  seed?: number;
  head?: HeadMotionKind;
  fps?: number;
}

/** A point in viewport pixels, or a CSS selector: look at the centre of the first match. */
export type LookTarget = { x: number; y: number } | string;

export class SyntheticEyes {
  private readonly face: SyntheticFace;
  private readonly head: HeadMotion;
  private readonly fps: number;
  private timer = 0;
  private target: LookTarget = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  private closedUntil = 0;

  constructor(
    private readonly vision: VisionEngine,
    options: SyntheticEyesOptions = {},
  ) {
    const seed = options.seed ?? 3;
    // The viewport stands in for the whole display, at a MacBook's physical point size.
    const display: Display = { ...MACBOOK_DISPLAY, widthPt: window.innerWidth, heightPt: window.innerHeight };
    this.face = new SyntheticFace(randomAnatomy(seed), display, WEBCAM_640, TYPICAL_NOISE, seed);
    this.head = new HeadMotion({ kind: options.head ?? "still", seed });
    this.fps = options.fps ?? 30;
  }

  start(): void {
    this.vision.useExternalFrames();
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.frame(), 1000 / this.fps);
  }

  stop(): void {
    window.clearInterval(this.timer);
  }

  lookAt(target: LookTarget): void {
    this.target = target;
  }

  /** Close the eyes for `ms` (a blink, or a long blink for the blink switch). */
  close(ms: number): void {
    this.closedUntil = performance.now() + ms;
  }

  private where(): { x: number; y: number } {
    if (typeof this.target !== "string") return this.target;
    const el = document.querySelector(this.target);
    if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  private frame(): void {
    const t = performance.now();
    const f = this.face.render({
      gaze: this.where(),
      head: this.head.at(t),
      closure: t < this.closedUntil ? 1 : 0,
    });
    this.vision.feed({ t, landmarks: f.landmarks, matrix: f.matrix, blink: f.blinkScore, aspect: f.aspect });
  }
}
