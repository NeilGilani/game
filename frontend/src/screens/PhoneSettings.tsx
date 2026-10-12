/**
 * Settings, Calls and texts: the switch for real calls and texts through the person's own iPhone (Mac app only), how
 * they go, who can get them, and what a helper sets up on the Mac and the iPhone. Off until switched on here.
 */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import {
  changeRealSettings,
  messagingSource,
  onRealStatus,
  realStatus,
  refreshReal,
  type MessagingStatus,
} from "../state/realMessaging";
import { Toggle } from "./SettingsViews";

function Choice({ label, sub, on, onPick }: { label: string; sub: string; on: boolean; onPick: () => void }) {
  return (
    <button
      className="tile"
      style={{ minHeight: 110 }}
      role="radio"
      aria-checked={on}
      onClick={onPick}
      data-dwell
    >
      <span className="tile-title">{label}</span>
      <span className="tile-sub">{sub}</span>
      <span className="tile-check">
        <Icon name="check" size={22} />
      </span>
    </button>
  );
}

export function PhoneSettings() {
  const announce = useAnnounce();
  const [status, setStatus] = useState<MessagingStatus>(realStatus);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const source = messagingSource();

  useEffect(() => {
    const off = onRealStatus(setStatus);
    void refreshReal();
    return off;
  }, []);

  const change = async (c: Parameters<typeof changeRealSettings>[0], said: string) => {
    try {
      await changeRealSettings(c);
      setNote(said);
      announce(said);
    } catch {
      setNote("That didn't save. Try again.");
    }
  };

  const check = async () => {
    if (!source) return;
    setBusy(true);
    try {
      const r = await source.check();
      setNote(r.message);
      announce(r.message);
    } catch {
      setNote("AGENCY couldn't ask Messages just now.");
    } finally {
      setBusy(false);
    }
  };

  const s = status.settings;
  return (
    <Page label="Calls and texts">
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Real calls and texts through your iPhone</h1>
          <p>
            Off until you turn it on. Then AGENCY can text and call your saved people from your own number,
            using this Mac's Messages app and your iPhone. Every text and every call asks you first, with the
            exact person and words on screen. Nothing goes out without your OK, and Stop ends it.
          </p>
        </div>
        <button className="btn" onClick={() => navigate("/settings")} data-dwell>
          <Icon name="gear" /> All settings
        </button>
      </div>

      {!source || !status.available ? (
        <section className="panel panel-muted stack" aria-label="Not available here">
          <h2>
            <Icon name="info" /> Practice only here
          </h2>
          <p>
            {status.reason ?? "Real calls and texts need the AGENCY Mac app."} Calls and messages here are
            practice: nothing real is sent.
          </p>
        </section>
      ) : (
        <>
          <div className="grid grid-2">
            <Toggle
              label="Real calls and texts through your iPhone"
              value={s.enabled}
              onChange={(v) =>
                void change(
                  { enabled: v },
                  v
                    ? "Real calls and texts are on. Each one still asks you first."
                    : "Real calls and texts are off.",
                )
              }
              help={s.enabled ? "Each one asks you first" : "Only practice"}
            />
            <button
              className="tile"
              style={{ minHeight: 120 }}
              onClick={() => void check()}
              disabled={busy}
              data-dwell
            >
              <span className="tile-title">
                <Icon name="message" /> Check Messages
              </span>
              <span className="tile-sub">Asks Messages what it can send. Sends nothing.</span>
            </button>
          </div>
          {note && (
            <p className="panel" role="status">
              {note}
            </p>
          )}

          <section className="stack" aria-label="How texts go">
            <h2>
              <Icon name="message" /> Texts
            </h2>
            <div className="grid grid-2" role="radiogroup" aria-label="How texts go">
              <Choice
                label="iMessage first"
                sub="Falls back to a text through your iPhone only when this Mac has no iMessage"
                on={s.textVia === "auto"}
                onPick={() => void change({ textVia: "auto" }, "Texts go by iMessage.")}
              />
              <Choice
                label="Text message (green)"
                sub="Always through your iPhone, for people without an iPhone"
                on={s.textVia === "sms"}
                onPick={() =>
                  void change({ textVia: "sms" }, "Texts go as text messages through your iPhone.")
                }
              />
            </div>
          </section>

          <section className="stack" aria-label="How calls go">
            <h2>
              <Icon name="phone" /> Calls
            </h2>
            <div className="grid grid-2" role="radiogroup" aria-label="How calls go">
              <Choice
                label="Phone call"
                sub="Your iPhone makes the call; this Mac is the speaker and microphone"
                on={s.callVia === "phone"}
                onPick={() => void change({ callVia: "phone" }, "Calls go through your iPhone.")}
              />
              <Choice
                label="FaceTime audio"
                sub="Over the internet, to people with an iPhone, iPad or Mac"
                on={s.callVia === "facetime"}
                onPick={() => void change({ callVia: "facetime" }, "Calls go by FaceTime audio.")}
              />
            </div>
            <p className="small">
              Your Mac asks to confirm each call: look at Call in the box it shows. On a call, AGENCY's voice
              plays from this Mac's speakers. The Mac's echo cancelling may take it out, so the other person
              might not hear it clearly. Try it once with someone you know. That's why AGENCY offers to text
              first, and texting always works during a call.
            </p>
          </section>

          <section className="stack" aria-label="Who can get them">
            <h2>
              <Icon name="name" /> Who can get them
            </h2>
            {!s.enabled ? (
              <p className="muted">Turn it on to see your saved people here.</p>
            ) : status.people.length ? (
              <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
                {status.people.map((p) => (
                  <li key={p.id} className="panel">
                    <strong>{p.name}</strong> · {p.display}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="panel panel-warn">
                Nobody yet. Add people in Lifeline, People to contact, with a phone number and Text or Text
                and call.
              </p>
            )}
            <p className="small muted">
              Only these people, never a number typed in by AGENCY. Emergency and crisis numbers are never
              called or texted from here: for an emergency, use Lifeline.
            </p>
            <div>
              <button className="btn" onClick={() => navigate("/lifeline/setup")} data-dwell>
                <Icon name="lifeline" /> Edit saved people in Lifeline
              </button>
            </div>
          </section>

          <section className="panel stack" aria-label="For a helper">
            <h2>
              <Icon name="wrench" /> For a helper: set up once
            </h2>
            <ol className="stack">
              <li>
                On this Mac, open Messages and sign in with the person's Apple Account (Settings, iMessage).
              </li>
              <li>
                For green text messages: on the iPhone, Settings, Apps, Messages, Text Message Forwarding,
                switch on this Mac.
              </li>
              <li>
                For calls: on the iPhone, Settings, Apps, Phone, Calls on Other Devices, switch on this Mac.
                On the Mac, FaceTime, Settings, switch on Calls from iPhone. Both use the same Apple Account
                and Wi-Fi.
              </li>
              <li>
                Press Check Messages above. The first time, macOS asks whether AGENCY may control Messages:
                choose Allow. To change it later: System Settings, Privacy & Security, Automation, AGENCY,
                Messages.
              </li>
            </ol>
            <p className="small muted">
              A record of each real text and call (who, when, whether it went, not the words) stays on this
              Mac.
            </p>
          </section>
        </>
      )}
    </Page>
  );
}
