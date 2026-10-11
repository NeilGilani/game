import { useCallback, useEffect, useRef, useState } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { showScanResult } from "../components/ScanResultBanner";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import { useInput } from "../state/input";
import { usePreferences } from "../state/preferences";
import { navigate } from "../state/router";
import { type StoredCalibration, describeError, describeEyeModel } from "../vision/calibrationStore";

/** Estimated error above which the scan says so and offers another go (px; "poor" starts at 128). */
const ROUGH_ERROR_PT = 180;

type Phase =
  | { kind: "intro" }
  | { kind: "scanning" }
  | { kind: "rough"; calibration: StoredCalibration }
  | { kind: "failed"; message: string };

/**
 * The 5-second eye scan (os/gaze/src/calibration/pursuit.ts): one light glides around the screen
 * and the person follows it with their eyes. That's the only setup. It is remembered on this
 * device, and keeps improving from everyday choices (continuous recalibration in the engine).
 */
export function Calibrate() {
  const input = useInput();
  const { update } = usePreferences();
  const announce = useAnnounce();
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const [countdown, setCountdown] = useState(3);
  const [faceVisible, setFaceVisible] = useState(false);
  const light = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false);
  const { vision, setSuspended, setCalibration } = input;
  const running = input.status === "running";
  const head = input.mode === "head";

  // Hands-free selection is off during the countdown and the scan. Every screen here covers the
  // app, so only its own buttons are dwell targets.
  const suspend = running && !head && (phase.kind === "intro" || phase.kind === "scanning");
  useEffect(() => {
    setSuspended(suspend);
    return () => setSuspended(false);
  }, [suspend, setSuspended]);

  useEffect(() => vision.onFrame((f) => setFaceVisible(!!f.features)), [vision]);

  const stop = useCallback(() => {
    cancelled.current = true;
    vision.cancelCalibration();
  }, [vision]);

  const goHome = useCallback(() => {
    navigate("/");
    // The eyes end on whatever sits in the middle of Home: give them time to look around first.
    window.dispatchEvent(new CustomEvent(SELECTION_RESET_EVENT, { detail: { holdMs: 3000 } }));
  }, []);

  const scan = useCallback(() => {
    cancelled.current = false;
    setPhase({ kind: "scanning" });
    const eyeScan = vision.startEyeScan();
    const start = performance.now();
    const off = vision.onFrame((f) =>
      eyeScan.add(f.t - start, f.features, f.trackingConfidence, f.blink, f.eyes),
    );
    const draw = () => {
      if (cancelled.current) {
        off();
        return;
      }
      const ms = performance.now() - start;
      const p = eyeScan.at(ms);
      if (light.current) light.current.style.transform = `translate(${p.x}px, ${p.y}px)`;
      if (ms < eyeScan.durationMs) {
        requestAnimationFrame(draw);
        return;
      }
      off();
      const step = eyeScan.finish();
      if (step.kind !== "done") {
        vision.cancelCalibration();
        setPhase({ kind: "failed", message: step.kind === "failed" ? step.reason : "Please try again." });
        return;
      }
      const calibration = vision.finishCalibration(step.result);
      setCalibration(calibration, true);
      console.info(
        "[AGENCY] eye scan:",
        describeEyeModel(calibration),
        step.result.realEye ?? "no eye images",
      );
      if (calibration.result.quality.meanErrorPt > ROUGH_ERROR_PT) {
        // Say so instead of quietly using a scan that will feel random; it still works on big tiles.
        setPhase({ kind: "rough", calibration });
        announce(
          "Eye tracking is rough right now. You can scan again with better light, or use it as it is.",
        );
        return;
      }
      showScanResult({ model: describeEyeModel(calibration), error: describeError(calibration) });
      announce("Done. Look at anything for a second to choose it.");
      goHome();
    };
    requestAnimationFrame(draw);
  }, [vision, setCalibration, announce, goHome]);

  // Starts by itself once a face is visible: nothing to press for someone who can only move their eyes.
  useEffect(() => {
    if (phase.kind !== "intro" || !running || !faceVisible || head) {
      setCountdown(3);
      return;
    }
    if (countdown <= 0) {
      scan();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase.kind, running, faceVisible, countdown, scan, head]);

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

  if (!running) {
    return (
      <div className="calibration welcome" data-dwell-scope="modal">
        <div className="welcome-card panel stack">
          <h1>The camera needs to be on to learn your eyes</h1>
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
          <h1>The head pointer doesn&apos;t need any setup</h1>
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
          <div className="eyebrow">Eye scan · 5 seconds · only once</div>
          <h1>Follow the light with your eyes</h1>
          <p>
            A light glides around the screen. Follow it with your eyes, keeping your head comfortably still.
            That&apos;s all: AGENCY learns how your eyes move and keeps getting better as you use it.
          </p>
          <p aria-live="polite">
            <strong>
              {faceVisible ? `Starting in ${countdown}…` : "Waiting until your face and eyes are visible…"}
            </strong>
          </p>
          <div className="row">
            <button className="btn btn-primary" onClick={scan} disabled={!faceVisible}>
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

  if (phase.kind === "scanning") {
    return (
      <div className="calibration" role="dialog" aria-label="Eye scan in progress">
        <div className="cal-hud">
          <span aria-live="polite">Follow the light</span>
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
          ref={light}
          className="cal-target cal-light"
          data-collecting="true"
          style={{
            left: 0,
            top: 0,
            transform: `translate(${window.innerWidth / 2}px, ${window.innerHeight / 2}px)`,
          }}
          aria-hidden="true"
        >
          <span />
        </div>
      </div>
    );
  }

  if (phase.kind === "rough") {
    return (
      <div className="calibration welcome" data-dwell-scope="modal">
        <div className="welcome-card panel stack" style={{ maxWidth: 860 }}>
          <div className="eyebrow">Eye scan · rough</div>
          <h1>Tracking is rough in these conditions</h1>
          <p>
            Estimated error {describeError(phase.calibration)}. It still works on the big tiles and improves
            as you use it. For a sharper scan:
          </p>
          <p>
            <strong>Eye model:</strong> {describeEyeModel(phase.calibration)}
          </p>
          <ul className="list">
            <li>Light on your face, not behind you.</li>
            <li>Sit a little closer: the bigger your face is to the camera, the steadier the pointer.</li>
            <li>Glasses: tilt them slightly if the lenses reflect the screen.</li>
          </ul>
          <div className="grid grid-2">
            <button className="btn btn-xl btn-primary" onClick={() => setPhase({ kind: "intro" })} data-dwell>
              <Icon name="refresh" /> Scan again
            </button>
            <button className="btn btn-xl" onClick={goHome} data-dwell>
              <Icon name="check" /> Use it as it is
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="calibration welcome" data-dwell-scope="modal">
      <div className="welcome-card panel panel-danger stack" style={{ maxWidth: 820 }}>
        <h1>The eye scan didn&apos;t work</h1>
        <p>{phase.message}</p>
        <div className="grid grid-2">
          <button className="btn btn-xl btn-primary" onClick={() => setPhase({ kind: "intro" })} data-dwell>
            <Icon name="refresh" /> Try again
          </button>
          <button
            className="btn btn-quiet"
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
