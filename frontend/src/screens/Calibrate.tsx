import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionTarget } from "../../../os/gaze/src/calibration/session";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import { useInput } from "../state/input";
import { usePreferences } from "../state/preferences";
import { navigate } from "../state/router";
import { type StoredCalibration, describeError, worstError } from "../vision/calibrationStore";

/** Time for the eyes to land on a new dot before its frames count. */
const SETTLE_MS = 800;
const COLLECT_MS = 1100;
const MAX_COLLECT_MS = 2600;
/** Slow cameras get up to this long per dot to collect MIN_SAMPLES frames. */
const HARD_MAX_COLLECT_MS = 8000;
const MIN_SAMPLES = 10;

type Phase =
  | { kind: "intro" }
  | { kind: "running"; target: SessionTarget; collecting: boolean }
  | { kind: "result"; calibration: StoredCalibration }
  | { kind: "failed"; message: string };

/**
 * Eye calibration with the gaze engine's calibration v2 (os/gaze/src/calibration/session.ts): 9
 * training dots, a few more where the model is weakest, then check dots it never trained on. The
 * grade shown is the error on those check dots, so it doesn't flatter the model.
 */
export function Calibrate() {
  const input = useInput();
  const { update } = usePreferences();
  const announce = useAnnounce();
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const [countdown, setCountdown] = useState(5);
  const [faceVisible, setFaceVisible] = useState(false);
  const [remember, setRemember] = useState(false);
  const [hitCell, setHitCell] = useState<number | null>(null);
  const cancelled = useRef(false);
  const { vision, setSuspended, setCalibration } = input;
  const running = input.status === "running";
  const head = input.mode === "head";

  // Hands-free selection is off during the countdown and while the dots are shown; it comes back for
  // the result. Every screen here covers the app, so only its own buttons are dwell targets.
  const suspend = running && !head && (phase.kind === "intro" || phase.kind === "running");
  useEffect(() => {
    setSuspended(suspend);
    return () => setSuspended(false);
  }, [suspend, setSuspended]);

  useEffect(() => vision.onFrame((f) => setFaceVisible(!!f.features)), [vision]);

  const stop = useCallback(() => {
    cancelled.current = true;
    vision.cancelCalibration();
  }, [vision]);

  const run = useCallback(async () => {
    cancelled.current = false;
    const session = vision.startCalibration();
    for (;;) {
      if (cancelled.current) return;
      const step = session.next();
      if (step.kind === "failed") {
        vision.cancelCalibration();
        setPhase({ kind: "failed", message: step.reason });
        return;
      }
      if (step.kind === "done") {
        const calibration = vision.finishCalibration(step.result);
        // Apply for this session straight away so the result screen can be used hands-free.
        setCalibration(calibration, false);
        setPhase({ kind: "result", calibration });
        announce(`Calibration finished. Accuracy: ${calibration.result.quality.grade}.`);
        return;
      }
      const target = step.target;
      setPhase({ kind: "running", target, collecting: false });
      const settled = window.setTimeout(() => {
        if (!cancelled.current) setPhase({ kind: "running", target, collecting: true });
      }, SETTLE_MS);
      // On a slow camera (or a slow computer) give each dot time for MIN_SAMPLES frames, up to a cap.
      const msPerFrame = 1000 / Math.max(1, vision.stats.fps || 15);
      const maxMs = Math.max(MAX_COLLECT_MS, Math.min(HARD_MAX_COLLECT_MS, msPerFrame * MIN_SAMPLES * 1.5));
      let timer = 0;
      // Never wait on frames forever: a stalled camera still moves on.
      const stalled = new Promise<null>((resolve) => {
        timer = window.setTimeout(() => resolve(null), SETTLE_MS + maxMs + 1500);
      });
      const got = await Promise.race([
        session.collect(target.id, {
          settleMs: SETTLE_MS,
          collectMs: COLLECT_MS,
          maxMs,
          minSamples: MIN_SAMPLES,
        }),
        stalled,
      ]);
      window.clearTimeout(timer);
      window.clearTimeout(settled);
      if (cancelled.current) return;
      if (got === null) {
        // No frames arrived for this dot: it counts as missed and is shown once more at the end.
        session.cancel();
        session.session.addSamples(target.id, []);
      }
    }
  }, [vision, setCalibration, announce]);

  // Start automatically after a short countdown once a face is visible, so someone who
  // can only use their eyes doesn't need to press anything.
  useEffect(() => {
    if (phase.kind !== "intro" || !running || !faceVisible || head) {
      setCountdown(5);
      return;
    }
    if (countdown <= 0) {
      void run();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase.kind, running, faceVisible, countdown, run, head]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        stop();
        navigate("/camera");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stop();
    };
  }, [stop]);

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

  if (!running) {
    return (
      <div className="calibration welcome" data-dwell-scope="modal">
        <div className="welcome-card panel stack">
          <h1>The camera needs to be on to calibrate</h1>
          <button className="btn btn-xl btn-primary" onClick={() => navigate("/camera")} data-dwell>
            <Icon name="camera" /> Go to camera setup
          </button>
        </div>
      </div>
    );
  }

  if (head) {
    return (
      <div className="calibration welcome" data-dwell-scope="modal">
        <div className="welcome-card panel stack" style={{ maxWidth: 820 }}>
          <h1>The head pointer doesn&apos;t need calibrating</h1>
          <p>
            It starts from wherever your head points. If the pointer sits off to one side, point your nose at
            the middle of the screen and centre it.
          </p>
          <div className="grid grid-2">
            <button
              className="btn btn-xl btn-primary"
              data-dwell
              onClick={() => {
                vision.recentre();
                announce("Head pointer centred.");
                navigate("/");
              }}
            >
              <Icon name="target" /> Centre it and go Home
            </button>
            <button className="btn btn-xl" data-dwell onClick={() => navigate("/camera")}>
              <Icon name="camera" /> Camera setup
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === "intro") {
    return (
      <div className="calibration welcome" data-dwell-scope="modal">
        <div className="welcome-card panel stack" style={{ maxWidth: 820 }}>
          <div className="eyebrow">Calibration · about 13 dots · about 30 seconds</div>
          <h1>Look at each dot until it moves</h1>
          <p>
            Keep your head as still as is comfortable and follow the dot with your eyes. The last few dots
            check how accurate the calibration is on places it didn&apos;t learn from, so AGENCY knows how
            much to trust it. Webcam tracking is approximate, so AGENCY uses large targets.
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
    const t = phase.target;
    return (
      <div className="calibration" role="dialog" aria-label="Calibration in progress">
        <div className="cal-hud">
          <span aria-live="polite">
            Dot {t.index} of {t.total}
            {t.phase === "validate" ? " · checking accuracy" : ""}
          </span>
          <button
            className="btn"
            onClick={() => {
              stop();
              navigate("/camera");
            }}
          >
            Cancel (Esc)
          </button>
        </div>
        <div
          className="cal-target"
          data-collecting={phase.collecting}
          style={{ left: `${t.x}px`, top: `${t.y}px` }}
          aria-hidden="true"
        >
          <span />
        </div>
      </div>
    );
  }

  if (phase.kind === "failed") {
    return (
      <div className="calibration welcome" data-dwell-scope="modal">
        <div className="welcome-card panel panel-danger stack" style={{ maxWidth: 820 }}>
          <h1>Calibration didn&apos;t work</h1>
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

  const { calibration } = phase;
  const r = calibration.result;
  const q = r.quality;
  const message =
    q.grade === "good"
      ? "Good. Dwell selection should work well with AGENCY's large buttons."
      : q.grade === "fair"
        ? "Fair. Dwell selection should work, but you may need to look at the middle of buttons. Target snapping helps."
        : "Not reliable enough for dwell selection. I recommend blink scanning or the head pointer; you can also try again with better light.";

  return (
    <div className="calibration" style={{ overflow: "auto" }} data-dwell-scope="modal">
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
            <h3>Measured on dots it didn&apos;t train on</h3>
            <p>
              Average error {describeError(calibration)} (worst {worstError(calibration)} px), from{" "}
              {r.trainingTargets} training dots and {r.validation.length} check dots. It keeps improving as
              you use it: each choice you don&apos;t undo corrects small drifts.
            </p>
            <p className="small muted">
              This is a webcam estimate, not a medical-grade eye tracker. It&apos;s stored only in this
              browser
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
            input.setCalibration(calibration, remember);
            announce("Calibration saved.");
            navigate("/");
          }}
        >
          <Icon name="check" /> Use this calibration
        </button>
      </div>
    </div>
  );
}
