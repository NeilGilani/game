/**
 * External eye trackers (for example a Tobii, or any device with its own SDK) plug in here
 * later. Nothing device-specific is implemented, because we have no hardware to test it on.
 *
 * An adapter only has to deliver samples. Trackers usually report gaze normalised to one
 * display (0..1); pass that display's bounds and they are converted to global screen points.
 * The engine then applies the same fixation smoothing, confidence rules and precision helpers
 * as for the webcam (with the noise level learned from the tracker's own fixations).
 */

import type { ScreenRect } from "../contracts";
import type { GazeProvider, ProviderFrame } from "./types";

export interface ExternalSample {
  /** Device or engine clock, ms. If the device clock differs, map it before pushing. */
  t: number;
  /** Either global points, or normalised (0..1) to `display`. */
  x: number;
  y: number;
  normalized?: boolean;
  /** Device validity/confidence 0..1. Invalid samples should be pushed with 0, not dropped. */
  confidence: number;
}

export interface ExternalTrackerDriver {
  readonly name: string;
  /** Connect and start streaming samples to `push`. Reject with a plain-language message on failure. */
  connect(push: (s: ExternalSample) => void): Promise<void>;
  disconnect(): void;
}

export class ExternalTrackerProvider implements GazeProvider {
  readonly id: string;
  readonly kind = "pointer" as const;
  private onFrame: ((f: ProviderFrame) => void) | null = null;

  constructor(
    private readonly driver: ExternalTrackerDriver,
    private readonly display: ScreenRect,
  ) {
    this.id = `external:${driver.name}`;
  }

  async start(onFrame: (f: ProviderFrame) => void): Promise<void> {
    this.onFrame = onFrame;
    await this.driver.connect((s) => this.push(s));
  }

  stop(): void {
    this.driver.disconnect();
    this.onFrame = null;
  }

  push(s: ExternalSample): void {
    const d = this.display;
    const x = s.normalized ? d.x + s.x * d.width : s.x;
    const y = s.normalized ? d.y + s.y * d.height : s.y;
    this.onFrame?.({
      kind: "pointer",
      frame: {
        t: s.t,
        captureT: s.t,
        x,
        y,
        confidence: Math.max(0, Math.min(1, s.confidence)),
        source: "external-tracker",
      },
    });
  }
}

/** A driver that replays scripted samples: the fake for development and tests. */
export class ScriptedTrackerDriver implements ExternalTrackerDriver {
  readonly name = "scripted";
  private push: ((s: ExternalSample) => void) | null = null;

  async connect(push: (s: ExternalSample) => void): Promise<void> {
    this.push = push;
  }

  disconnect(): void {
    this.push = null;
  }

  emit(s: ExternalSample): void {
    this.push?.(s);
  }
}
