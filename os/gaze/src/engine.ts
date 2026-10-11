/**
 * The gaze engine: provider frames in, contract GazeEvents out (global screen points).
 *
 *   provider (webcam | replay | mouse | external)
 *     -> features (landmarks, head pose, normalised eyes)            face providers only
 *     -> calibrated model (v2) -> continuous correction
 *     -> fixation smoother -> confidence -> clamp to the displays
 *     -> GazeEvent "sample"
 *   and alongside, from every face frame whether or not gaze is calibrated:
 *     -> blink score -> "blink"; long-blink switch -> "switch"
 *     -> Lifeline's help pattern -> "help-progress" / "help-signal"
 *     -> tracking state -> "tracking"
 *
 * Lifeline first: the help pattern runs on every face frame, in every mode, calibrated or not,
 * paused or not. Nothing in the engine can turn it off except stopping the camera.
 */

import { type GazeInput, gazeInput } from "./calibration/features";
import { ContinuousCalibrator, type ContinuousEvent } from "./calibration/continuous";
import { predictBlend } from "./calibration/appearance";
import {
  type HeadModel,
  POSTURE_MESSAGES,
  type PostureIssue,
  PostureMonitor,
  type PostureOptions,
  fitHeadModel,
  headDelta,
  poseOf,
} from "./calibration/head";
import { TouchUp, type TouchUpResult } from "./calibration/touchup";
import { predictModel } from "./calibration/model";
import {
  type CalibrationResult,
  CalibrationSession,
  type SessionOptions,
  type SessionStep,
} from "./calibration/session";
import { DEFAULT_GEOMETRY, type ViewingGeometry, viewingDistanceCm } from "./calibration/viewing";
import { BlinkSwitch, type BlinkOptions, OpennessBlink } from "./blink";
import type {
  CalibrationQuality,
  GazeEvent,
  InputSource,
  ScreenRect,
  Target,
  TrackingState,
} from "./contracts";
import { FixationSmoother, type FixationOptions, type SmoothedPoint } from "./fixation";
import { FrameRateGovernor, type FrameRateOptions } from "./frameRate";
import { HeadPointer, type HeadPointerOptions } from "./headPointer";
import { HelpPattern, type PatternOptions, type PatternState } from "./helpPattern";
import { type PaceChange, PaceMonitor, type PaceOptions, type PaceState } from "./input/pace";
import { type GazeFeatures, extractFeatures } from "./landmarks";
import {
  DEFAULT_PRECISION,
  type PrecisionDecision,
  type PrecisionOptions,
  decidePrecision,
  sigmaFromMeanError,
} from "./precision";
import { type QualityIssue, assessBrightness, assessFace, trackingConfidence } from "./quality";
import type { ScreenSpace } from "./screen";
import type { FaceFrame, GazeProvider, PointerFrame, ProviderFrame } from "./providers/types";

export type EngineMode = "gaze" | "head";

export interface EngineOptions {
  screen: ScreenSpace;
  mode?: EngineMode;
  geometry?: ViewingGeometry;
  /** Emit "switch" events for deliberate long blinks (scanning with a blink switch). */
  blinkSwitch?: boolean;
  blink?: Partial<BlinkOptions>;
  help?: Partial<PatternOptions>;
  fixation?: Partial<FixationOptions>;
  frameRate?: Partial<FrameRateOptions>;
  headPointer?: Partial<HeadPointerOptions>;
  precision?: Partial<PrecisionOptions>;
  posture?: Partial<PostureOptions>;
  pace?: Partial<PaceOptions>;
  /** Clock for latency (performance.now in a browser). Replays and tests can pass their own. */
  clock?: () => number;
}

/** Everything the engine knows about a frame, for setup screens, benchmarks and the recorder. */
export interface FrameDetail {
  t: number;
  face: boolean;
  features: GazeFeatures | null;
  blink: number | null;
  /** Tracking confidence from the face alone (pose, distance, eyes open). */
  trackingConfidence: number;
  /** Final sample confidence (what consumers see). */
  confidence: number;
  issues: QualityIssue[];
  /** Calibrated (and corrected) estimate before smoothing, global points. */
  raw: { x: number; y: number } | null;
  /** Smoothed, clamped point, global points. */
  point: { x: number; y: number } | null;
  smoothed: SmoothedPoint | null;
  help: PatternState;
  /** Moved far from where they were during the scan: what to tell them (null: fine, or no scan). */
  posture: PostureIssue | null;
  errorRadiusPt: number;
  /** Camera capture to event, ms, when the provider reports capture times. */
  latencyMs: number | null;
}

export type EngineAdvice =
  | { type: "recalibrate"; t: number; reason: string }
  | { type: "continuous"; event: ContinuousEvent }
  /** Gaze has drifted one way: show the 2-second touch-up dot (startTouchUp) instead of a rescan. */
  | { type: "touch-up"; t: number; reason: string }
  | { type: "touch-up-result"; t: number; result: TouchUpResult; applied: boolean }
  /** The person moved far from their scan position (message in plain words), or is back (null). */
  | { type: "posture"; t: number; issue: PostureIssue | null; message: string | null }
  /** Selecting got harder or easier: new dwell and target scales (input/pace.ts). */
  | PaceChange;

interface TouchUpRun {
  touchUp: TouchUp;
  startT: number | null;
  resolve: (r: TouchUpResult) => void;
}

export class TrackingMonitor {
  private state: TrackingState = "lost";
  private lowSince: number | null = null;
  private goodRun = 0;

  constructor(private readonly lostAfterMs = 1500) {}

  get current(): TrackingState {
    return this.state;
  }

  /** Returns the new state when it changed, else null. */
  update(t: number, confidence: number): TrackingState | null {
    let next = this.state;
    if (confidence >= 0.5) {
      this.goodRun += 1;
      this.lowSince = null;
      if (this.goodRun >= 3 || this.state === "weak") next = "ok";
    } else {
      this.goodRun = 0;
      this.lowSince ??= t;
      next = t - this.lowSince >= this.lostAfterMs ? "lost" : this.state === "lost" ? "lost" : "weak";
    }
    if (next === this.state) return null;
    this.state = next;
    return next;
  }
}

/** Final sample confidence: below 0.5 consumers must not start or continue a dwell. */
export function sampleConfidence(
  tracking: number,
  smoothed: SmoothedPoint | null,
  outsideCalibratedPt: number,
): number {
  let c = tracking;
  // The frame where a saccade was detected is in transit: don't dwell on it.
  if (smoothed?.saccade) c = Math.min(c, 0.45);
  // Beyond the calibrated display the model extrapolates: trust it less.
  if (outsideCalibratedPt > 100) c *= 0.6;
  return Math.max(0, Math.min(1, c));
}

interface Collecting {
  targetId: string;
  startT: number | null;
  settleMs: number;
  collectMs: number;
  maxMs: number;
  minSamples: number;
  inputs: GazeInput[];
  resolve: (n: number) => void;
}

/** A calibration run driven by the host UI (show target, collect, repeat). */
export class CalibrationRun {
  private collecting: Collecting | null = null;
  readonly session: CalibrationSession;

  constructor(
    private readonly engine: GazeEngine,
    options: SessionOptions,
  ) {
    this.session = new CalibrationSession(options);
  }

  next(): SessionStep {
    return this.session.next();
  }

  /**
   * Collect frames for the target now on screen: wait settleMs for the eyes to land, then gather
   * usable frames for collectMs (longer, up to maxMs, if blinks got in the way). Resolves with
   * the number of frames used. Time is measured on frame timestamps, so replays work too.
   */
  collect(
    targetId: string,
    options: { settleMs?: number; collectMs?: number; maxMs?: number; minSamples?: number } = {},
  ) {
    this.cancel();
    return new Promise<number>((resolve) => {
      this.collecting = {
        targetId,
        startT: null,
        settleMs: options.settleMs ?? 800,
        collectMs: options.collectMs ?? 1100,
        maxMs: options.maxMs ?? 2600,
        minSamples: options.minSamples ?? 10,
        inputs: [],
        resolve,
      };
    });
  }

  cancel(): void {
    const c = this.collecting;
    this.collecting = null;
    c?.resolve(0);
  }

  /** Called by the engine for every face frame. */
  frame(t: number, features: GazeFeatures | null, confidence: number, blink: number | null): void {
    const c = this.collecting;
    if (!c) return;
    c.startT ??= t;
    const elapsed = t - c.startT;
    if (elapsed >= c.settleMs && features && confidence >= 0.5 && (blink ?? 0) < 0.4) {
      c.inputs.push(gazeInput(features));
    }
    const collected = elapsed - c.settleMs;
    if ((collected >= c.collectMs && c.inputs.length >= c.minSamples) || elapsed >= c.settleMs + c.maxMs) {
      this.collecting = null;
      this.session.addSamples(c.targetId, c.inputs);
      c.resolve(c.inputs.length);
    }
  }

  /** Use the finished calibration in the engine. */
  apply(result: CalibrationResult): void {
    this.engine.setCalibration(result);
  }
}

export class GazeEngine {
  private o: EngineOptions;
  private listeners = new Set<(e: GazeEvent) => void>();
  private detailListeners = new Set<(d: FrameDetail) => void>();
  private faceListeners = new Set<(f: FaceFrame) => void>();
  private adviceListeners = new Set<(a: EngineAdvice) => void>();
  private provider: GazeProvider | null = null;
  private calibrationResult: CalibrationResult | null = null;
  private continuous: ContinuousCalibrator | null = null;
  private head: HeadModel | null = null;
  private posture: PostureMonitor;
  private pace: PaceMonitor;
  private touchUpRun: TouchUpRun | null = null;
  private smoother: FixationSmoother;
  private pointerSmoother: FixationSmoother;
  private blinkSwitch: BlinkSwitch;
  private opennessBlink = new OpennessBlink();
  private help: HelpPattern;
  private tracking = new TrackingMonitor();
  private governor: FrameRateGovernor;
  private headPointer: HeadPointer;
  private run: CalibrationRun | null = null;
  private lastHelpCount = 0;
  private lastPoint: { x: number; y: number } | null = null;
  private observations: { t: number; x: number; y: number; z: number[] }[] = [];
  private irisWindow: number[] = [];
  private latencies: number[] = [];
  private frameTimes: number[] = [];
  private paused = false;
  private lastDetail: FrameDetail | null = null;
  private liveGrade: CalibrationQuality["grade"] | null = null;

  constructor(options: EngineOptions) {
    this.o = { mode: "gaze", geometry: DEFAULT_GEOMETRY, ...options };
    this.smoother = new FixationSmoother({ geometry: this.geometry, ...options.fixation });
    this.pointerSmoother = new FixationSmoother({
      geometry: this.geometry,
      initialNoisePt: 20,
      ...options.fixation,
    });
    this.blinkSwitch = new BlinkSwitch(options.blink);
    this.help = new HelpPattern(options.help);
    this.governor = new FrameRateGovernor(options.frameRate);
    this.headPointer = new HeadPointer(options.screen.cameraDisplay.bounds, options.headPointer);
    this.posture = new PostureMonitor(options.posture);
    this.pace = new PaceMonitor(options.pace);
  }

  get geometry(): ViewingGeometry {
    return this.o.geometry ?? DEFAULT_GEOMETRY;
  }

  get mode(): EngineMode {
    return this.o.mode ?? "gaze";
  }

  get calibration(): CalibrationResult | null {
    return this.calibrationResult;
  }

  get last(): FrameDetail | null {
    return this.lastDetail;
  }

  get screen(): ScreenSpace {
    return this.o.screen;
  }

  on(listener: (e: GazeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDetail(listener: (d: FrameDetail) => void): () => void {
    this.detailListeners.add(listener);
    return () => this.detailListeners.delete(listener);
  }

  /** Raw face frames, for an opt-in Recorder. */
  onFace(listener: (f: FaceFrame) => void): () => void {
    this.faceListeners.add(listener);
    return () => this.faceListeners.delete(listener);
  }

  onAdvice(listener: (a: EngineAdvice) => void): () => void {
    this.adviceListeners.add(listener);
    return () => this.adviceListeners.delete(listener);
  }

  private emit(e: GazeEvent): void {
    for (const l of this.listeners) l(e);
  }

  private advise(a: EngineAdvice): void {
    for (const l of this.adviceListeners) l(a);
  }

  async attach(provider: GazeProvider): Promise<void> {
    this.detach();
    this.provider = provider;
    this.smoother.reset();
    this.pointerSmoother.reset();
    await provider.start((f) => this.handle(f));
  }

  detach(): void {
    this.provider?.stop();
    this.provider = null;
  }

  setScreen(screen: ScreenSpace): void {
    this.o = { ...this.o, screen };
    this.headPointer.setBounds(screen.cameraDisplay.bounds);
  }

  setMode(mode: EngineMode): void {
    this.o = { ...this.o, mode };
    this.smoother.reset();
    this.headPointer.recentre();
  }

  setBlinkSwitch(on: boolean, options?: Partial<BlinkOptions>): void {
    this.o = { ...this.o, blinkSwitch: on };
    if (options) this.blinkSwitch.setOptions(options);
  }

  /** Eye control paused by the person: samples still flow (protected targets), frame rate drops. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.governor.setPaused(paused);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Tune the gaze smoother (fixation filter), e.g. with settings the Gaze lab chose by replaying the
   * person's own recorded estimates. The viewing distance stays whatever the iris size says.
   */
  setFilter(options: Partial<Omit<FixationOptions, "distanceCm" | "geometry">>): void {
    this.smoother.setOptions(options);
  }

  recentreHeadPointer(): void {
    this.headPointer.recentre();
  }

  setCalibration(result: CalibrationResult | null): void {
    this.calibrationResult = result;
    this.liveGrade = null;
    this.smoother.reset();
    this.cancelTouchUp("A new calibration replaced it.");
    // How this person's gaze offset moves with the head, from the scan's own frames (head.ts).
    this.head = result ? fitHeadModel(result.samples, result.model.config) : null;
    const posture = this.posture.current;
    this.posture.reset();
    if (posture) this.advise({ type: "posture", t: this.lastDetail?.t ?? 0, issue: null, message: null });
    if (result) {
      const d = this.o.screen.cameraDisplay.bounds;
      const centre = { x: d.x + d.width / 2, y: d.y + d.height / 2 };
      if (this.continuous) this.continuous.reset(result.quality.grade, centre, this.head);
      else
        this.continuous = new ContinuousCalibrator(
          { centre, calibratedGrade: result.quality.grade },
          this.head,
        );
      if (result.distanceCm) this.smoother.setOptions({ distanceCm: result.distanceCm });
      this.emit({ type: "calibration", quality: result.quality });
    } else {
      this.continuous = null;
    }
  }

  /** Start a calibration run on the camera's display (or the given bounds). */
  startCalibration(options: Partial<SessionOptions> = {}): CalibrationRun {
    this.run?.cancel();
    this.run = new CalibrationRun(this, {
      display: this.o.screen.cameraDisplay.bounds,
      geometry: this.geometry,
      ...options,
    });
    return this.run;
  }

  endCalibration(): void {
    this.run?.cancel();
    this.run = null;
  }

  /** The head model fitted for the current calibration (null without one, or without a metric pose). */
  get headModel(): HeadModel | null {
    return this.head;
  }

  /** What the person has been told about their position (null: nothing). */
  get postureIssue(): PostureIssue | null {
    return this.posture.current;
  }

  /** Current dwell and target scales from the pace monitor. */
  get paceState(): PaceState {
    return this.pace.state;
  }

  /** The person changed dwell or target settings: pace measures afresh from here. */
  rebasePace(): void {
    this.pace.rebase();
  }

  /**
   * The 2-second touch-up: show a dot at `target` (default: the middle of the calibrated display)
   * until `done` resolves. The engine's own frames over the last 1.3 s shift the correction so the
   * dot is hit. Resolves with the result; a failed touch-up changes nothing.
   */
  startTouchUp(target?: { x: number; y: number }): {
    target: { x: number; y: number };
    done: Promise<TouchUpResult>;
  } {
    const d = this.o.screen.cameraDisplay.bounds;
    const at = target ?? { x: d.x + d.width / 2, y: d.y + d.height / 2 };
    this.cancelTouchUp("Cancelled.");
    const touchUp = new TouchUp({ target: at });
    const done = new Promise<TouchUpResult>((resolve) => {
      this.touchUpRun = { touchUp, startT: null, resolve };
    });
    return { target: at, done };
  }

  cancelTouchUp(reason = "Cancelled."): void {
    const run = this.touchUpRun;
    this.touchUpRun = null;
    run?.resolve({ kind: "failed", reason });
  }

  private touchUpFrame(
    t: number,
    est: { x: number; y: number } | null,
    z: number[],
    tracking: number,
    blink: number | null,
  ): void {
    const run = this.touchUpRun;
    if (!run) return;
    run.startT ??= t;
    const ms = t - run.startT;
    run.touchUp.add(ms, est, z, tracking, blink);
    if (ms < run.touchUp.durationMs) return;
    this.touchUpRun = null;
    const result = run.touchUp.finish();
    let applied = false;
    if (result.kind === "done" && this.continuous) {
      for (const e of this.continuous.touchUp(t, result.target, result.estimate, result.z)) {
        this.advise({ type: "continuous", event: e });
        if (e.type === "touched-up") applied = true;
        if (e.type === "recalibrate") this.advise({ type: "recalibrate", t: e.t, reason: e.reason });
      }
      if (applied) this.smoother.reset();
    }
    this.advise({ type: "touch-up-result", t, result, applied });
    run.resolve(result);
  }

  /**
   * Per-axis error of the current estimate (points): measured accuracy (recent confirmed
   * selections, else the calibration's validation error) combined with the smoother's remaining
   * noise.
   */
  get errorSigmaPt(): number {
    if (this.provider?.kind === "pointer" && this.provider.id === "mouse") return 2;
    const recent = this.continuous?.quality.at(-1)?.errorPt;
    let accuracy = sigmaFromMeanError(recent ?? this.calibrationResult?.quality.meanErrorPt ?? 120);
    // Far from the scan's position estimates are less certain: a wider circle, and the picker reaches further.
    if (this.posture.current && this.mode === "gaze") accuracy *= 1.5;
    const noise = (this.lastDetail?.smoothed?.outputNoisePt ?? 30) / Math.SQRT2;
    return Math.hypot(accuracy, noise);
  }

  /** Radius of the error circle to draw (about 2 sigma: 86 % of estimates fall inside). */
  get errorRadiusPt(): number {
    return Math.max(12, 2 * this.errorSigmaPt);
  }

  /** How long the eyes have held the current fixation (ms); 0 when not fixating. */
  get fixationMs(): number {
    const s = this.lastDetail?.smoothed;
    if (this.provider?.kind === "pointer") return this.lastDetail ? 1000 : 0;
    return s?.fixation ? s.fixationMs : 0;
  }

  /**
   * "Which one?" picker / magnifier decision for the current gaze and these targets. The overlay
   * should ask once the eyes have held a fixation for about 600 ms near targets (fixationMs),
   * rather than waiting for a dwell to finish on a target too small to hold.
   */
  precision(targets: readonly Target[], displays?: readonly ScreenRect[]): PrecisionDecision {
    const p = this.lastPoint;
    if (!p) return { kind: "direct", targetId: null };
    const ds = displays ?? this.o.screen.displays.map((d) => d.bounds);
    return decidePrecision(p, this.errorSigmaPt, targets, ds, { ...DEFAULT_PRECISION, ...this.o.precision });
  }

  /**
   * A dwell (or picker choice) selected this target. Feeds continuous recalibration; the
   * selection is learned only if it isn't undone within a few seconds.
   */
  selection(targetId: string, rect: ScreenRect, t: number, dwellStartT: number): void {
    const pace = this.pace.selected(t, t - dwellStartT);
    if (pace) this.advise(pace);
    if (!this.continuous || this.mode !== "gaze") return;
    const obs = this.observations.filter((o) => o.t >= dwellStartT + 250 && o.t <= t);
    for (const e of this.continuous.selected(targetId, t, rect, obs))
      this.advise({ type: "continuous", event: e });
  }

  undo(targetId: string, t: number): void {
    const pace = this.pace.undone(t);
    if (pace) this.advise(pace);
    if (!this.continuous) return;
    for (const e of this.continuous.undone(targetId, t)) this.advise({ type: "continuous", event: e });
  }

  stats(): { fps: number; latencyP50Ms: number | null; latencyP95Ms: number | null } {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const q = (p: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null;
    return { fps: this.frameTimes.length, latencyP50Ms: q(0.5), latencyP95Ms: q(0.95) };
  }

  /** Process one provider frame. Synchronous, so replays and tests are deterministic. */
  handle(f: ProviderFrame): void {
    if (f.kind === "pointer") this.handlePointer(f.frame);
    else this.handleFace(f.frame);
  }

  private countFrame(t: number, captureT: number | undefined): number | null {
    this.frameTimes.push(t);
    while (this.frameTimes.length && t - this.frameTimes[0]! > 1000) this.frameTimes.shift();
    if (captureT === undefined) return null;
    const now = this.o.clock ? this.o.clock() : t;
    const latency = now - captureT;
    if (latency >= 0 && latency < 5000) {
      this.latencies.push(latency);
      if (this.latencies.length > 300) this.latencies.shift();
      return latency;
    }
    return null;
  }

  private handlePointer(p: PointerFrame): void {
    const latencyMs = this.countFrame(p.t, p.captureT);
    const clamped = this.o.screen.clamp(p.x, p.y);
    let point = { x: clamped.x, y: clamped.y };
    let fixation = true;
    let smoothed: SmoothedPoint | null = null;
    if (p.source === "external-tracker") {
      smoothed = this.pointerSmoother.update(p.t, clamped.x, clamped.y);
      point = this.o.screen.clamp(smoothed.x, smoothed.y);
      fixation = smoothed.fixation;
    } else {
      // Mouse: pass through. "Fixation" = it hasn't moved more than a few points recently.
      const prev = this.lastPoint;
      fixation = !!prev && Math.hypot(prev.x - point.x, prev.y - point.y) < 6;
    }
    const confidence = smoothed ? sampleConfidence(p.confidence, smoothed, 0) : p.confidence;
    this.lastPoint = { x: point.x, y: point.y };
    const state = this.tracking.update(p.t, confidence);
    if (state) this.emit({ type: "tracking", t: p.t, state });
    this.emit({
      type: "sample",
      sample: { t: p.t, x: point.x, y: point.y, confidence, fixation, source: p.source },
    });
    this.publishDetail({
      t: p.t,
      face: false,
      features: null,
      blink: null,
      trackingConfidence: p.confidence,
      confidence,
      issues: [],
      raw: { x: p.x, y: p.y },
      point,
      smoothed,
      help: { counted: 0, closed: false, holdProgress: 0, fired: false },
      posture: null,
      errorRadiusPt: this.errorRadiusPt,
      latencyMs,
    });
  }

  private handleFace(frame: FaceFrame): void {
    const t = frame.t;
    for (const l of this.faceListeners) l(frame);
    const latencyMs = this.countFrame(t, frame.captureT);
    const features = frame.landmarks
      ? extractFeatures(frame.landmarks, frame.aspect, frame.matrix ?? undefined)
      : null;
    const face = !!frame.landmarks;
    this.governor.observe(t, face);
    this.provider?.setTargetFps?.(this.governor.targetFps(t));

    let blink = frame.blink ?? null;
    if (blink === null && features) blink = this.opennessBlink.score(features.openness);
    if (!face) blink = null;

    // --- Lifeline's help pattern: always, first. -------------------------------------------
    const help = this.help.update(t, face ? blink : null);
    if (help.fired) {
      this.emit({ type: "help-signal", t });
    }
    if (help.counted !== this.lastHelpCount) {
      this.lastHelpCount = help.counted;
      this.emit({ type: "help-progress", t, counted: help.counted });
    }

    this.emit({ type: "blink", t, score: blink, face });
    if (this.o.blinkSwitch) {
      const sw = this.blinkSwitch.update(t, face ? blink : null);
      if (sw.fired) this.emit({ type: "switch", t, source: "blink" });
    }

    const tracking = trackingConfidence(features, blink);
    const issues = assessFace(features);
    const light = assessBrightness(frame.brightness ?? null);
    if (light) issues.push(light);
    if (features?.irisDiameter) {
      this.irisWindow.push(features.irisDiameter);
      if (this.irisWindow.length > 90) this.irisWindow.shift();
      if (this.irisWindow.length % 30 === 0) {
        const d = viewingDistanceCm(this.irisWindow, this.geometry);
        if (d) this.smoother.setOptions({ distanceCm: d });
      }
    }

    this.run?.frame(t, features, tracking, blink);
    this.continuousTick(t);

    // --- Pointer estimate ---------------------------------------------------------------------
    let raw: { x: number; y: number } | null = null;
    let smoothed: SmoothedPoint | null = null;
    let point: { x: number; y: number } | null = null;
    let source: InputSource = "webcam-gaze";
    let touchUp: { est: { x: number; y: number } | null; z: number[] } = { est: null, z: [0, 0, 0, 0, 0] };
    if (features && tracking >= 0.5) {
      if (this.mode === "head") {
        source = "webcam-head";
        raw = this.headPointer.update(t, features.pose);
        point = this.o.screen.clamp(raw.x, raw.y);
      } else if (this.calibrationResult) {
        const input = gazeInput(features);
        this.postureFrame(t, input);
        const est = predictBlend(
          predictModel(this.calibrationResult.model, input),
          this.calibrationResult.appearance,
          frame.eyes,
          this.calibrationResult.offset,
        );
        const z = headDelta(this.head, input);
        touchUp = { est, z };
        if (est) {
          this.observations.push({ t, x: est.x, y: est.y, z });
          while (this.observations.length && t - this.observations[0]!.t > 6000) this.observations.shift();
          raw = this.continuous ? this.continuous.apply(est.x, est.y, z) : est;
          smoothed = this.smoother.update(t, raw.x, raw.y);
          point = this.o.screen.clamp(smoothed.x, smoothed.y);
        }
      }
    } else if (this.mode === "head") {
      source = "webcam-head";
    }

    // Every face frame moves the touch-up's clock on, usable or not (eyes closed through it: it fails).
    this.touchUpFrame(t, touchUp.est, touchUp.z, tracking, blink);

    const outside = point ? this.o.screen.outsideCalibrated(raw?.x ?? point.x, raw?.y ?? point.y) : 0;
    let confidence = point ? sampleConfidence(tracking, smoothed, outside) : 0;
    if (!point && this.lastPoint && (this.mode === "head" || this.calibrationResult)) {
      // Hold the last position (blink, brief loss) with low confidence so dwell pauses.
      point = this.lastPoint;
      confidence = Math.min(confidence, tracking, 0.3);
    }
    const state = this.tracking.update(t, point ? confidence : tracking >= 0.5 ? 0.5 : 0);
    if (state) this.emit({ type: "tracking", t, state });
    if (point) {
      this.lastPoint = point;
      this.emit({
        type: "sample",
        sample: {
          t,
          x: point.x,
          y: point.y,
          confidence,
          fixation: this.mode === "head" ? true : (smoothed?.fixation ?? false),
          source,
        },
      });
    }
    this.publishDetail({
      t,
      face,
      features,
      blink,
      trackingConfidence: tracking,
      confidence,
      issues,
      raw,
      point,
      smoothed,
      help,
      posture: this.mode === "gaze" ? this.posture.current : null,
      errorRadiusPt: this.errorRadiusPt,
      latencyMs,
    });
  }

  private postureFrame(t: number, input: GazeInput): void {
    const changed = this.posture.update(t, input.normalized ? poseOf(input) : null, this.head?.ref ?? null);
    if (changed === undefined) return;
    this.advise({ type: "posture", t, issue: changed, message: changed ? POSTURE_MESSAGES[changed] : null });
  }

  private continuousTick(t: number): void {
    if (!this.continuous) return;
    for (const e of this.continuous.tick(t)) {
      this.advise({ type: "continuous", event: e });
      if (e.type === "recalibrate") this.advise({ type: "recalibrate", t: e.t, reason: e.reason });
      if (e.type === "touch-up") this.advise({ type: "touch-up", t: e.t, reason: e.reason });
      if (e.type === "quality" && this.calibrationResult) {
        const q = this.calibrationResult.quality;
        const shown = this.liveGrade ?? q.grade;
        if (e.point.grade !== shown) {
          this.liveGrade = e.point.grade;
          // Report the live quality honestly, in the contract's shape.
          const live: CalibrationQuality = {
            grade: e.point.grade,
            meanErrorPt: e.point.errorPt,
            meanErrorDeg:
              q.meanErrorDeg === null
                ? null
                : (q.meanErrorDeg * e.point.errorPt) / Math.max(q.meanErrorPt, 1),
            points: q.points,
            at: new Date().toISOString(),
          };
          this.emit({ type: "calibration", quality: live });
        }
      }
    }
  }

  private publishDetail(d: FrameDetail): void {
    this.lastDetail = d;
    for (const l of this.detailListeners) l(d);
  }
}
