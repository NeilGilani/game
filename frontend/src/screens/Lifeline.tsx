import { useEffect, useState } from "react";
import { api, lifelineApi } from "../api/client";
import type {
  AlertDetail,
  ContactRole,
  Faults,
  LifelineChannel,
  LifelineContact,
  LifelineReport,
  LifelineSettings,
  ResponderCard,
} from "../api/types";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { ErrorNote } from "../components/common";
import { Loading } from "../components/status";
import { useLifeline } from "../lifeline/LifelineProvider";
import {
  CHANNEL_LABEL,
  KIND_LABEL,
  ROLE_LABEL,
  SOURCE_LABEL,
  clockTime,
  contactStates,
  levels,
  names,
  outcome,
  seconds,
} from "../lifeline/describe";
import { useAnnounce } from "../state/announcer";
import { useConnection } from "../state/connection";
import { useInput } from "../state/input";
import { navigate } from "../state/router";
import { usePoll } from "../state/usePoll";
import { Stepper, Toggle } from "./SettingsViews";

type CheckTone = "ok" | "warn" | "danger" | "sim";

/** The simulated phones open in their own window, like a separate device. */
export function openPhones(): void {
  window.open(`${window.location.pathname}#/phones`, "agency-phones");
}

function Check({ tone, title, children }: { tone: CheckTone; title: string; children: React.ReactNode }) {
  return (
    <li className="ll-check" data-tone={tone}>
      <Icon name={tone === "ok" ? "check" : tone === "sim" ? "shield" : "alert"} />
      <span>
        <strong>{title}</strong>
        <br />
        <span className="small">{children}</span>
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------------------
// Lifeline home: readiness, Watch over me, tests, history
// ---------------------------------------------------------------------------------------

export function LifelineHome() {
  const ll = useLifeline();
  const input = useInput();
  const announce = useAnnounce();
  const { health } = useConnection();
  const report = usePoll<LifelineReport>(() => lifelineApi.report(), 4000, "ll-report");
  const demo = !!health?.demo_controls;
  const faults = usePoll<Faults | null>(
    () => (demo ? api.faults() : Promise.resolve(null)),
    4000,
    `ll-faults-${demo}`,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const s = ll.status;

  if (!s) {
    return (
      <Page label="Lifeline">
        {ll.online ? (
          <Loading />
        ) : (
          <ErrorNote message="Can't reach the coordinator's Lifeline." onRetry={() => void ll.refresh()} />
        )}
      </Page>
    );
  }

  const settings = s.settings;
  const lv = levels(settings);
  const armed = s.monitor.armed;
  const onPi = !!health?.node.is_raspberry_pi || health?.node.role === "raspberry-pi";
  const cameraOn = input.status === "running";
  const faceSeen = !!s.monitor.last_heartbeat?.face_visible;
  const realContacts = settings.contacts.filter((c) => c.enabled && c.channel !== "demo");
  const covered = ["No contacts", "Consent"];
  const otherProblems = s.problems.filter((p) => !covered.some((c) => p.startsWith(c)));
  const first = lv[0];

  const testAlarm = async () => {
    const ok = await ll.testAlarm();
    const text = ok
      ? "Alarm sound works."
      : "The browser blocked sound. Click or press a key anywhere on this page once, then try again.";
    setNotice(text);
    announce(text);
  };

  return (
    <Page label="Lifeline">
      <div className="page-head">
        <div>
          <div className="eyebrow">Lifeline</div>
          <h1>Call for help, even without speaking or moving</h1>
          <p>
            Ask for help with your eyes. AGENCY keeps contacting people, one after another, until someone
            answers that they're on the way. Messages in this demo go to simulated phones.
          </p>
        </div>
        <span className={`badge`} data-tone={ll.open ? "danger" : s.ready ? "ok" : "warn"}>
          <Icon name={ll.open ? "bell" : s.ready ? "check" : "alert"} size={18} />
          {ll.open ? "Alert open" : s.ready ? "Ready" : "Needs attention"}
        </span>
      </div>

      <div className="grid grid-2">
        <section className="panel stack" aria-labelledby="h-watch">
          <h2 id="h-watch">
            <Icon name="watch" /> Watch over me
          </h2>
          <button
            className="tile ll-watch"
            aria-pressed={armed}
            onClick={() => void ll.setArmed(!armed)}
            disabled={ll.busy}
            data-dwell
          >
            <span className="tile-title">{armed ? "On: AGENCY is watching" : "Off"}</span>
            <span className="tile-sub">
              {armed
                ? `Since ${clockTime(s.monitor.armed_at)}. Look here to turn it off.`
                : "Turn on at night or when you're alone."}
            </span>
            <span className="tile-check">
              <Icon name="check" size={22} />
            </span>
          </button>
          <p>
            While it's on, AGENCY alerts {first ? names(first) : "your contacts"} if this screen stops
            responding for {settings.watchdog_timeout_s} seconds
            {settings.checkin_interval_min
              ? `, or if you don't answer a check-in (every ${settings.checkin_interval_min} minutes)`
              : ""}
            {settings.alert_on_signal_unavailable
              ? `, or if your eyes can't be seen for ${Math.round(settings.signal_grace_s / 60)} minutes`
              : ""}
            . Those alerts start straight away, because you may not be able to cancel.
          </p>
          {armed && (
            <p className="small muted">
              Last sign of life from this screen: {seconds(s.monitor.seconds_since_heartbeat)} ago
              {ll.frozen ? " (heartbeats stopped by the presenter)" : ""}.
            </p>
          )}
        </section>

        <section className="panel stack" aria-labelledby="h-how">
          <h2 id="h-how">
            <Icon name="bell" /> How to call for help
          </h2>
          <ul className="list">
            <li>
              <Icon name="eye" size={20} />
              <span>
                <strong>Close your eyes for about a second, three times</strong> (within 10 seconds). Works
                whenever the camera is on, in every input mode, even with eye control paused.
              </span>
            </li>
            <li>
              <Icon name="bell" size={20} />
              <span>
                <strong>Look at Help</strong>, top left on every screen. When scanning, it's always the first
                choice.
              </span>
            </li>
            <li>
              <Icon name="pointer" size={20} />
              <span>
                <strong>A helper can press Help</strong> with the mouse or keyboard.
              </span>
            </li>
          </ul>
          <p className="small muted">
            {settings.cancel_window_s
              ? `You then have ${settings.cancel_window_s} seconds to cancel if it was a mistake.`
              : "Alerts start immediately (no cancel window)."}
          </p>
        </section>
      </div>

      <section className="panel stack" aria-labelledby="h-ready">
        <h2 id="h-ready">
          <Icon name="shield" /> Is Lifeline ready?
        </h2>
        <ul className="ll-checks">
          {lv.length ? (
            <Check
              tone="ok"
              title={`${settings.contacts.filter((c) => c.enabled).length} people to contact, in order`}
            >
              {lv.map((group) => names(group)).join(", then ")}. If no one answers, everyone is alerted again
              until someone does.
            </Check>
          ) : (
            <Check tone="danger" title="No contacts">
              Add at least one person in Lifeline setup. Until then only the alarm on this computer sounds.
            </Check>
          )}
          {settings.consent ? (
            <Check tone="ok" title="Permission to contact them">
              Given{" "}
              {settings.consented_at ? `on ${new Date(settings.consented_at).toLocaleDateString()}` : ""}.
              AGENCY won't ask again during an emergency.
            </Check>
          ) : (
            <Check tone="danger" title="Permission not given">
              Lifeline won't contact anyone until permission is confirmed in setup.
            </Check>
          )}
          {cameraOn && faceSeen ? (
            <Check tone="ok" title="Eye signal working">
              The camera can see your eyes, so three long blinks will call for help.
            </Check>
          ) : (
            <Check tone="warn" title={cameraOn ? "Eyes not visible" : "Camera is off"}>
              {cameraOn
                ? "The camera can't see your eyes right now, so the blink signal won't work. Help still works."
                : "Three long blinks need the camera. The Help button still works."}{" "}
              <a href="#/camera">Camera setup</a>
            </Check>
          )}
          {ll.alarmReady ? (
            <Check tone="ok" title="Alarm sound ready">
              Anyone nearby will hear it when an alert starts.
            </Check>
          ) : (
            <Check tone="warn" title="Alarm sound not enabled yet">
              Browsers only allow sound after one real click or key press on this page. A helper can press{" "}
              <strong>Test alarm sound</strong> once.
            </Check>
          )}
          {onPi ? (
            <Check tone="ok" title="Independent watchdog">
              The coordinator runs on a Raspberry Pi, separate from this computer, so it notices if this
              computer freezes, crashes or loses power.
            </Check>
          ) : (
            <Check tone="warn" title="Watchdog runs on this computer">
              If this computer shuts down, the watchdog stops with it. Run the coordinator on a Raspberry Pi
              for monitoring that keeps working when this computer doesn't.
            </Check>
          )}
          {realContacts.length && s.channels.twilio_configured ? (
            <Check tone="ok" title="Real text messages and calls">
              {names(realContacts)} get real texts
              {realContacts.some((c) => c.channel === "sms_call") ? " and calls" : ""} through Twilio.
              Response links use {s.channels.public_url}.
            </Check>
          ) : (
            <Check tone="sim" title="Simulated phones (demo)">
              Messages go to the{" "}
              <a href="#/phones" target="agency-phones">
                simulated phones
              </a>
              . The response links are real and work from any device that can reach the coordinator. No real
              person is contacted.
            </Check>
          )}
          {settings.dispatch.consent ? (
            <Check
              tone={s.dispatch.simulated ? "sim" : s.dispatch.ready ? "ok" : "danger"}
              title="Emergency services"
            >
              {s.dispatch.simulated
                ? `Allowed. ${s.dispatch.provider} is simulated in this build: no real emergency service is contacted.`
                : `Allowed, through ${s.dispatch.provider}.`}{" "}
              {settings.dispatch.auto_after_s
                ? `Requested automatically if a critical alert goes unanswered for ${settings.dispatch.auto_after_s} s; `
                : "Never requested automatically; "}
              you, a helper, or a yes to "Do you want an ambulance?" can also ask.
            </Check>
          ) : (
            <Check tone="warn" title="Emergency services not allowed">
              AGENCY won't request emergency services. Helpers see a button to call{" "}
              {settings.emergency_number} themselves.
            </Check>
          )}
          {s.home.has_power && settings.home.watch_power ? (
            <Check
              tone={s.home.state?.power.mains === false ? "danger" : s.home.simulated ? "sim" : "ok"}
              title={
                s.home.state?.power.mains === false ? "Ventilator on battery" : "Ventilator power watched"
              }
            >
              {s.home.state?.power.mains === false
                ? `Mains power is off: about ${Math.round(s.home.state.power.battery_minutes ?? 0)} minutes of battery left.`
                : "A power cut raises an alert while the battery still has time."}{" "}
              {s.home.provider}
              {s.home.simulated ? " (simulated)" : ""}.
              {s.home.has_lock && settings.home.unlock_for_responders
                ? " The front door can be unlocked for a helper who is coming, and locks again by itself."
                : ""}
            </Check>
          ) : (
            <Check tone="warn" title="Ventilator power not watched">
              Connect the ventilator&apos;s outlet or UPS through Home Assistant, or turn power watching on in
              setup.
            </Check>
          )}
          <Check tone={Object.keys(settings.plans).length ? "ok" : "warn"} title="Care plan for helpers">
            {Object.keys(settings.plans).length
              ? `Step-by-step instructions for ${Object.keys(settings.plans).length} situations. ${settings.plans_note}`
              : "No steps written yet. Write them with the care team in Lifeline setup."}
          </Check>
          {otherProblems.map((p) => (
            <Check key={p} tone="danger" title="Problem">
              {p}
            </Check>
          ))}
        </ul>
        <div className="btn-row">
          <button
            className="btn btn-primary"
            onClick={() => void ll.requestHelp("test", true)}
            disabled={!!ll.open}
            data-dwell
          >
            <Icon name="bell" /> Send a test alert
          </button>
          <button className="btn" onClick={() => void testAlarm()} data-dwell>
            <Icon name="bell" /> Test alarm sound
          </button>
          <button className="btn" onClick={() => navigate("/lifeline/setup")} data-dwell>
            <Icon name="gear" /> Lifeline setup
          </button>
          <button className="btn" onClick={openPhones} data-dwell>
            <Icon name="phone" /> Simulated phones
          </button>
        </div>
        {notice && (
          <p role="status" className="small">
            {notice}
          </p>
        )}
      </section>

      <div className="grid grid-2">
        <section className="panel stack" aria-labelledby="h-recent-alerts">
          <h2 id="h-recent-alerts">
            <Icon name="timeline" /> Recent alerts
          </h2>
          {s.recent.length === 0 ? (
            <p className="muted">No alerts yet. Send a test alert to practise.</p>
          ) : (
            <ul className="list">
              {s.recent.slice(0, 5).map((a) => {
                const o = outcome(a);
                return (
                  <li key={a.id}>
                    <button className="ll-row" onClick={() => navigate(`/lifeline/alert/${a.id}`)} data-dwell>
                      <span>
                        <strong>
                          {a.is_test ? "Test: " : ""}
                          {KIND_LABEL[a.kind]}
                        </strong>{" "}
                        <span className="small muted">
                          {new Date(a.created_at).toLocaleString(undefined, {
                            weekday: "short",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </span>
                        <br />
                        <span className="small">
                          {a.metrics.seconds_to_acknowledged !== null
                            ? `Answered in ${seconds(a.metrics.seconds_to_acknowledged)}`
                            : `By ${SOURCE_LABEL[a.source] ?? a.source}`}
                        </span>
                      </span>
                      <span className="badge" data-tone={o.tone}>
                        {o.text}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel stack" aria-labelledby="h-drills">
          <h2 id="h-drills">
            <Icon name="check" /> Practice and response times
          </h2>
          {report.data ? (
            <dl className="kv">
              <dt>Alerts</dt>
              <dd>
                {report.data.alerts} ({report.data.tests} tests)
              </dd>
              <dt>Answered</dt>
              <dd>{report.data.acknowledged}</dd>
              <dt>Typical time to an answer</dt>
              <dd>{seconds(report.data.median_seconds_to_acknowledged)}</dd>
              <dt>Slowest answer</dt>
              <dd>{seconds(report.data.max_seconds_to_acknowledged)}</dd>
              <dt>Cancelled in the countdown</dt>
              <dd>{report.data.cancelled_in_countdown}</dd>
              <dt>Emergency services requested</dt>
              <dd>{report.data.emergency_services_requested}</dd>
              <dt>Alarm only (nobody could be contacted)</dt>
              <dd>{report.data.local_only}</dd>
            </dl>
          ) : (
            <Loading />
          )}
          <p className="small muted">
            A monthly test alert shows whether contacts still answer, and how quickly. Times are measured from
            the signal to the first "I'm on my way".
          </p>
        </section>
      </div>

      {demo && (
        <section className="panel panel-muted stack" aria-labelledby="h-ll-demo">
          <h2 id="h-ll-demo">
            <Icon name="gear" /> Presenter controls
          </h2>
          <p>
            For demonstrating failure handling. Recorded in the audit log; disabled with
            AGENCY_DEMO_CONTROLS=0.
          </p>
          <div className="grid grid-3">
            <Toggle
              label={`${first?.[0]?.name ?? "First contact"}'s phone unreachable`}
              help="Their alert fails, so AGENCY moves on at once"
              value={!!faults.data?.lifeline_primary_unreachable}
              onChange={(v) =>
                void api.setFaults({ lifeline_primary_unreachable: v }).then(() => faults.reload())
              }
            />
            <Toggle
              label="Power cut at the ventilator"
              help="The ventilator runs on its battery from now"
              value={!!faults.data?.lifeline_power_cut}
              onChange={(v) => void api.setFaults({ lifeline_power_cut: v }).then(() => faults.reload())}
            />
            <Toggle
              label="Freeze this computer"
              help="Stops heartbeats, like a crash or power cut"
              value={ll.frozen}
              onChange={(v) => {
                ll.setFrozen(v);
                announce(v ? "Heartbeats stopped." : "Heartbeats resumed.");
              }}
            />
            <button
              className="tile"
              style={{ minHeight: 120 }}
              onClick={() =>
                void lifelineApi
                  .checkinNow()
                  .then(() => ll.refresh())
                  .catch((err: unknown) =>
                    setNotice(err instanceof Error ? err.message : "Couldn't start a check-in."),
                  )
              }
              data-dwell
            >
              <span className="tile-title">Ask for a check-in now</span>
              <span className="tile-sub">Needs Watch over me on</span>
            </button>
          </div>
        </section>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------------------
// Setup (done with a helper, keyboard and mouse)
// ---------------------------------------------------------------------------------------

const E164 = /^\+[1-9]\d{6,14}$/;
const ROLES: ContactRole[] = ["caregiver", "family", "neighbour", "clinician", "monitoring_service", "other"];
const CHANNELS: LifelineChannel[] = ["demo", "sms", "sms_call"];
const CARD_FIELDS: { key: keyof ResponderCard; label: string; hint: string }[] = [
  { key: "person_name", label: "Name", hint: "As helpers should call you" },
  { key: "address", label: "Where you are", hint: "Address, how to get in (key safe, door code holder)" },
  { key: "communication", label: "How to communicate with you", hint: "e.g. yes/no with eye movements" },
  { key: "breathing", label: "Breathing and equipment", hint: "Ventilator, mask, what to check first" },
  { key: "medical", label: "Medical", hint: "Conditions a helper or paramedic should know" },
  { key: "allergies", label: "Allergies", hint: "" },
  { key: "medications", label: "Medications", hint: "" },
  { key: "advance_directive", label: "Advance directive", hint: "Where it is kept" },
  { key: "notes", label: "Anything else", hint: "" },
];

function newContactId(existing: LifelineContact[]): string {
  let i = existing.length + 1;
  while (existing.some((c) => c.id === `contact_${i}`)) i += 1;
  return `contact_${i}`;
}

export function LifelineSetup() {
  const ll = useLifeline();
  const announce = useAnnounce();
  const [draft, setDraft] = useState<LifelineSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    lifelineApi
      .settings()
      .then((s) => !cancelled && setDraft(s))
      .catch(
        (err: unknown) =>
          !cancelled && setError(err instanceof Error ? err.message : "Couldn't load settings."),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!draft) {
    return <Page label="Lifeline setup">{error ? <ErrorNote message={error} /> : <Loading />}</Page>;
  }

  const update = (changes: Partial<LifelineSettings>) => {
    setSaved(false);
    setDraft({ ...draft, ...changes });
  };
  const updateContact = (i: number, changes: Partial<LifelineContact>) =>
    update({ contacts: draft.contacts.map((c, j) => (j === i ? { ...c, ...changes } : c)) });
  const phoneProblems = draft.contacts.map((c) =>
    c.channel !== "demo" && !E164.test(c.address.replace(/\s/g, ""))
      ? "Needs a phone number in international format, like +14155550123."
      : !c.name.trim()
        ? "Needs a name."
        : null,
  );
  const invalid = phoneProblems.some(Boolean);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const out = await lifelineApi.saveSettings({
        ...draft,
        contacts: draft.contacts.map((c) => ({
          ...c,
          name: c.name.trim(),
          address: c.address.replace(/\s/g, ""),
        })),
      });
      setDraft(out);
      setSaved(true);
      announce("Lifeline settings saved.");
      await ll.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page label="Lifeline setup">
      <div className="page-head">
        <div>
          <div className="eyebrow">Lifeline setup</div>
          <h1>Who to call, and what they should know</h1>
          <p>Best done together with a helper using a keyboard. Nothing changes until you press Save.</p>
        </div>
        <button className="btn" onClick={() => navigate("/lifeline")} data-dwell>
          <Icon name="back" /> Back to Lifeline
        </button>
      </div>

      <section className="panel stack" aria-labelledby="h-consent">
        <h2 id="h-consent">
          <Icon name="shield" /> Permission
        </h2>
        <label className="ll-consent">
          <input
            type="checkbox"
            checked={draft.consent}
            onChange={(e) => update({ consent: e.target.checked })}
          />
          <span>
            I agree that AGENCY may contact the people below on my behalf,{" "}
            <strong>without asking me first</strong>, when I signal for help or when Watch over me notices a
            problem. They will see my name, what happened, and the information on my responder card.
          </span>
        </label>
        <p className="small muted">
          {draft.consent && draft.consented_at
            ? `Recorded ${new Date(draft.consented_at).toLocaleString()}. `
            : ""}
          You can withdraw this at any time; then Lifeline only sounds the alarm on this computer.
        </p>
      </section>

      <section className="panel stack" aria-labelledby="h-contacts">
        <h2 id="h-contacts">
          <Icon name="phone" /> People to contact
        </h2>
        <p className="small muted">
          Order 1 is contacted first. People with the same number are contacted together. If nobody answers,
          AGENCY moves to the next number, then starts again with everyone.
        </p>
        {draft.contacts.map((c, i) => (
          <fieldset className="ll-contact" key={c.id}>
            <legend>{c.name || "New contact"}</legend>
            <label className="field">
              <span>Name</span>
              <input
                value={c.name}
                maxLength={60}
                onChange={(e) => updateContact(i, { name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Who they are</span>
              <select
                value={c.role}
                onChange={(e) => updateContact(i, { role: e.target.value as ContactRole })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>How to reach them</span>
              <select
                value={c.channel}
                onChange={(e) => updateContact(i, { channel: e.target.value as LifelineChannel })}
              >
                {CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {CHANNEL_LABEL[ch]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Phone number</span>
              <input
                value={c.address}
                placeholder={c.channel === "demo" ? "Not needed for a simulated phone" : "+14155550123"}
                inputMode="tel"
                maxLength={40}
                disabled={c.channel === "demo"}
                aria-invalid={!!phoneProblems[i]}
                onChange={(e) => updateContact(i, { address: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Order</span>
              <select
                value={c.priority}
                onChange={(e) => updateContact(i, { priority: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="ll-inline">
              <input
                type="checkbox"
                checked={c.enabled}
                onChange={(e) => updateContact(i, { enabled: e.target.checked })}
              />
              Active
            </label>
            <button
              className="btn btn-quiet"
              onClick={() => update({ contacts: draft.contacts.filter((_, j) => j !== i) })}
              aria-label={`Remove ${c.name || "contact"}`}
            >
              <Icon name="x" /> Remove
            </button>
            {phoneProblems[i] && (
              <p className="ll-field-error" role="alert">
                {phoneProblems[i]}
              </p>
            )}
          </fieldset>
        ))}
        <button
          className="btn"
          style={{ alignSelf: "flex-start" }}
          disabled={draft.contacts.length >= 8}
          onClick={() =>
            update({
              contacts: [
                ...draft.contacts,
                {
                  id: newContactId(draft.contacts),
                  name: "",
                  role: "family",
                  channel: "demo",
                  address: "",
                  priority: Math.min(9, Math.max(1, ...draft.contacts.map((c) => c.priority)) + 1),
                  enabled: true,
                },
              ],
            })
          }
        >
          <Icon name="plus" /> Add a person
        </button>
        <p className="small muted">
          Real text messages and calls need Twilio settings on the coordinator (TWILIO_ACCOUNT_SID,
          TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER) and AGENCY_PUBLIC_URL so phones can open the response link.
          {ll.status?.channels.twilio_configured
            ? " Twilio is configured."
            : " Twilio is not configured on this coordinator."}
        </p>
      </section>

      <section className="stack" aria-labelledby="h-timing">
        <h2 id="h-timing">
          <Icon name="clock" /> Timing
        </h2>
        <div className="grid grid-3">
          <Stepper
            label="Time to cancel"
            value={draft.cancel_window_s}
            display={`${draft.cancel_window_s} s`}
            min={0}
            max={30}
            step={1}
            onChange={(v) => update({ cancel_window_s: v })}
            help="After you ask for help, before anyone is contacted."
          />
          <Stepper
            label="Wait for an answer"
            value={draft.ack_timeout_s}
            display={`${draft.ack_timeout_s} s`}
            min={10}
            max={300}
            step={5}
            onChange={(v) => update({ ack_timeout_s: v })}
            help="Before moving on to the next person."
          />
          <Stepper
            label="Screen silent for"
            value={draft.watchdog_timeout_s}
            display={`${draft.watchdog_timeout_s} s`}
            min={15}
            max={600}
            step={5}
            onChange={(v) => update({ watchdog_timeout_s: v })}
            help="With Watch over me on, this long without a sign of life raises an alert."
          />
          <Stepper
            label="Check-in every"
            value={draft.checkin_interval_min}
            display={draft.checkin_interval_min ? `${draft.checkin_interval_min} min` : "Off"}
            min={0}
            max={480}
            step={15}
            onChange={(v) => update({ checkin_interval_min: v })}
            help="With Watch over me on, AGENCY asks if you're OK."
          />
          <Stepper
            label="Time to answer a check-in"
            value={draft.checkin_response_s}
            display={`${draft.checkin_response_s} s`}
            min={30}
            max={600}
            step={10}
            onChange={(v) => update({ checkin_response_s: v })}
          />
          <Toggle
            label="Alert if my eyes can't be seen"
            value={draft.alert_on_signal_unavailable}
            onChange={(v) => update({ alert_on_signal_unavailable: v })}
            help={`After ${Math.round(draft.signal_grace_s / 60)} min with Watch over me on`}
          />
        </div>
      </section>

      <section className="panel stack" aria-labelledby="h-card">
        <h2 id="h-card">
          <Icon name="document" /> Responder card
        </h2>
        <p className="small muted">
          Shown to the people you contact on their response page while an alert is open, and hidden once it
          ends.
        </p>
        <div className="grid grid-2">
          {CARD_FIELDS.map((f) => (
            <label className="field" key={f.key}>
              <span>
                {f.label}
                {f.hint && <span className="small muted"> · {f.hint}</span>}
              </span>
              <textarea
                rows={f.key === "person_name" ? 1 : 2}
                value={draft.responder[f.key]}
                maxLength={f.key === "person_name" ? 60 : 300}
                onChange={(e) => update({ responder: { ...draft.responder, [f.key]: e.target.value } })}
              />
            </label>
          ))}
          <label className="field">
            <span>Local emergency number</span>
            <input
              value={draft.emergency_number}
              inputMode="numeric"
              maxLength={4}
              onChange={(e) => update({ emergency_number: e.target.value.replace(/\D/g, "") })}
            />
          </label>
        </div>
      </section>

      {error && <ErrorNote message={error} />}
      <div className="btn-row">
        <button
          className="btn btn-primary btn-xl"
          onClick={() => void save()}
          disabled={saving || invalid}
          data-dwell
        >
          <Icon name="check" /> {saving ? "Saving…" : saved ? "Saved" : "Save Lifeline settings"}
        </button>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------------------
// One alert, in full
// ---------------------------------------------------------------------------------------

export function LifelineAlertView({ id }: { id: string }) {
  const alert = usePoll<AlertDetail>(() => lifelineApi.alert(id), 2000, `ll-alert-${id}`);
  const a = alert.data;
  if (!a) {
    return (
      <Page label="Alert">
        {alert.error ? <ErrorNote message={alert.error} onRetry={() => void alert.reload()} /> : <Loading />}
      </Page>
    );
  }
  const o = outcome(a);
  const messages = a.notifications;
  return (
    <Page label="Alert">
      <div className="page-head">
        <div>
          <div className="eyebrow">{a.is_test ? "Test alert" : "Alert"}</div>
          <h1>{KIND_LABEL[a.kind]}</h1>
          <p>{a.what}.</p>
        </div>
        <span className="badge" data-tone={o.tone}>
          {o.text}
        </span>
      </div>
      <div className="grid grid-3">
        <section className="panel">
          <h3>First person alerted</h3>
          <p className="ll-metric">{seconds(a.metrics.seconds_to_first_contact)}</p>
          <p className="small muted">after the signal</p>
        </section>
        <section className="panel">
          <h3>Someone on the way</h3>
          <p className="ll-metric">{seconds(a.metrics.seconds_to_acknowledged)}</p>
          <p className="small muted">
            {a.acknowledged_by ? `${a.acknowledged_by} answered` : "No answer yet"}
          </p>
        </section>
        <section className="panel">
          <h3>People alerted</h3>
          <p className="ll-metric">{a.metrics.people_alerted}</p>
          <p className="small muted">
            {a.local_only ? "Alarm only: no contacts could be used" : "including repeats once each"}
          </p>
        </section>
      </div>
      <div className="grid grid-2">
        <section className="panel stack">
          <h2>
            <Icon name="timeline" /> What happened
          </h2>
          <ol className="timeline">
            {a.events.map((e) => (
              <li
                key={e.id}
                data-actor={e.actor === "user" ? "user" : undefined}
                data-tone={eventTone(e.kind)}
              >
                <time>{clockTime(e.ts)}</time>
                <span>{e.message}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className="panel stack">
          <h2>
            <Icon name="message" /> Messages
          </h2>
          {contactStates(a).length > 0 && (
            <ul className="list">
              {contactStates(a).map(({ n, text, tone }) => (
                <li key={n.contact_id}>
                  <span className="badge" data-tone={tone}>
                    {n.contact_name}
                  </span>
                  <span className="small">{text}</span>
                </li>
              ))}
            </ul>
          )}
          {messages.length === 0 ? (
            <p className="muted">No messages were sent.</p>
          ) : (
            <ul className="list">
              {messages.map((m) => (
                <li key={m.id}>
                  <Icon name={m.status === "failed" ? "alert" : "message"} size={20} />
                  <span>
                    <strong>
                      {m.purpose === "alert"
                        ? "Alert"
                        : m.purpose === "stand_down"
                          ? "Stand down"
                          : "All clear"}{" "}
                      to {m.contact_name}
                    </strong>{" "}
                    <span className="small muted">
                      {clockTime(m.created_at)} ·{" "}
                      {m.channel === "demo" ? "simulated phone" : CHANNEL_LABEL[m.channel]} · {m.status}
                    </span>
                    <br />
                    <span className="small">{m.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <button
        className="btn"
        style={{ alignSelf: "flex-start" }}
        onClick={() => navigate("/lifeline")}
        data-dwell
      >
        <Icon name="back" /> Back to Lifeline
      </button>
    </Page>
  );
}

function eventTone(kind: string): string | undefined {
  if (["acknowledged", "resolved", "all_clear", "acknowledged_also", "checkin_ok"].includes(kind))
    return "ok";
  if (["delivery_failed", "unreachable", "local_only", "reopened"].includes(kind)) return "danger";
  if (["escalated", "declined", "signal", "coordinator_restarted"].includes(kind)) return "warn";
  return undefined;
}
