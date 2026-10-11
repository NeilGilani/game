/**
 * Settings › Gaze lab: measure eye control on the real person with the real camera, and tune it.
 *
 * - A 9-dot test: one dot at a time at 10 / 50 / 90 % of the screen, 2.5 s each. The pointer is hidden
 *   during the test so the person looks at the dot, not at the pointer. It measures accuracy (offset),
 *   jitter (shake), raw versus filtered, how long the pointer takes to settle, and whether the engine's
 *   own error radius is honest (os/gaze/src/lab.ts).
 * - The person's raw estimates from the test are replayed through other filter settings, and the lab
 *   says which settles and shakes least for them. Snap distance and dwell steadiness are suggested
 *   from the measured numbers. Nothing changes until "Use these settings".
 * - A live overlay of the raw estimate against the filtered pointer, with the error circle.
 * - Export: anonymous metrics only (numbers; no images, no landmarks, no samples, no time of day).
 *
 * Every sample stays in memory on this device and is dropped when the screen closes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FilterTrial,
  type LabDot,
  type LabMetrics,
  type LabSample,
  DEFAULT_FILTER,
  exportMetrics,
  measure,
  nineDots,
  recommendLock,
  tuneFilter,
} from "../../../os/gaze/src/lab";
import { Icon } from "../components/Icon";
import { usePrecision, livePrecision } from "../input/layout";
import { useAnnounce } from "../state/announcer";
import { useInput } from "../state/input";
import { usePreferences } from "../state/preferences";
import { navigate } from "../state/router";
import { setGazeTuning, useGazeTuning } from "../vision/tuning";

const DOT_MS = 2500;
const SETTLE_MS = 800;

type Phase =
  | { kind: "home" }
  | { kind: "test"; dot: number }
  | { kind: "results"; metrics: LabMetrics; tuning: FilterTrial[] | null; samples: number };

const px = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `${Math.round(v)} px`;
const ms = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `${Math.round(v)} ms`;
const sameFilter = (a: FilterTrial["settings"], b: FilterTrial["settings"]) =>
  a.z === b.z && a.minK === b.minK && a.windowMs === b.windowMs;

export function GazeLab() {
  const input = useInput();
  const { prefs, update } = usePreferences();
  const tuning = useGazeTuning();
  const announce = useAnnounce();
  const [phase, setPhase] = useState<Phase>({ kind: "home" });
  const [overlay, setOverlay] = useState(false);
  const samples = useRef<LabSample[]>([]);
  const dots = useRef<LabDot[]>([]);
  const { vision, setSuspended, mode, status, calibration } = input;
  const pointerMode = mode === "gaze" || mode === "head";
  const ready = status === "running" && pointerMode && (mode === "head" || !!calibration);

  // No selection while the dots run: the person should look at the dot, nothing else.
  useEffect(() => {
    setSuspended(phase.kind === "test");
    return () => setSuspended(false);
  }, [phase.kind, setSuspended]);

  const finish = useCallback(() => {
    const recorded = samples.current;
    const metrics = measure(recorded, dots.current, { settleMs: SETTLE_MS });
    // Replaying the filter only makes sense for eye gaze (the head pointer isn't smoothed that way).
    const trials =
      mode === "gaze" && metrics.summary.dotsMeasured >= 5
        ? tuneFilter(recorded, dots.current, { settleMs: SETTLE_MS })
        : null;
    setPhase({ kind: "results", metrics, tuning: trials, samples: recorded.length });
    announce(
      metrics.summary.dotsMeasured
        ? `Test done. Accuracy ${Math.round(metrics.summary.accuracyPx)} pixels, shake ${Math.round(metrics.summary.jitterPx)} pixels.`
        : "Test done, but no dot could be measured.",
    );
  }, [announce, mode]);

  const start = useCallback(() => {
    samples.current = [];
    dots.current = nineDots(window.innerWidth, window.innerHeight);
    setPhase({ kind: "test", dot: 0 });
  }, []);

  // The test runs on frame time: each dot shows for DOT_MS of camera frames.
  useEffect(() => {
    if (phase.kind !== "test") return;
    let t0: number | null = null;
    let shown = 0;
    const off = vision.onFrame((f) => {
      t0 ??= f.t;
      const i = Math.floor((f.t - t0) / DOT_MS);
      if (i >= dots.current.length) {
        off();
        finish();
        return;
      }
      if (i !== shown) {
        shown = i;
        setPhase({ kind: "test", dot: i });
      }
      samples.current.push({
        t: f.t,
        dot: i,
        dotStart: t0 + i * DOT_MS,
        point: f.pointer,
        raw: f.raw,
        confidence: f.confidence,
        errorRadius: f.errorRadius,
      });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPhase({ kind: "home" });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
    // Only (re)start when the test starts, not on every dot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind === "test", vision, finish]);

  if (phase.kind === "test") {
    const dot = dots.current[phase.dot];
    return (
      <div
        className="calibration"
        role="dialog"
        aria-label="Gaze lab test in progress"
        data-dwell-scope="modal"
      >
        <div className="cal-hud lab-hud">
          Look at the dot · {phase.dot + 1} of {dots.current.length}
          <button className="btn" onClick={() => setPhase({ kind: "home" })}>
            <Icon name="stop" /> Stop
          </button>
        </div>
        {dot && (
          <div key={dot.id} className="cal-target" style={{ left: dot.x, top: dot.y }} aria-hidden>
            <span />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flow" aria-label="Gaze lab">
      <div className="flow-head">
        <div className="eyebrow">
          <Icon name="target" size={18} /> Settings · Gaze lab
        </div>
        <h1>How well do your eyes control AGENCY?</h1>
        <p className="muted">
          A 9-dot test measures this camera on you. Nothing is recorded: the numbers stay on this device, and
          an export holds numbers only.
        </p>
      </div>

      {!ready ? (
        <div className="panel stack">
          <p className="task-big">
            {!pointerMode
              ? "The lab measures eye gaze or the head pointer. Choose one in How you choose."
              : status !== "running"
                ? "The camera is off."
                : "Your eyes aren't calibrated yet."}
          </p>
          <div className="task-actions">
            {pointerMode && status !== "running" && (
              <button className="btn btn-xl btn-primary" onClick={() => void input.startCamera()} data-dwell>
                <Icon name="camera" /> Start the camera
              </button>
            )}
            {pointerMode && status === "running" && !calibration && (
              <button className="btn btn-xl btn-primary" onClick={() => navigate("/calibrate")} data-dwell>
                <Icon name="target" /> Calibrate
              </button>
            )}
            {!pointerMode && (
              <button className="btn btn-xl btn-primary" onClick={() => navigate("/preferences")} data-dwell>
                <Icon name="eye" /> How you choose
              </button>
            )}
          </div>
        </div>
      ) : phase.kind === "results" ? (
        <Results
          result={phase}
          mode={mode === "head" ? "head" : "gaze"}
          onApply={(filter, lock) => {
            if (filter) setGazeTuning({ filter });
            if (lock) update(lock);
            announce("Saved. Eye control uses your measured settings now.");
          }}
          currentFilter={tuning.filter ?? DEFAULT_FILTER}
          prefs={{ target_snap_px: prefs.target_snap_px, dwell_stability_px: prefs.dwell_stability_px }}
          onAgain={start}
        />
      ) : (
        <LabHome onStart={start} overlay={overlay} setOverlay={setOverlay} />
      )}

      {overlay && ready && <LiveOverlay />}

      <div className="flow-bar" role="group" aria-label="Move around">
        <button className="btn btn-xl" onClick={() => navigate("/settings")} data-dwell>
          <Icon name="back" /> Back
        </button>
        <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
          <Icon name="home" /> Home
        </button>
      </div>
    </div>
  );
}

function LabHome({
  onStart,
  overlay,
  setOverlay,
}: {
  onStart: () => void;
  overlay: boolean;
  setOverlay: (on: boolean) => void;
}) {
  const tuning = useGazeTuning();
  const level = usePrecision();
  const { vision } = useInput();
  const [live, setLive] = useState<{ errorRadius: number; level: string } | null>(null);
  useEffect(() => {
    let last = 0;
    return vision.onFrame((f) => {
      if (f.t - last < 500) return;
      last = f.t;
      setLive({ errorRadius: f.errorRadius, level: livePrecision() });
    });
  }, [vision]);
  const strength = tuning.contextStrength;
  return (
    <div className="stack">
      <div className="task-actions">
        <button className="btn btn-xl btn-primary" onClick={onStart} data-dwell>
          <Icon name="target" /> Start the 9-dot test
        </button>
        <button className="btn btn-xl" onClick={() => setOverlay(!overlay)} aria-pressed={overlay} data-dwell>
          <Icon name="eye" /> {overlay ? "Hide" : "Show"} raw and filtered gaze
        </button>
      </div>
      <dl className="kv">
        <dt>Error radius now (the engine's estimate)</dt>
        <dd>{px(live?.errorRadius)}</dd>
        <dt>Tracking now</dt>
        <dd>
          {live?.level ?? "–"} · screens laid out for {level}
        </dd>
      </dl>
      <h2>How AGENCY helps your eyes</h2>
      <div className="task-actions">
        <button
          className="btn btn-xl"
          onClick={() => setGazeTuning({ contextStrength: strength >= 1 ? 0.5 : strength > 0 ? 0 : 1 })}
          data-dwell
        >
          <Icon name="sparkle" /> Use what's likely next:{" "}
          {strength >= 1 ? "full" : strength > 0 ? "half" : "off"}
        </button>
        <button
          className="btn btn-xl"
          onClick={() => setGazeTuning({ prediction: !tuning.prediction })}
          aria-pressed={tuning.prediction}
          data-dwell
        >
          <Icon name="right" /> Quicker when I look straight at what's next:{" "}
          {tuning.prediction ? "on" : "off"}
        </button>
        <button
          className="btn btn-xl"
          onClick={() => setGazeTuning({ adaptiveLayout: !tuning.adaptiveLayout })}
          aria-pressed={tuning.adaptiveLayout}
          data-dwell
        >
          <Icon name="grid" /> Bigger buttons when tracking is rough: {tuning.adaptiveLayout ? "on" : "off"}
        </button>
      </div>
      <p className="small muted">
        Paying, sending, sharing, signing and calling are never made quicker, and always ask for your
        approval. Stop and Help are never made harder to reach.
      </p>
    </div>
  );
}

function Results({
  result,
  mode,
  onApply,
  currentFilter,
  prefs,
  onAgain,
}: {
  result: Extract<Phase, { kind: "results" }>;
  mode: "gaze" | "head";
  onApply: (
    filter: FilterTrial["settings"] | null,
    lock: { target_snap_px: number; dwell_stability_px: number } | null,
  ) => void;
  currentFilter: FilterTrial["settings"];
  prefs: { target_snap_px: number; dwell_stability_px: number };
  onAgain: () => void;
}) {
  const { metrics, tuning } = result;
  const s = metrics.summary;
  const { vision } = useInput();
  const lock = recommendLock(s);
  const best = tuning?.[0] ?? null;
  const current = tuning?.find((t) => sameFilter(t.settings, currentFilter)) ?? null;
  const betterFilter =
    best && current && !sameFilter(best.settings, current.settings) && best.score < current.score * 0.95;
  const lockChanges =
    lock &&
    (lock.target_snap_px !== prefs.target_snap_px || lock.dwell_stability_px !== prefs.dwell_stability_px);
  const [saved, setSaved] = useState(false);

  const download = () => {
    const data = exportMetrics({
      date: new Date(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      camera: vision.stats.videoSize ? { ...vision.stats.videoSize, fps: vision.stats.fps } : null,
      mode,
      filter: currentFilter,
      metrics,
      tuning,
    });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agency-gaze-lab-${data.date}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!s.dotsMeasured) {
    return (
      <div className="panel stack">
        <p className="task-big">No dot could be measured: the camera didn't see your eyes well enough.</p>
        <div className="task-actions">
          <button className="btn btn-xl btn-primary" onClick={onAgain} data-dwell>
            <Icon name="refresh" /> Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <table className="data" aria-label="Measured on you">
        <thead>
          <tr>
            <th>Measured on you ({s.dotsMeasured} of 9 dots)</th>
            <th>Filtered (what you see)</th>
            <th>Raw (before the filter)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Accuracy: average distance from the dot</td>
            <td>{px(s.accuracyPx)}</td>
            <td>{px(s.rawAccuracyPx)}</td>
          </tr>
          <tr>
            <td>Shake while you hold still (RMS)</td>
            <td>{px(s.jitterPx)}</td>
            <td>{px(s.rawJitterPx)}</td>
          </tr>
          <tr>
            <td>Worst dots (90th percentile accuracy)</td>
            <td>{px(s.accuracyP90Px)}</td>
            <td />
          </tr>
          <tr>
            <td>Error radius: measured (86 % inside) / the engine's own estimate</td>
            <td>
              {px(s.measuredErrorRadiusPx)} / {px(s.reportedErrorRadiusPx)}
            </td>
            <td />
          </tr>
          <tr>
            <td>Pointer settles after a new dot</td>
            <td>{ms(s.settleMs)}</td>
            <td />
          </tr>
          <tr>
            <td>Frames with usable tracking</td>
            <td>{Number.isFinite(s.usable) ? `${Math.round(s.usable * 100)} %` : "–"}</td>
            <td />
          </tr>
        </tbody>
      </table>

      {tuning && current && best && (
        <p>
          Filter, replayed on your own recording ({tuning.length} settings tried): yours now shakes{" "}
          {px(current.metrics.jitterPx)} and settles in {ms(current.metrics.settleMs)}.{" "}
          {betterFilter
            ? `The best for you shakes ${px(best.metrics.jitterPx)} and settles in ${ms(best.metrics.settleMs)}.`
            : "No other setting was clearly better for you."}
        </p>
      )}
      {lock && (
        <ul className="list">
          {lock.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
          <li>
            Now: snap {prefs.target_snap_px} px, steadiness {prefs.dwell_stability_px} px. Suggested: snap{" "}
            {lock.target_snap_px} px, steadiness {lock.dwell_stability_px} px.
          </li>
        </ul>
      )}

      <div className="task-actions">
        {(betterFilter || lockChanges) && !saved && (
          <button
            className="btn btn-xl btn-primary"
            onClick={() => {
              onApply(betterFilter ? best!.settings : null, lockChanges ? lock : null);
              setSaved(true);
            }}
            data-dwell
          >
            <Icon name="check" /> Use these settings
          </button>
        )}
        <button className="btn btn-xl" onClick={onAgain} data-dwell>
          <Icon name="refresh" /> Test again
        </button>
        <button className="btn btn-xl" onClick={download} data-dwell>
          <Icon name="down" /> Save the numbers (no images)
        </button>
      </div>
      {saved && <p role="status">Saved on this device.</p>}
    </div>
  );
}

/** The raw estimate (grey) against the filtered pointer (blue), with the engine's error circle. */
function LiveOverlay() {
  const { vision } = useInput();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const trail: { raw: { x: number; y: number } | null; point: { x: number; y: number } | null }[] = [];
    const fit = () => {
      c.width = window.innerWidth * devicePixelRatio;
      c.height = window.innerHeight * devicePixelRatio;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    };
    fit();
    window.addEventListener("resize", fit);
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0064d2";
    const off = vision.onFrame((f) => {
      trail.push({ raw: f.raw, point: f.pointer });
      if (trail.length > 30) trail.shift();
      ctx.clearRect(0, 0, c.width, c.height);
      trail.forEach((p, i) => {
        const a = (i + 1) / trail.length;
        if (p.raw) {
          ctx.fillStyle = `rgba(128,128,128,${0.5 * a})`;
          ctx.beginPath();
          ctx.arc(p.raw.x, p.raw.y, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      const last = trail.at(-1);
      if (last?.point) {
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(last.point.x, last.point.y, Math.max(4, f.errorRadius), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(last.point.x, last.point.y, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    return () => {
      off();
      window.removeEventListener("resize", fit);
    };
  }, [vision]);
  return (
    <>
      <canvas ref={canvas} className="lab-overlay" aria-hidden />
      <p className="small muted lab-legend">
        <span className="lab-swatch lab-raw" /> raw estimate · <span className="lab-swatch lab-filtered" />{" "}
        filtered pointer, with its error circle
      </p>
    </>
  );
}
