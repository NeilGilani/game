/** Gaze and switch input, published by the gaze engine (os/gaze) at up to 60 Hz. */

export type InputSource = "webcam-gaze" | "webcam-head" | "mouse" | "switch" | "external-tracker";

export interface GazeSample {
  /** Milliseconds, monotonic clock of the engine (performance.now()). */
  t: number;
  /** Global screen points. */
  x: number;
  y: number;
  /** 0..1. Below 0.5 consumers must not start or continue a dwell. */
  confidence: number;
  /** True while the eyes are in a fixation (not a saccade). */
  fixation: boolean;
  source: InputSource;
}

export interface CalibrationQuality {
  grade: "good" | "fair" | "poor";
  /** Mean error on held-out targets, in screen points. */
  meanErrorPt: number;
  /** Same error in degrees of visual angle, when the viewing distance could be estimated. */
  meanErrorDeg: number | null;
  points: number;
  at: string; // ISO time
}

export type TrackingState = "ok" | "weak" | "lost";

export type GazeEvent =
  | { type: "sample"; sample: GazeSample }
  /** Blink score 0..1, or null when no face is visible (never read face loss as a blink). */
  | { type: "blink"; t: number; score: number | null; face: boolean }
  /** A single-switch press: long blink, key, or external switch. */
  | { type: "switch"; t: number; source: "blink" | "key" | "external" }
  | { type: "tracking"; t: number; state: TrackingState }
  | { type: "calibration"; quality: CalibrationQuality }
  /** Three long blinks: Lifeline's help signal. Consumers forward it to POST /api/lifeline/help. */
  | { type: "help-signal"; t: number }
  /** Progress of the help signal, for the on-screen meter (counted 0..3). */
  | { type: "help-progress"; t: number; counted: number };
