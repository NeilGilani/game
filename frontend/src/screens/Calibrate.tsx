import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import { featureSetFor, useInput } from "../state/input";
import { usePreferences } from "../state/preferences";
import { navigate } from "../state/router";
import {
  CalibrationError,
  type CalibrationModel,
  type CalibrationSample,
  type CalibrationTarget,
  calibrationTargets,
  featureVector,
  fitCalibration,
} from "../vision/calibration";
import type { VisionFrame } from "../vision/tracker";

const SETTLE_MS = 800;
const COLLECT_MS = 1100;
const MAX_COLLECT_MS = 2600;
const MIN_SAMPLES = 10;

type Phase =
  | { kind: "intro" }
  | { kind: "running"; index: number; collecting: boolean }
  | { kind: "result"; model: CalibrationModel; skipped: number }
  | { kind: "failed"; message: string };

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function Calibrate() {
  const input = useInput();
  const { update } = usePreferences();
  const announce = useAnnounce();
  const set = featureSetFor(input.mode) ?? "gaze";
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const [countdown, setCountdown] = useState(5);
  const [faceVisible, setFaceVisible] = useState(false);
  const [remember, setRemember] = useState(false);
  const [hitCell, setHitCell] = useState<number | null>(null);
  const cancelled = useRef(false);
  const { vision, setSuspended, setCalibration } = input;
  const running = input.status === "running";

  // Hand-free selection is off while the dots are shown; it comes back for the result screen.
  useEffect(() => {
    setSuspended(phase.kind !== "result" && phase.kind !== "failed");
    return () => setSuspended(false);
  }, [phase.kind, setSuspended]);

  useEffect(() => vision.onFrame((f) => setFaceVisible(!!f.features)), [vision]);

  const run = useCallback(async () => {
    cancelled.current = false;
    const targets = calibrationTargets();
    const samples: CalibrationSample[] = [];
    let skipped = 0;
    for (let index = 0; index < targets.length; index++) {
      if (cancelled.current) return;
      const target = targets[index]!;
      setPhase({ kind: "running", index, collecting: false });
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      if (cancelled.current) return;
      setPhase({ kind: "running", index, collecting: true });
      const collected = await new Promise<number[][]>((resolve) => {
        const got: number[][] = [];
        const start = performance.now();
        const off = vision.onFrame((f: VisionFrame) => {
          if (f.features && f.confidence >= 0.5 && (f.blink ?? 0) < 0.4)
            got.push(featureVector(f.features, set));
          const elapsed = performance.now() - start;
          if (
            (elapsed > COLLECT_MS && got.length >= MIN_SAMPLES) ||
            elapsed > MAX_COLLECT_MS ||
            cancelled.current
          ) {
            off();
            resolve(got);
          }
        });
      });
      if (collected.length < MIN_SAMPLES) skipped += 1;
      else for (const features of collected) samples.push({ target, features });
    }
    try {
      const model = fitCalibration(samples, set, { width: window.innerWidth, height: window.innerHeight });
      // Apply for this session straight away so the result screen can be used hands-free.
      setCalibration(model, false);
      setPhase({ kind: "result", model, skipped });
      announce(`Calibration finished. Quality: ${model.quality.grade}.`);
    } catch (err) {
      setPhase({
        kind: "failed",
        message:
          err instanceof CalibrationError
            ? err.message
            : "Calibration couldn't be completed. Please try again.",
      });
    }
  }, [vision, set, setCalibration, announce]);

  // Start automatically after a short countdown once a face is visible, so someone who
  // can only use their eyes doesn't need to press anything.
  useEffect(() => {
    if (phase.kind !== "intro" || !running || !faceVisible) {
      setCountdown(5);
      return;
    }
    if (countdown <= 0) {
      void run();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase.kind, running, faceVisible, countdown, run]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelled.current = true;
        navigate("/camera");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelled.current = true;
    };
  }, []);

  // Live test on the result screen: which ninth of the screen is the pointer in?
  useEffect(() => {
    if (phase.kind !== "result") return;
    return vision.onFrame((f) => {
      if (!f.pointer) return setHitCell(null);
      const col = Math.min(2, Math.floor((f.pointer.x / window.innerWidth) * 3));
      const row = Math.min(2, Math.floor((f.pointer.y / window.innerHeight) * 3));
      setHitCell(row * 3 + col);
    });
  }, [phase.kind, vision]);

  const targets = calibrationTargets();

  if (!running) {
    return (
      <div className="calibration welcome">
        <div className="welcome-card panel stack">
          <h1>The camera needs to be on to calibrate</h1>
          <button className="btn btn-xl btn-primary" onClick={() => navigate("/camera")} data-dwell>
            <Icon name="camera" /> Go to camera setup
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "intro") {
    return (
      <div className="calibration welcome">
        <div className="welcome-card panel stack" style={{ maxWidth: 820 }}>
          <div className="eyebrow">Calibration · 9 dots · about 20 seconds</div>
          <h1>{set === "head" ? "Point your nose at each dot" : "Look at each dot until it moves"}</h1>
          <p>
            {set === "head"
              ? "Move your head gently so your nose points at each dot."
              : "Keep your head as still as is comfortable and follow the dot with your eyes."}{" "}
            Webcam tracking is approximate, so AGENCY uses large targets and measures how accurate this
            calibration is before relying on it.
          </p>
          <p aria-live="polite">
            <strong>
              {faceVisible ? `Starting in ${countdown}…` : "Waiting until your face and eyes are visible…"}
            </strong>
          </p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => void run()} disabled={!faceVisible}>
              <Icon name="play" /> Start now
            </button>
            <button className="btn" onClick={() => navigate("/camera")}>
              Cancel (Esc)
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === "running") {
    const t: CalibrationTarget = targets[phase.index]!;
    return (
      <div className="calibration" role="dialog" aria-label="Calibration in progress">
        <div className="cal-hud">
          <span aria-live="polite">
            Dot {phase.index + 1} of {targets.length}
          </span>
          <button
            className="btn"
            onClick={() => {
              cancelled.current = true;
              navigate("/camera");
            }}
          >
            Cancel (Esc)
          </button>
        </div>
        <div
          className="cal-target"
          data-collecting={phase.collecting}
          style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%` }}
          aria-hidden="true"
        >
          <span />
        </div>
      </div>
    );
  }

  if (phase.kind === "failed") {
    return (
      <div className="calibration welcome">
        <div className="welcome-card panel panel-danger stack" style={{ maxWidth: 820 }}>
          <h1>Calibration didn't work</h1>
          <p>{phase.message}</p>
          <div className="grid grid-2">
            <button className="btn btn-xl btn-primary" onClick={() => setPhase({ kind: "intro" })} data-dwell>
              <Icon name="refresh" /> Try again
            </button>
            <button
              className="btn btn-xl"
              data-dwell
              onClick={() => {
                update({ input_mode: "scan_blink" });
                navigate("/");
              }}
            >
              <Icon name="blink" /> Use blink scanning
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { model, skipped } = phase;
  const q = model.quality;
  const message =
    q.grade === "good"
      ? "Good. Dwell selection should work well with AGENCY's large buttons."
      : q.grade === "fair"
        ? "Fair. Dwell selection should work, but you may need to look at the middle of buttons. Target snapping helps."
        : "Not reliable enough for dwell selection. I recommend blink scanning or the head pointer; you can also try again with better light.";

  return (
    <div className="calibration" style={{ overflow: "auto" }}>
      <div className="page" style={{ padding: 28 }}>
        <div className="page-head">
          <div>
            <div className="eyebrow">Calibration result</div>
            <h1>Accuracy: {q.grade}</h1>
            <p>{message}</p>
          </div>
          <div className="quality-meter" data-grade={q.grade} style={{ width: 220 }} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="grid grid-2">
          <section className="panel stack">
            <h3>Measured on targets it didn't train on</h3>
            <p>
              Average error {pct(q.meanError)} of the screen (worst {pct(q.maxError)}). Model: {model.basis},{" "}
              {set === "head" ? "head pose" : "iris position + head pose"}.
              {skipped > 0 &&
                ` ${skipped} dot${skipped > 1 ? "s" : ""} had too little usable data and were skipped.`}
            </p>
            <p className="small muted">
              This is a webcam estimate, not a medical-grade eye tracker. It's stored only in this browser
              {remember ? " (remembered on this device)" : " for this session"}.
            </p>
            <label className="row">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember this calibration on this device
            </label>
          </section>
          <section className="panel stack" aria-label="Try it">
            <h3>Try it: look around the screen</h3>
            <div className="test-grid">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="test-cell" data-hit={hitCell === i}>
                  {hitCell === i ? "Here" : ""}
                </div>
              ))}
            </div>
          </section>
        </div>
        <div className="grid grid-3">
          <button className="btn btn-xl" onClick={() => setPhase({ kind: "intro" })} data-dwell>
            <Icon name="refresh" /> Calibrate again
          </button>
          <button
            className="btn btn-xl"
            data-dwell
            onClick={() => {
              update({ input_mode: "scan_blink" });
              navigate("/");
            }}
          >
            <Icon name="blink" /> Use blink scanning
          </button>
          <button
            className="btn btn-xl btn-primary"
            data-dwell
            onClick={() => {
              input.setCalibration(model, remember);
              announce("Calibration saved.");
              navigate("/");
            }}
          >
            <Icon name="check" /> Use this calibration
          </button>
        </div>
      </div>
    </div>
  );
}
