import { useState, type ReactNode } from "react";
import { accessToken, api, coordinatorUrl, setAccessToken, setCoordinatorUrl } from "../api/client";
import type { Faults, InputMode, Preferences, ReasoningStatus, Runtime } from "../api/types";
import { ConfirmSheet, ErrorNote } from "../components/common";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { Loading, SimulatedBadge, formatTime } from "../components/status";
import { useAnnounce } from "../state/announcer";
import { coordinatorLabel, useConnection } from "../state/connection";
import { MODE_LABELS, useInput } from "../state/input";
import { usePreferences } from "../state/preferences";
import { navigate } from "../state/router";
import { usePoll } from "../state/usePoll";

const MODE_ICONS: Record<InputMode, string> = {
  gaze: "eye",
  head: "head",
  scan_blink: "blink",
  scan_key: "key",
  pointer: "pointer",
};

const MODE_HELP: Record<InputMode, string> = {
  gaze: "Look at a button and hold your gaze to select it. Needs calibration.",
  head: "Point with small head movements and hold to select. Needs calibration.",
  scan_blink: "Choices light up in turn; a deliberate long blink selects.",
  scan_key: "Choices light up in turn; press Space (or any switch mapped to it) to select.",
  pointer: "Use a mouse, trackpad, keyboard or touch as usual.",
};

export function ModePicker({ onPicked }: { onPicked?: (mode: InputMode) => void }) {
  const { prefs, update } = usePreferences();
  return (
    <div className="grid grid-3" role="radiogroup" aria-label="Input method">
      {(Object.keys(MODE_LABELS) as InputMode[]).map((m) => (
        <button
          key={m}
          className="tile"
          role="radio"
          aria-checked={prefs.input_mode === m}
          aria-pressed={prefs.input_mode === m}
          data-dwell
          onClick={() => {
            update({ input_mode: m });
            onPicked?.(m);
          }}
        >
          <span className="tile-icon">
            <Icon name={MODE_ICONS[m]} size={30} />
          </span>
          <span>
            <span className="tile-title">{MODE_LABELS[m].short}</span>
            <br />
            <span className="tile-sub">{MODE_HELP[m]}</span>
          </span>
          <span className="tile-check">
            <Icon name="check" size={22} />
          </span>
        </button>
      ))}
    </div>
  );
}

export function Stepper({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  help,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  help?: string;
}) {
  const id = label.replace(/\W+/g, "-").toLowerCase();
  return (
    <div className="panel stack" role="group" aria-labelledby={id}>
      <h3 id={id}>{label}</h3>
      <div className="stepper">
        <button
          className="btn"
          aria-label={`Decrease ${label}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, +(value - step).toFixed(2)))}
          data-dwell
        >
          <Icon name="left" />
        </button>
        <output aria-live="polite">{display}</output>
        <button
          className="btn"
          aria-label={`Increase ${label}`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, +(value + step).toFixed(2)))}
          data-dwell
        >
          <Icon name="right" />
        </button>
      </div>
      {help && <p className="small muted">{help}</p>}
    </div>
  );
}

export function Toggle({
  label,
  value,
  onChange,
  help,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  help?: string;
}) {
  return (
    <button
      className="tile"
      style={{ minHeight: 120 }}
      aria-pressed={value}
      onClick={() => onChange(!value)}
      data-dwell
    >
      <span className="tile-title">{label}</span>
      <span className="tile-sub">
        {value ? "On" : "Off"}
        {help ? ` · ${help}` : ""}
      </span>
      <span className="tile-check">
        <Icon name="check" size={22} />
      </span>
    </button>
  );
}

function Section({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return (
    <section className="stack" aria-label={title}>
      <h2>
        <Icon name={icon} /> {title}
      </h2>
      {children}
    </section>
  );
}

export function PreferencesView() {
  const { prefs, update, synced } = usePreferences();
  return (
    <Page label="Accessibility preferences">
      <div className="page-head">
        <div>
          <div className="eyebrow">Accessibility</div>
          <h1>Make AGENCY work for you</h1>
          <p>
            Changes apply right away.{" "}
            {synced ? "They're saved on the coordinator too." : "Saved on this device."}
          </p>
        </div>
        <button className="btn" onClick={() => navigate("/settings")} data-dwell>
          <Icon name="gear" /> All settings
        </button>
      </div>
      <Section title="How you control AGENCY" icon="eye">
        <ModePicker />
      </Section>
      <Section title="Timing and display" icon="clock">
        <div className="grid grid-3">
          <Stepper
            label="Dwell time"
            value={prefs.dwell_ms}
            display={`${(prefs.dwell_ms / 1000).toFixed(1)} s`}
            min={400}
            max={4000}
            step={200}
            onChange={(v) => update({ dwell_ms: v })}
            help="How long to look at a button to select it."
          />
          <Stepper
            label="Text size"
            value={prefs.text_scale}
            display={`${Math.round(prefs.text_scale * 100)}%`}
            min={0.85}
            max={1.6}
            step={0.05}
            onChange={(v) => update({ text_scale: v })}
          />
          <Stepper
            label="Scan speed"
            value={prefs.scan_interval_ms}
            display={`${(prefs.scan_interval_ms / 1000).toFixed(1)} s each`}
            min={500}
            max={5000}
            step={250}
            onChange={(v) => update({ scan_interval_ms: v })}
          />
        </div>
      </Section>
      <Section title="Appearance" icon="eye">
        <div className="grid grid-4" role="radiogroup" aria-label="Theme">
          {(["system", "light", "dark", "contrast"] as Preferences["theme"][]).map((t) => (
            <button
              key={t}
              className="tile"
              style={{ minHeight: 110 }}
              role="radio"
              aria-checked={prefs.theme === t}
              aria-pressed={prefs.theme === t}
              onClick={() => update({ theme: t })}
              data-dwell
            >
              <span className="tile-title">
                {{ system: "Match system", light: "Light", dark: "Dark", contrast: "High contrast" }[t]}
              </span>
              <span className="tile-check">
                <Icon name="check" size={22} />
              </span>
            </button>
          ))}
        </div>
        <div className="grid grid-3">
          <Toggle
            label="Reduce motion"
            value={prefs.reduced_motion}
            onChange={(v) => update({ reduced_motion: v })}
          />
          <Toggle
            label="Show gaze pointer"
            value={prefs.show_gaze_cursor}
            onChange={(v) => update({ show_gaze_cursor: v })}
          />
          <Toggle
            label="Speak selections"
            value={prefs.speak_feedback}
            onChange={(v) => update({ speak_feedback: v })}
          />
        </div>
      </Section>
    </Page>
  );
}

export function SettingsView() {
  const { prefs, update } = usePreferences();
  const input = useInput();
  const { refresh, online, health } = useConnection();
  const announce = useAnnounce();
  const [address, setAddress] = useState(coordinatorUrl());
  const [token, setToken] = useState(accessToken());
  const [testResult, setTestResult] = useState<string | null>(null);

  const saveConnection = async () => {
    setCoordinatorUrl(address);
    setAccessToken(token);
    setTestResult("Checking…");
    await refresh();
    try {
      const h = await api.health();
      const c = coordinatorLabel(h, true);
      setTestResult(`Connected: ${c.long}.`);
      announce("Coordinator connected.");
    } catch {
      setTestResult("Couldn't reach that address. Check it's running and on the same network.");
    }
  };

  return (
    <Page label="Settings">
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Interaction, camera and connection</h1>
        </div>
        <button className="btn" onClick={() => navigate("/preferences")} data-dwell>
          <Icon name="eye" /> Accessibility preferences
        </button>
      </div>

      <Section title="Selection sensitivity" icon="target">
        <div className="grid grid-3">
          <Stepper
            label="Dwell time"
            value={prefs.dwell_ms}
            display={`${(prefs.dwell_ms / 1000).toFixed(1)} s`}
            min={400}
            max={4000}
            step={200}
            onChange={(v) => update({ dwell_ms: v })}
          />
          <Stepper
            label="Steadiness needed"
            value={prefs.dwell_stability_px}
            display={`${prefs.dwell_stability_px} px`}
            min={10}
            max={300}
            step={10}
            onChange={(v) => update({ dwell_stability_px: v })}
            help="Smaller means you must hold steadier. Larger is more forgiving (and smooths the pointer more)."
          />
          <Stepper
            label="Snap distance"
            value={prefs.target_snap_px}
            display={`${prefs.target_snap_px} px`}
            min={0}
            max={200}
            step={8}
            onChange={(v) => update({ target_snap_px: v })}
            help="How far outside a button still counts as looking at it."
          />
          <Stepper
            label="Blink hold"
            value={prefs.blink_ms}
            display={`${(prefs.blink_ms / 1000).toFixed(2)} s`}
            min={200}
            max={1500}
            step={50}
            onChange={(v) => update({ blink_ms: v })}
            help="How long to close your eyes for a switch press."
          />
          <Stepper
            label="Scan speed"
            value={prefs.scan_interval_ms}
            display={`${(prefs.scan_interval_ms / 1000).toFixed(1)} s each`}
            min={500}
            max={5000}
            step={250}
            onChange={(v) => update({ scan_interval_ms: v })}
          />
        </div>
        <div className="grid grid-3">
          <Toggle
            label="Confirm important actions"
            value={prefs.confirm_consequential}
            onChange={(v) => update({ confirm_consequential: v })}
            help="Always on for gaze, head and scanning"
          />
          <Toggle
            label="Fall back to scanning"
            value={prefs.auto_fallback_to_scan}
            onChange={(v) => update({ auto_fallback_to_scan: v })}
            help="If tracking is lost for 10 s"
          />
          <Toggle
            label="Show gaze pointer"
            value={prefs.show_gaze_cursor}
            onChange={(v) => update({ show_gaze_cursor: v })}
          />
        </div>
      </Section>

      <Section title="Camera and calibration" icon="camera">
        <div className="panel stack">
          <p>
            <strong>{MODE_LABELS[input.mode].long}</strong>. Camera: {input.status}.{" "}
            {input.calibration
              ? `Calibrated ${formatTime(input.calibration.createdAt)} (${input.calibration.quality.grade}), stored ${input.calibrationRemembered ? "on this device" : "for this session only"}.`
              : "Not calibrated."}
          </p>
          <div className="row">
            <button className="btn" onClick={() => navigate("/camera")} data-dwell>
              <Icon name="camera" /> Camera setup
            </button>
            <button
              className="btn"
              onClick={() => navigate("/calibrate")}
              disabled={input.status !== "running"}
              data-dwell
            >
              <Icon name="target" /> Calibrate
            </button>
            <button
              className="btn btn-danger"
              disabled={!input.calibration}
              onClick={() => {
                input.setCalibration(null, false);
                announce("Calibration removed.");
              }}
              data-dwell
            >
              <Icon name="x" /> Reset calibration
            </button>
            {input.status === "running" && (
              <button className="btn" onClick={input.stopCamera} data-dwell>
                <Icon name="stop" /> Turn camera off
              </button>
            )}
          </div>
          <p className="small muted">
            Video never leaves this browser. Calibration (a few numbers, not images) is kept for this session
            unless you choose to remember it on this device. Nothing about your face or eyes is sent to the
            coordinator or the cloud.
          </p>
        </div>
      </Section>

      <Section title="Coordinator connection" icon="chip">
        <form
          className="panel stack"
          onSubmit={(e) => {
            e.preventDefault();
            void saveConnection();
          }}
        >
          <p>
            Now: <strong>{coordinatorLabel(health, online).long}</strong>.
          </p>
          <div className="grid grid-2">
            <label className="field">
              <strong>Coordinator address</strong>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Leave empty to use this computer (recommended), or http://agency-pi.local:8000"
                inputMode="url"
              />
            </label>
            <label className="field">
              <strong>Access token (if the coordinator requires one)</strong>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type="password"
                autoComplete="off"
              />
            </label>
          </div>
          <div className="row">
            <button className="btn btn-primary" type="submit">
              Save and test
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setAddress("");
                setCoordinatorUrl("");
                void refresh();
              }}
            >
              Use this computer
            </button>
            {testResult && <span role="status">{testResult}</span>}
          </div>
          <p className="small muted">
            Tip: for a Raspberry Pi, you can also start the interface with AGENCY_BACKEND_URL set (see
            DEPLOY_PI.md), which keeps the camera page on localhost.
          </p>
        </form>
      </Section>
    </Page>
  );
}

function FaultToggle({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button className="tile" style={{ minHeight: 130 }} aria-pressed={value} onClick={() => onChange(!value)}>
      <span className="tile-title">{label}</span>
      <span className="tile-sub">
        {value ? "Armed for the next attempt" : "Off"} · {help}
      </span>
      <span className="tile-check">
        <Icon name="check" size={22} />
      </span>
    </button>
  );
}

export function StatusView() {
  const runtime = usePoll<Runtime>(() => api.runtime(), 5000, "runtime");
  const faults = usePoll<Faults>(() => api.faults(), 3000, "faults");
  const input = useInput();
  const announce = useAnnounce();
  const [checking, setChecking] = useState(false);
  const [cloud, setCloud] = useState<ReasoningStatus | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  if (runtime.error && !runtime.data)
    return <ErrorNote message={runtime.error} onRetry={() => void runtime.reload()} />;
  if (!runtime.data) return <Loading />;
  const r = runtime.data;
  const reasoning = cloud ?? r.reasoning;
  const stats = input.vision.stats;

  const setFault = async (patch: Partial<Faults>) => {
    faults.set(await api.setFaults(patch));
    announce("Demo fault updated.");
  };

  return (
    <Page label="Connection and runtime status">
      <div className="page-head">
        <div>
          <div className="eyebrow">Status</div>
          <h1>What's running, and where</h1>
          <p>Everything here is reported by the running system, not assumed.</p>
        </div>
      </div>

      <div className="grid grid-2">
        <section className="panel stack">
          <h2>
            <Icon name={r.node.is_raspberry_pi ? "chip" : "laptop"} /> Coordinator
          </h2>
          <dl className="kv">
            <dt>Running on</dt>
            <dd>
              {r.node.is_raspberry_pi
                ? `Raspberry Pi (${r.node.device_model})`
                : r.node.role === "raspberry-pi"
                  ? "Raspberry Pi (role set by config)"
                  : "This computer (local mode)"}
            </dd>
            <dt>Host</dt>
            <dd>
              {r.node.hostname} · {r.node.system} {r.node.machine} · Python {r.node.python}
            </dd>
            <dt>Database</dt>
            <dd>
              SQLite, schema v{r.database.schema_version}{" "}
              <span className="mono small">{r.database.path}</span>
            </dd>
            <dt>Access</dt>
            <dd>{r.settings.auth_required ? "Token required" : "No token (local use)"}</dd>
            <dt>Automation</dt>
            <dd>{r.automation_paused ? "Stopped by you" : "Running"}</dd>
          </dl>
        </section>

        <section className="panel stack">
          <h2>
            <Icon name={reasoning.mode === "deterministic" ? "shield" : "sparkle"} /> Reasoning
          </h2>
          <p>
            <strong>{reasoning.description}</strong>
          </p>
          <dl className="kv">
            <dt>Mode</dt>
            <dd>
              {reasoning.mode === "deterministic"
                ? "Deterministic demo mode"
                : `Cloud (${reasoning.provider})`}
            </dd>
            <dt>Model</dt>
            <dd>{reasoning.model ?? "None"}</dd>
            <dt>Calls this session</dt>
            <dd>{reasoning.calls ?? 0}</dd>
            {reasoning.last_error && (
              <>
                <dt>Last error</dt>
                <dd>{reasoning.last_error}</dd>
              </>
            )}
          </dl>
          {reasoning.mode !== "deterministic" && (
            <button
              className="btn"
              style={{ alignSelf: "flex-start" }}
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                try {
                  setCloud(await api.checkCloud());
                } finally {
                  setChecking(false);
                }
              }}
              data-dwell
            >
              <Icon name="refresh" /> {checking ? "Checking…" : "Test cloud connection"}
            </button>
          )}
          <p className="small muted">
            Plans and explanations from a model are validated by AGENCY and never decide whether an action
            happened.
          </p>
        </section>

        <section className="panel stack">
          <h2>
            <Icon name="camera" /> Camera pipeline (this browser)
          </h2>
          <dl className="kv">
            <dt>Status</dt>
            <dd>{input.status}</dd>
            <dt>Library</dt>
            <dd>MediaPipe Face Landmarker (478 landmarks with iris), runs locally</dd>
            <dt>Processing</dt>
            <dd>
              {stats.delegate ?? "—"} · {stats.fps} frames/s
              {stats.modelLoadedMs ? ` · model loaded in ${stats.modelLoadedMs} ms` : ""}
            </dd>
            <dt>Video</dt>
            <dd>
              {stats.videoSize ? `${stats.videoSize.width}×${stats.videoSize.height}` : "—"} (never stored or
              sent)
            </dd>
            <dt>Calibration</dt>
            <dd>
              {input.calibration
                ? `${input.calibration.set}, ${input.calibration.basis}, ${input.calibration.quality.grade} (avg error ${Math.round(input.calibration.quality.meanError * 100)}% of screen)`
                : "None"}
            </dd>
          </dl>
        </section>

        <section className="panel stack">
          <h2>
            <Icon name="shield" /> Integrations
          </h2>
          <ul className="list">
            {r.integrations.map((i) => (
              <li key={i.key}>
                <SimulatedBadge text="Simulated" />
                <span>
                  <strong>{i.name}</strong>
                  <br />
                  <span className="small muted">{i.description}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="panel stack">
        <h2>
          <Icon name="shield" /> Privacy
        </h2>
        <ul className="list">
          {Object.entries(r.privacy).map(([k, v]) => (
            <li key={k}>
              <Icon name="check" size={20} />
              {v}
            </li>
          ))}
        </ul>
      </section>

      {r.settings.demo_controls && (
        <section className="panel panel-muted stack" aria-labelledby="h-demo">
          <h2 id="h-demo">
            <Icon name="gear" /> Presenter demo controls
          </h2>
          <p>
            These make a demo service misbehave on purpose so you can show recovery. They're for presenters,
            are recorded in the audit log, and can be disabled with AGENCY_DEMO_CONTROLS=0.
          </p>
          {faults.data && (
            <div className="grid grid-3">
              <FaultToggle
                label="Repair slot gets taken"
                help="The next booking finds its time already taken"
                value={faults.data.repair_slot_taken}
                onChange={(v) => void setFault({ repair_slot_taken: v })}
              />
              <FaultToggle
                label="Repair provider is slow"
                help="The next booking succeeds but replies too late"
                value={faults.data.repair_timeout_after_commit}
                onChange={(v) => void setFault({ repair_timeout_after_commit: v })}
              />
              <FaultToggle
                label="Messaging is down"
                help="Sending fails until retries run out"
                value={faults.data.messaging_unavailable}
                onChange={(v) => void setFault({ messaging_unavailable: v })}
              />
            </div>
          )}
          <button
            className="btn btn-danger"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setConfirmReset(true)}
          >
            <Icon name="refresh" /> Reset all demo data
          </button>
        </section>
      )}

      {confirmReset && (
        <ConfirmSheet
          title="Reset all demo data?"
          confirmLabel="Yes, reset"
          tone="danger"
          onCancel={() => setConfirmReset(false)}
          onConfirm={async () => {
            await api.resetDemo();
            setConfirmReset(false);
            announce("Demo data reset.");
            navigate("/");
          }}
        >
          <p>This deletes every case and restores the demo services to their starting state.</p>
        </ConfirmSheet>
      )}
    </Page>
  );
}
