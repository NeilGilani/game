import { useEffect, useRef, useState } from "react";
import { ErrorNote } from "../components/common";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { Loading } from "../components/status";
import { useAnnounce } from "../state/announcer";
import { MODE_LABELS, useInput } from "../state/input";
import { usePreferences } from "../state/preferences";
import { navigate } from "../state/router";
import { BlinkSwitch } from "../vision/blink";
import { CAMERA_ERRORS } from "../vision/camera";
import { LEFT_EYE, NOSE_TIP, RIGHT_EYE } from "../vision/landmarks";
import { ISSUE_MESSAGES, type QualityIssue } from "../vision/quality";
import type { VisionFrame } from "../vision/tracker";

interface Snapshot {
  face: boolean;
  eyes: boolean;
  issues: QualityIssue[];
  confidence: number;
  blink: number | null;
}

const OVERLAY_POINTS = [
  RIGHT_EYE.outer,
  RIGHT_EYE.inner,
  RIGHT_EYE.upper,
  RIGHT_EYE.lower,
  LEFT_EYE.outer,
  LEFT_EYE.inner,
  LEFT_EYE.upper,
  LEFT_EYE.lower,
  NOSE_TIP,
];

/** Draw the tracked eye landmarks (never stored) over the mirrored preview. */
function drawOverlay(canvas: HTMLCanvasElement, frame: VisionFrame | null) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  ctx.clearRect(0, 0, w, h);
  const lm = frame?.landmarks;
  if (!lm) return;
  ctx.fillStyle = "#4fc9b0";
  for (const i of OVERLAY_POINTS) {
    const p = lm[i];
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 4 * devicePixelRatio, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#ffd54a";
  ctx.lineWidth = 3 * devicePixelRatio;
  for (const ring of [RIGHT_EYE.iris, LEFT_EYE.iris]) {
    const pts = ring.map((i) => lm[i]).filter(Boolean) as { x: number; y: number }[];
    if (pts.length < 4) continue;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const r = Math.max(...pts.map((p) => Math.hypot((p.x - cx) * w, (p.y - cy) * h)));
    ctx.beginPath();
    ctx.arc(cx * w, cy * h, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function Check({ ok, label, pending }: { ok: boolean; label: string; pending?: boolean }) {
  return (
    <li>
      <span className="badge" data-tone={pending ? "neutral" : ok ? "ok" : "warn"}>
        <Icon name={pending ? "clock" : ok ? "check" : "alert"} size={16} />
        {pending ? "Waiting" : ok ? "OK" : "Check"}
      </span>
      {label}
    </li>
  );
}

export function CameraSetup() {
  const input = useInput();
  const announce = useAnnounce();
  const { prefs, update } = usePreferences();
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [presses, setPresses] = useState(0);
  const [blinkProgress, setBlinkProgress] = useState(0);
  const { vision, status, error } = input;

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    el.prepend(vision.video);
    return () => {
      vision.video.remove();
    };
  }, [vision]);

  useEffect(() => {
    let lastUi = 0;
    const blink = new BlinkSwitch({ holdMs: prefs.blink_ms });
    return vision.onFrame((frame) => {
      if (canvas.current) drawOverlay(canvas.current, frame);
      const b = blink.update(frame.t, frame.face ? frame.blink : null);
      if (b.fired) setPresses((n) => n + 1);
      if (frame.t - lastUi > 120) {
        lastUi = frame.t;
        setBlinkProgress(b.closed ? b.progress : 0);
        setSnap({
          face: frame.face,
          eyes: !!frame.features,
          issues: frame.issues,
          confidence: frame.trackingConfidence,
          blink: frame.blink,
        });
      }
    });
  }, [vision, prefs.blink_ms]);

  const running = status === "running";
  const starting = status === "starting" || status === "loading-model";
  const issues = snap?.issues ?? [];
  const lighting = !issues.includes("too-dark") && !issues.includes("too-bright");
  const distance = !issues.includes("too-far") && !issues.includes("too-close");
  const ready = running && !!snap?.eyes && lighting && distance;
  // Eye gaze needs calibrating; the head pointer just starts from wherever the head points now.
  const needsCalibration = input.mode === "gaze";
  const headPointer = input.mode === "head";

  return (
    <Page label="Camera setup">
      <div className="page-head">
        <div>
          <div className="eyebrow">Camera · {MODE_LABELS[input.mode].long}</div>
          <h1>Set up the camera</h1>
          <p>
            Video is processed in this browser to find your face and eyes. No video, images or face data leave
            this computer or are saved.
          </p>
        </div>
      </div>

      {status === "error" && error && (
        <div className="panel panel-danger stack" role="alert">
          <h2>
            <Icon name="alert" /> {CAMERA_ERRORS[error].title}
          </h2>
          <p>{CAMERA_ERRORS[error].body}</p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => void input.startCamera()} data-dwell>
              <Icon name="refresh" /> Try again
            </button>
            <button
              className="btn"
              data-dwell
              onClick={() => {
                update({ input_mode: "scan_key" });
                navigate("/");
              }}
            >
              <Icon name="key" /> Use key-switch scanning instead
            </button>
          </div>
        </div>
      )}

      <div className="grid split">
        <div className="camera-stage" ref={stage}>
          <canvas ref={canvas} aria-hidden="true" />
          {!running && (
            <div className="placeholder">
              {starting ? (
                <Loading
                  text={status === "loading-model" ? "Loading face tracking…" : "Starting the camera…"}
                />
              ) : (
                <span>
                  <Icon name="camera" size={48} />
                  <br />
                  The camera is off.
                </span>
              )}
            </div>
          )}
        </div>

        <div className="stack">
          <section className="panel stack" aria-live="polite">
            <h2>Checks</h2>
            <ul className="checklist">
              <Check ok={running} pending={!running} label="Camera is on" />
              <Check ok={!!snap?.face} pending={!running} label="Face in view" />
              <Check ok={!!snap?.eyes} pending={!running} label="Both eyes and irises found" />
              <Check ok={lighting} pending={!running || !snap} label="Lighting" />
              <Check ok={distance} pending={!running || !snap?.face} label="Distance from screen" />
            </ul>
            {running && issues.length > 0 && (
              <ul className="list">
                {issues.map((i) => (
                  <li key={i}>
                    <Icon name="info" size={20} />
                    {ISSUE_MESSAGES[i]}
                  </li>
                ))}
              </ul>
            )}
            {running && (
              <p className="small muted">
                Tracking confidence {Math.round((snap?.confidence ?? 0) * 100)}% · {vision.stats.fps} frames/s
                · {vision.stats.delegate ?? "…"} processing
              </p>
            )}
          </section>

          {input.mode === "scan_blink" && running && (
            <section className="panel stack">
              <h3>
                <Icon name="blink" /> Practise the blink switch
              </h3>
              <p>Close your eyes for about half a second, then open them. Ordinary blinks are ignored.</p>
              <div className="progress" aria-label="Blink hold progress">
                <span style={{ width: `${blinkProgress * 100}%` }} />
              </div>
              <p>
                <strong>Switch presses detected: {presses}</strong>
              </p>
            </section>
          )}

          <div className="stack">
            {!running && !starting && (
              <button className="btn btn-xl btn-primary" onClick={() => void input.startCamera()} data-dwell>
                <Icon name="camera" /> Start camera
              </button>
            )}
            {running && needsCalibration && (
              <button
                className="btn btn-xl btn-primary"
                onClick={() => navigate("/calibrate")}
                disabled={!ready}
                data-dwell
              >
                <Icon name="target" /> {ready ? "Calibrate now" : "Calibrate (fix the checks first)"}
              </button>
            )}
            {running && headPointer && (
              <button
                className="btn btn-xl"
                onClick={() => {
                  vision.recentre();
                  announce("Head pointer centred. Point your nose at the middle of the screen.");
                }}
                data-dwell
              >
                <Icon name="target" /> Centre the head pointer
              </button>
            )}
            {running && !needsCalibration && (
              <button className="btn btn-xl btn-primary" onClick={() => navigate("/")} data-dwell>
                <Icon name="check" /> Done
              </button>
            )}
            {running && (
              <button className="btn" onClick={input.stopCamera} data-dwell>
                <Icon name="stop" /> Stop camera
              </button>
            )}
            <button
              className="btn btn-quiet"
              data-dwell
              onClick={() => {
                input.stopCamera();
                update({ input_mode: "pointer" });
                navigate("/");
              }}
            >
              Continue without the camera
            </button>
          </div>
          {!window.isSecureContext && (
            <ErrorNote message="This page isn't on a secure address, so the browser will block the camera. Open AGENCY at http://localhost." />
          )}
        </div>
      </div>
    </Page>
  );
}
