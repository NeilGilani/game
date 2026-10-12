/**
 * The emergency screen. While an alert is open it covers everything and is the only place
 * eye control can select (data-dwell-scope="modal"), so the person can always see what is
 * happening and cancel, and nothing behind it can be selected by accident.
 */

import { useEffect, useLayoutEffect, useState } from "react";
import type { AlertDetail } from "../api/types";
import { Icon } from "../components/Icon";
import { SELECTION_RESET_EVENT } from "../components/common";
import { useLifeline } from "./LifelineProvider";
import { clockTime, contactStates, names, nextStep, seconds } from "./describe";

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** New choices just appeared under the person's gaze: pause selection briefly. */
function useSelectionReset(key: string): void {
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
  }, [key]);
}

function Frame({
  tone,
  title,
  children,
  label,
}: {
  tone: "danger" | "warn" | "ok" | "test" | "calm";
  title: string;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div
      className="ll-overlay"
      data-tone={tone}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ll-title"
      aria-label={label}
      data-dwell-scope="modal"
    >
      <div className="ll-card">
        <h1 id="ll-title" className="ll-title">
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}

function ConfirmOk({ onYes, onNo, busy }: { onYes: () => void; onNo: () => void; busy: boolean }) {
  useSelectionReset("confirm-ok");
  return (
    <div className="ll-confirm" role="group" aria-labelledby="ll-confirm-q">
      <p id="ll-confirm-q" className="ll-lead">
        End the alert and tell everyone you're OK?
      </p>
      <div className="ll-actions">
        <button className="btn btn-xl" onClick={onNo} data-dwell disabled={busy}>
          <Icon name="back" /> No, keep the alert
        </button>
        <button className="btn btn-xl btn-primary" onClick={onYes} data-dwell disabled={busy}>
          <Icon name="check" /> Yes, I'm OK
        </button>
      </div>
    </div>
  );
}

function Contacts({ alert }: { alert: AlertDetail }) {
  const rows = contactStates(alert);
  if (rows.length === 0) return null;
  return (
    <ul className="ll-contacts" aria-label="People contacted">
      {rows.map(({ n, text, tone }) => (
        <li key={n.contact_id} data-tone={tone}>
          <Icon
            name={tone === "ok" ? "check" : tone === "danger" ? "alert" : tone === "warn" ? "x" : "message"}
          />
          <span>
            <strong>{n.contact_name}</strong>{" "}
            <span className="ll-role">{n.contact_role.replace("_", " ")}</span>
            <br />
            <span>{text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Pending({ alert }: { alert: AlertDetail }) {
  const ll = useLifeline();
  const now = useNow(200);
  useSelectionReset(`pending-${alert.id}`);
  const left = Math.max(0, Math.ceil((Date.parse(alert.activates_at) - (now + ll.offsetMs)) / 1000));
  const first = ll.status
    ? names(
        ll.status.settings.contacts
          .filter((c) => c.enabled)
          .sort((a, b) => a.priority - b.priority)
          .slice(0, 1),
      )
    : "";
  return (
    <Frame tone="warn" title="Calling for help" label="Calling for help, countdown">
      <div className="ll-count" aria-live="off">
        <span className="ll-count-num">{left}</span>
        <span className="ll-count-unit">seconds</span>
      </div>
      <p className="ll-lead" aria-live="polite">
        {left > 0
          ? `AGENCY will alert ${first || "your contacts"} in ${left} seconds unless you cancel.`
          : "Sending the alert now…"}
      </p>
      <div className="ll-actions">
        <button
          className="btn btn-xl ll-cancel"
          onClick={() => void ll.cancel()}
          data-dwell
          data-dwell-scale="2"
          disabled={ll.busy}
        >
          <Icon name="x" size={30} /> Cancel, I'm OK
        </button>
        <button
          className="btn btn-xl btn-solid-danger"
          onClick={() => void ll.callNow()}
          data-dwell
          disabled={ll.busy}
        >
          <Icon name="bell" size={30} /> Call now
        </button>
      </div>
      <p className="ll-note">Cancel needs a longer look, so it can't be chosen by accident.</p>
    </Frame>
  );
}

/** A helper asked a yes/no question: answer it with the eyes. Takes over the screen until answered. */
function Question({ alert }: { alert: AlertDetail }) {
  const ll = useLifeline();
  const q = alert.pending_question!;
  useSelectionReset(`question-${q.id}`);
  const more = alert.questions.filter((x) => !x.answer).length - 1;
  return (
    <Frame
      tone={alert.is_test ? "test" : "calm"}
      title={`${q.asked_by} asks:`}
      label={`${q.asked_by} asks a question`}
    >
      <p className="ll-question">{q.text}</p>
      <div className="ll-answers" role="group" aria-label="Your answer">
        <button
          className="btn btn-xl btn-primary"
          onClick={() => void ll.answer(q.id, "yes")}
          data-dwell
          disabled={ll.busy}
        >
          <Icon name="check" size={34} /> Yes
        </button>
        <button
          className="btn btn-xl ll-no"
          onClick={() => void ll.answer(q.id, "no")}
          data-dwell
          disabled={ll.busy}
        >
          <Icon name="x" size={34} /> No
        </button>
        <button
          className="btn btn-xl"
          onClick={() => void ll.answer(q.id, "not_sure")}
          data-dwell
          disabled={ll.busy}
        >
          <Icon name="question" size={34} /> Not sure
        </button>
      </div>
      <p className="ll-note">
        Your answer appears on {q.asked_by}&apos;s phone straight away.
        {more > 0 ? ` ${more} more ${more === 1 ? "question is" : "questions are"} waiting.` : ""}
      </p>
    </Frame>
  );
}

function SituationPicker({ alert, onDone }: { alert: AlertDetail; onDone: () => void }) {
  const ll = useLifeline();
  useSelectionReset("situation-picker");
  const options = ll.status?.rescue.situations ?? [];
  return (
    <Frame tone={alert.is_test ? "test" : "danger"} title="What's wrong?" label="Tell them what's wrong">
      <p className="ll-lead">
        Everyone helping sees your answer. Breathing, choking and equipment alert everyone at once.
      </p>
      <div className="ll-situations" role="group" aria-label="What's wrong">
        {options.map((o) => (
          <button
            key={o.key}
            className={`btn btn-xl ${o.urgency === "critical" ? "btn-solid-danger" : ""}`}
            aria-pressed={alert.situation === o.key}
            onClick={() => {
              void ll.setSituation(o.key);
              onDone();
            }}
            data-dwell
            disabled={ll.busy}
          >
            {o.label}
          </button>
        ))}
      </div>
      <button className="btn btn-xl ll-back" onClick={onDone} data-dwell>
        <Icon name="back" size={30} /> Back
      </button>
    </Frame>
  );
}

function ConfirmAmbulance({ alert, onDone }: { alert: AlertDetail; onDone: () => void }) {
  const ll = useLifeline();
  useSelectionReset("confirm-ambulance");
  const d = ll.status?.dispatch;
  const address = ll.status?.settings.dispatch.address;
  const where = address ? [address.line1, address.city].filter(Boolean).join(", ") : "";
  return (
    <Frame
      tone={alert.is_test ? "test" : "danger"}
      title="Ask for an ambulance?"
      label="Ask for an ambulance"
    >
      <p className="ll-lead">
        AGENCY asks {d?.provider ?? "the dispatch centre"} to send emergency services
        {where ? ` to ${where}` : ""}.{d?.simulated ? " (Demo: simulated, no one is sent.)" : ""}
        {alert.is_test ? " This is a test alert, so nothing is sent." : ""}
      </p>
      <div className="ll-actions">
        <button className="btn btn-xl" onClick={onDone} data-dwell disabled={ll.busy}>
          <Icon name="back" size={30} /> No, go back
        </button>
        <button
          className="btn btn-xl btn-solid-danger"
          onClick={() => {
            void ll.requestDispatch();
            onDone();
          }}
          data-dwell
          disabled={ll.busy}
        >
          <Icon name="bell" size={30} /> Yes, ask for an ambulance
        </button>
      </div>
    </Frame>
  );
}

/** What helpers have done so far, so the person isn't left wondering. */
function Progress({ alert }: { alert: AlertDetail }) {
  const items: { key: string; icon: string; text: string; tone?: string }[] = [];
  for (const a of alert.arrivals) {
    items.push({
      key: `arr-${a.contact_id}`,
      icon: "check",
      text: `${a.contact_name} is with you (${clockTime(a.arrived_at)})`,
      tone: "ok",
    });
  }
  if (alert.dispatch && alert.dispatch.status !== "test_skipped") {
    items.push({
      key: "dispatch",
      icon: alert.dispatch.status === "failed" ? "alert" : "bell",
      text: `Ambulance: ${alert.dispatch.summary}`,
      tone: alert.dispatch.status === "failed" ? "danger" : alert.dispatch.active ? "ok" : undefined,
    });
  }
  if (alert.door_unlocked_for) {
    items.push({ key: "door", icon: "key", text: `Front door unlocked for ${alert.door_unlocked_for}` });
  }
  for (const st of alert.plan.steps.filter((x) => x.done_at).slice(-3)) {
    items.push({ key: st.key, icon: "check", text: `${st.done_by}: ${st.label}`, tone: "ok" });
  }
  for (const q of alert.questions.filter((x) => x.answer).slice(-2)) {
    items.push({
      key: q.id,
      icon: "message",
      text: `You answered ${q.answer === "not_sure" ? "not sure" : q.answer}: ${q.text}`,
    });
  }
  if (items.length === 0) return null;
  return (
    <ul className="ll-progress" aria-label="What's happening">
      {items.map((i) => (
        <li key={i.key} data-tone={i.tone}>
          <Icon name={i.icon} size={22} />
          <span>{i.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** How far up from the bottom the dock starts (px), so a bar can sit just above it: Help and Stop stay visible. */
function useAboveDock(shown = true): number {
  const [bottom, setBottom] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const top = document.querySelector(".topbar.dock")?.getBoundingClientRect().top;
      setBottom(top === undefined ? 0 : Math.max(0, Math.min(window.innerHeight, window.innerHeight - top)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [shown]);
  return bottom;
}

/** The minimized alert: a bar above the dock (it used to cover the dock, hiding Help and Stop). */
function MiniBar({ alert, onShow }: { alert: AlertDetail; onShow: () => void }) {
  const bottom = useAboveDock();
  return (
    <div className="ll-minibar" role="status" style={{ bottom }}>
      <Icon name="check" />
      <span>
        <strong>{alert.acknowledged_by} is on the way.</strong> Answered {clockTime(alert.acknowledged_at)}.
      </span>
      <span className="spacer" />
      <button className="btn" onClick={onShow} data-dwell>
        <Icon name="bell" /> Show alert
      </button>
    </div>
  );
}

type View = "main" | "situation" | "ok" | "ambulance";

function Active({ alert }: { alert: AlertDetail }) {
  const ll = useLifeline();
  const [view, setView] = useState<View>("main");
  const [minimized, setMinimized] = useState(false);
  useNow(1000);
  useSelectionReset(`${alert.id}-${alert.status}-${view}`);
  const settings = ll.status?.settings;
  const acked = alert.status === "acknowledged";
  const next = settings ? nextStep(alert, settings) : null;
  const test = alert.is_test;
  const canAskAmbulance = !!settings?.dispatch.consent && !alert.dispatch?.active;

  if (alert.pending_question) return <Question alert={alert} />;
  if (view === "situation") return <SituationPicker alert={alert} onDone={() => setView("main")} />;
  if (view === "ambulance") return <ConfirmAmbulance alert={alert} onDone={() => setView("main")} />;

  if (acked && minimized) return <MiniBar alert={alert} onShow={() => setMinimized(false)} />;

  let title: string;
  let tone: "danger" | "ok" | "test";
  if (acked) {
    title = `${alert.acknowledged_by ?? "Someone"} is on the way`;
    tone = test ? "test" : "ok";
  } else if (alert.local_only) {
    title = "Alarm sounding";
    tone = test ? "test" : "danger";
  } else {
    title = test ? "Test alert: calling your contacts" : "Help is being called";
    tone = test ? "test" : "danger";
  }

  return (
    <Frame tone={tone} title={title} label={title}>
      {test && <p className="ll-badge">TEST, not an emergency</p>}
      {alert.kind !== "help" && (
        <p className="ll-why">
          {alert.what}.{alert.detail ? ` ${alert.detail}` : ""}
        </p>
      )}
      {alert.situation && (
        <p className="ll-says" data-critical={alert.urgency === "critical" ? "" : undefined}>
          You said: {alert.situation_label.toLowerCase()}
          {alert.urgency === "critical" ? " (critical: everyone has been alerted)" : ""}
        </p>
      )}
      {!ll.online && (
        <p className="ll-warning" role="alert">
          <Icon name="offline" /> This screen lost contact with the coordinator. The coordinator keeps calling
          people on its own; the alarm here keeps sounding.
        </p>
      )}
      {acked ? (
        <p className="ll-lead">
          {alert.acknowledged_by} answered {seconds(alert.metrics.seconds_to_acknowledged)} after your signal,
          at {clockTime(alert.acknowledged_at)}.
          {alert.notifications.some((n) => n.purpose === "stand_down") ? " Everyone else has been told." : ""}
        </p>
      ) : alert.local_only ? (
        <p className="ll-lead">
          Lifeline can't contact anyone: {ll.status?.problems[0] ?? "no contacts are set up."} The alarm is
          sounding so people nearby can hear.
        </p>
      ) : (
        <p className="ll-lead">
          {alert.waiting_on.length
            ? `Waiting for ${names(alert.waiting_on.map((name) => ({ name })))} to answer.`
            : "Contacting the next person."}{" "}
          {next}
        </p>
      )}
      <Progress alert={alert} />
      <Contacts alert={alert} />
      {view === "ok" ? (
        <ConfirmOk
          busy={ll.busy}
          onNo={() => setView("main")}
          onYes={() => {
            setView("main");
            void ll.resolve();
          }}
        />
      ) : (
        <div className="ll-actions ll-four">
          {!alert.local_only && (
            <button
              className={`btn btn-xl ${alert.situation ? "" : "btn-solid-danger"}`}
              onClick={() => setView("situation")}
              data-dwell
              disabled={ll.busy}
            >
              <Icon name="message" size={30} />{" "}
              {alert.situation ? "Change what's wrong" : "Tell them what's wrong"}
            </button>
          )}
          {canAskAmbulance && (
            <button className="btn btn-xl" onClick={() => setView("ambulance")} data-dwell disabled={ll.busy}>
              <Icon name="bell" size={30} /> Ask for an ambulance
            </button>
          )}
          {acked ? (
            <button className="btn btn-xl" onClick={() => setMinimized(true)} data-dwell>
              <Icon name="down" size={30} /> Minimize
            </button>
          ) : (
            <button
              className="btn btn-xl"
              onClick={ll.silence}
              data-dwell
              disabled={ll.silenced}
              aria-pressed={ll.silenced}
            >
              <Icon name="mute" size={30} /> {ll.silenced ? "Alarm silenced" : "Silence alarm"}
            </button>
          )}
          <button
            className="btn btn-xl btn-primary"
            onClick={() => setView("ok")}
            data-dwell
            disabled={ll.busy}
          >
            <Icon name="check" size={30} /> I&apos;m OK now
          </button>
        </div>
      )}
      {alert.notifications.some((n) => n.channel === "demo") && (
        <p className="ll-note">
          Demo: these contacts use simulated phones.{" "}
          <a href="#/phones" target="agency-phones">
            Open the simulated phones
          </a>{" "}
          to answer as one of them.
        </p>
      )}
      <ol className="ll-events" aria-label="Latest updates">
        {alert.events
          .filter((e) => e.kind !== "signal_repeated")
          .slice(-3)
          .map((e) => (
            <li key={e.id}>
              <time>{clockTime(e.ts)}</time> {e.message}
            </li>
          ))}
      </ol>
    </Frame>
  );
}

function Queued() {
  const ll = useLifeline();
  const q = ll.queued!;
  useSelectionReset(`queued-${q.at}`);
  const trying = q.attempts > 0;
  return (
    <Frame
      tone={q.test ? "test" : "danger"}
      title={trying ? "Can't reach the coordinator yet" : "Calling for help"}
      label="Calling for help"
    >
      {trying ? (
        <p className="ll-lead">
          {q.test
            ? "The test alert couldn't be sent yet. AGENCY keeps trying."
            : "The alarm is sounding here so anyone nearby can hear. AGENCY keeps trying to send your alert"}
          {` (tried ${q.attempts} ${q.attempts === 1 ? "time" : "times"}).`}
        </p>
      ) : (
        <p className="ll-lead">Sending your alert…</p>
      )}
      {q.lastError && <p className="ll-note">Last problem: {q.lastError}</p>}
      <div className="ll-actions">
        <button
          className="btn btn-xl ll-cancel"
          onClick={() => void ll.cancel()}
          data-dwell
          data-dwell-scale="2"
        >
          <Icon name="x" size={30} /> Cancel, I'm OK
        </button>
        <button className="btn btn-xl" onClick={ll.silence} data-dwell disabled={ll.silenced || q.test}>
          <Icon name="mute" size={30} /> {ll.silenced ? "Alarm silenced" : "Silence alarm"}
        </button>
      </div>
    </Frame>
  );
}

function Checkin() {
  const ll = useLifeline();
  const now = useNow(500);
  useSelectionReset("checkin");
  const s = ll.status!;
  const since = Date.parse(s.monitor.checkin_pending_since ?? "");
  const deadline = since + s.settings.checkin_response_s * 1000;
  const left = Math.max(0, Math.ceil((deadline - (now + ll.offsetMs)) / 1000));
  const first = s.settings.contacts.filter((c) => c.enabled).sort((a, b) => a.priority - b.priority)[0];
  return (
    <Frame tone="calm" title="Check-in: are you OK?" label="Check-in">
      <p className="ll-lead">
        Look at <strong>I'm OK</strong> to answer. If there's no answer in {left} seconds, AGENCY will alert{" "}
        {first ? first.name : "your contacts"}.
      </p>
      <div className="ll-actions">
        <button
          className="btn btn-xl btn-primary"
          onClick={() => void ll.checkinOk("dwell")}
          data-dwell
          disabled={ll.busy}
        >
          <Icon name="check" size={30} /> I'm OK
        </button>
        <button
          className="btn btn-xl btn-solid-danger"
          onClick={() => void ll.requestHelp("help_button")}
          data-dwell
          disabled={ll.busy}
        >
          <Icon name="bell" size={30} /> I need help
        </button>
      </div>
    </Frame>
  );
}

/** Progress of the three-long-blink help signal, shown once the first long blink counts. */
export function HelpSignalMeter() {
  const { pattern, open, queued } = useLifeline();
  // Above the dock (it used to sit over the dock's middle buttons).
  const bottom = useAboveDock(!open && !queued && pattern.counted > 0);
  if (open || queued || pattern.counted === 0) return null;
  return (
    <div className="ll-meter" role="status" aria-live="polite" style={{ bottom: bottom + 12 }}>
      <Icon name="eye" />
      <span>Help signal: {pattern.counted} of 3 long blinks</span>
      <span className="ll-dots" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} data-on={i < pattern.counted ? "" : undefined} />
        ))}
      </span>
    </div>
  );
}

export function LifelineOverlay() {
  const ll = useLifeline();
  if (ll.queued) return <Queued />;
  const alert = ll.open;
  if (alert?.status === "pending_cancel") return <Pending alert={alert} />;
  if (alert && (alert.status === "active" || alert.status === "acknowledged"))
    return <Active key={alert.id} alert={alert} />;
  if (ll.status?.monitor.checkin_pending_since) return <Checkin />;
  return <HelpSignalMeter />;
}
