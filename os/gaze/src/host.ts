/**
 * Engine host: everything the hidden engine window needs, behind two functions.
 *
 *   const host = startEngineHost({ displays, send: (m) => window.agency.gaze.emit(m) });
 *   window.agency.gaze.onCommand((c) => host.command(c));
 *
 * `send` receives contract GazeEvents (forward on IPC.gaze) plus a few host messages (calibration
 * steps for the shell's calibration screen, precision decisions, advice, status). Commands come
 * from the main process (shell or overlay requests). The message and command shapes are
 * proposed for os/contracts in os/gaze/INTEGRATION_REQUEST.md; until then they live here.
 *
 * Lifeline first: the help pattern runs inside the engine on every face frame; no command here
 * can disable it. Stopping the camera is the only thing that stops it, and the host reports that.
 */

import type { CalibrationResult, SessionStep, SessionTarget } from "./calibration/session";
import type { CalibrationQuality, GazeEvent, ScreenRect, Target } from "./contracts";
import { type EngineAdvice, type EngineMode, type EngineOptions, GazeEngine } from "./engine";
import type { PrecisionDecision } from "./precision";
import { MouseProvider } from "./providers/mouse";
import { ReplayProvider } from "./providers/replay";
import type { GazeProvider } from "./providers/types";
import { type FrameScheduler, type LandmarkerFactory, WebcamProvider } from "./providers/webcam";
import { type Recording, Recorder, isRecording } from "./record";
import { type DisplayInfo, ScreenSpace } from "./screen";

export type GazeCommand =
  | { type: "provider"; provider: "webcam" | "mouse" | "none" }
  | { type: "provider"; provider: "replay"; recording: Recording; loop?: boolean }
  | { type: "displays"; displays: DisplayInfo[] }
  | { type: "mode"; mode: EngineMode }
  | { type: "paused"; paused: boolean }
  | { type: "blink-switch"; on: boolean; holdMs?: number }
  | { type: "recentre-head" }
  /** Mouse provider input from the main process (screen.getCursorScreenPoint()). */
  | { type: "mouse"; x: number; y: number; t?: number }
  | { type: "calibration.start"; maxPoints?: number; validationPoints?: number }
  /** The shell shows `targetId` now; collect frames for it. */
  | { type: "calibration.collect"; targetId: string; settleMs?: number; collectMs?: number }
  /** Skip the remaining dots of this phase (the person is tired). */
  | { type: "calibration.skip" }
  | { type: "calibration.cancel" }
  | { type: "calibration.forget" }
  | { type: "selection"; targetId: string; rect: ScreenRect; t: number; dwellStartT: number }
  | { type: "undo"; targetId: string; t: number }
  | { type: "precision"; requestId: string; targets: Target[] }
  /** Opt-in only: the person chose to record landmarks (never video) on this Mac. */
  | { type: "record.start"; consent: true; note?: string }
  | { type: "record.stop" };

/** Serializable calibration step for the shell's calibration screen. */
export type CalibrationStepMessage =
  | { kind: "target"; target: SessionTarget }
  | {
      kind: "done";
      quality: CalibrationQuality;
      cvErrorPt: number;
      precisionPt: number;
      distanceCm: number | null;
    }
  | { kind: "failed"; reason: string };

export type HostMessage =
  | GazeEvent
  | {
      type: "host.status";
      provider: string;
      status: string;
      error: string | null;
      delegate: "GPU" | "CPU" | null;
    }
  | { type: "host.calibration"; step: CalibrationStepMessage }
  | { type: "host.precision"; requestId: string; decision: PrecisionDecision }
  | { type: "host.advice"; advice: EngineAdvice }
  | { type: "host.recording"; recording: Recording }
  | { type: "host.error"; message: string };

export interface CalibrationStore {
  load(): CalibrationResult | null;
  save(result: CalibrationResult | null): void;
}

/** localStorage in the engine window: local to this Mac, never synced. */
export function localCalibrationStore(key = "agency.gaze.calibration.v2"): CalibrationStore | null {
  if (typeof localStorage === "undefined") return null;
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CalibrationResult;
        return parsed?.model?.version === 2 && parsed.quality ? parsed : null;
      } catch {
        return null;
      }
    },
    save(result) {
      try {
        if (result) localStorage.setItem(key, JSON.stringify(result));
        else localStorage.removeItem(key);
      } catch {
        // Storage full or blocked: calibration still works for this session.
      }
    },
  };
}

export interface HostOptions {
  displays: DisplayInfo[];
  send: (message: HostMessage) => void;
  /** MediaPipe factory (providers/mediapipe.ts) for the webcam provider. */
  landmarker?: LandmarkerFactory;
  scheduler?: FrameScheduler;
  store?: CalibrationStore | null;
  engine?: Partial<Omit<EngineOptions, "screen">>;
  /** Provider to start with. Defaults to "webcam" when a landmarker is given, else "mouse". */
  initialProvider?: "webcam" | "mouse" | "none";
}

export interface EngineHost {
  engine: GazeEngine;
  command(c: GazeCommand): Promise<void>;
  stop(): void;
}

function stepMessage(step: SessionStep): CalibrationStepMessage {
  if (step.kind === "target") return { kind: "target", target: step.target };
  if (step.kind === "failed") return { kind: "failed", reason: step.reason };
  const r = step.result;
  return {
    kind: "done",
    quality: r.quality,
    cvErrorPt: r.cvErrorPt,
    precisionPt: r.precisionPt,
    distanceCm: r.distanceCm,
  };
}

export async function startEngineHost(options: HostOptions): Promise<EngineHost> {
  const send = options.send;
  const engine = new GazeEngine({ screen: new ScreenSpace(options.displays), ...options.engine });
  const store = options.store === undefined ? localCalibrationStore() : options.store;
  const saved = store?.load() ?? null;
  if (saved) engine.setCalibration(saved);
  engine.on((e) => send(e));
  engine.onAdvice((a) => send({ type: "host.advice", advice: a }));

  let mouse: MouseProvider | null = null;
  let current = "none";
  let recorder: Recorder | null = null;
  let offRecord: (() => void) | null = null;
  let run: ReturnType<GazeEngine["startCalibration"]> | null = null;

  const status = (provider: GazeProvider | null) => {
    const webcam = provider instanceof WebcamProvider ? provider : null;
    send({
      type: "host.status",
      provider: current,
      status: webcam ? webcam.status : provider ? "running" : "off",
      error: webcam?.error ?? null,
      delegate: webcam ? (webcam.stats().delegate ?? null) : null,
    });
  };

  const use = async (provider: GazeProvider | null, name: string) => {
    engine.detach();
    mouse = provider instanceof MouseProvider ? provider : null;
    current = name;
    if (provider) {
      if (provider instanceof WebcamProvider) provider.onStatus(() => status(provider));
      await engine.attach(provider);
    }
    status(provider);
  };

  const command = async (c: GazeCommand): Promise<void> => {
    try {
      switch (c.type) {
        case "provider":
          if (c.provider === "webcam") {
            if (!options.landmarker) throw new Error("No face-tracking model is configured for the camera.");
            await use(new WebcamProvider(options.landmarker, options.scheduler ?? "auto"), "webcam");
          } else if (c.provider === "mouse") await use(new MouseProvider(), "mouse");
          else if (c.provider === "replay") {
            if (!isRecording(c.recording)) throw new Error("That file is not a gaze recording.");
            await use(new ReplayProvider(c.recording, { loop: c.loop ?? false }), "replay");
          } else await use(null, "none");
          return;
        case "displays":
          engine.setScreen(new ScreenSpace(c.displays));
          return;
        case "mode":
          engine.setMode(c.mode);
          return;
        case "paused":
          engine.setPaused(c.paused);
          return;
        case "blink-switch":
          engine.setBlinkSwitch(c.on, c.holdMs ? { holdMs: c.holdMs } : undefined);
          return;
        case "recentre-head":
          engine.recentreHeadPointer();
          return;
        case "mouse":
          mouse?.push(c.x, c.y, c.t ?? performance.now());
          return;
        case "calibration.start":
          run = engine.startCalibration({
            ...(c.maxPoints ? { maxPoints: c.maxPoints } : {}),
            ...(c.validationPoints ? { validationPoints: c.validationPoints } : {}),
          });
          send({ type: "host.calibration", step: stepMessage(run.next()) });
          return;
        case "calibration.collect": {
          if (!run) throw new Error("Calibration has not started.");
          const active = run;
          await active.collect(c.targetId, { settleMs: c.settleMs ?? 800, collectMs: c.collectMs ?? 1100 });
          if (run !== active) return; // cancelled meanwhile
          const step = active.next();
          if (step.kind === "done") {
            active.apply(step.result);
            store?.save(step.result);
            engine.endCalibration();
            run = null;
          } else if (step.kind === "failed") {
            engine.endCalibration();
            run = null;
          }
          send({ type: "host.calibration", step: stepMessage(step) });
          return;
        }
        case "calibration.skip":
          if (run) {
            run.session.skipRemaining();
            send({ type: "host.calibration", step: stepMessage(run.next()) });
          }
          return;
        case "calibration.cancel":
          engine.endCalibration();
          run = null;
          return;
        case "calibration.forget":
          engine.setCalibration(null);
          store?.save(null);
          return;
        case "selection":
          engine.selection(c.targetId, c.rect, c.t, c.dwellStartT);
          return;
        case "undo":
          engine.undo(c.targetId, c.t);
          return;
        case "precision":
          send({ type: "host.precision", requestId: c.requestId, decision: engine.precision(c.targets) });
          return;
        case "record.start":
          if (c.consent !== true) throw new Error("Recording needs the person's explicit consent.");
          offRecord?.();
          recorder = new Recorder(true, { origin: "person", note: c.note ?? "" });
          offRecord = engine.onFace((f) => recorder?.add(f));
          return;
        case "record.stop":
          offRecord?.();
          offRecord = null;
          if (recorder)
            send({ type: "host.recording", recording: recorder.finish(engine.screen.cameraDisplay.bounds) });
          recorder = null;
          return;
      }
    } catch (err) {
      send({ type: "host.error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const initial = options.initialProvider ?? (options.landmarker ? "webcam" : "mouse");
  await command({ type: "provider", provider: initial });

  return {
    engine,
    command,
    stop() {
      offRecord?.();
      engine.detach();
    },
  };
}
