/**
 * The caregiver's phone companion: a web page served by AGENCY on the home network (no app store).
 *
 * Made for one hand and a quick look: big type, big buttons, the four places in a bar at the bottom, strong
 * contrast that holds up in bright light. Home first: is an alert open, is AGENCY running, camera, battery.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  codeFromHash,
  deviceToken,
  phoneApi,
  PhoneError,
  setDeviceToken,
  when,
  whenUnpaired,
  type Contact,
  type Home,
} from "./phoneApi";
import { NotesScreen, SendScreen } from "./Together";
import { SetupScreen } from "./Setup";

export type Tab = "home" | "send" | "notes" | "setup";
const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: "home", label: "Home", glyph: "⌂" },
  { id: "send", label: "Send", glyph: "✉" },
  { id: "notes", label: "Notes", glyph: "✎" },
  { id: "setup", label: "Set up", glyph: "⚙" },
];

function tabFromHash(): { tab: Tab; rest: string } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [first, ...rest] = raw.split("/");
  const tab = (TABS.find((t) => t.id === first)?.id ?? "home") as Tab;
  return { tab, rest: rest.join("/") };
}

function useRoute() {
  const [route, setRoute] = useState(tabFromHash);
  useEffect(() => {
    const on = () => setRoute(tabFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function PhoneApp() {
  const [paired, setPaired] = useState(() => !!deviceToken());
  const [pairCode] = useState(() => codeFromHash(window.location.hash));
  const [linking, setLinking] = useState(false);
  const route = useRoute();

  useEffect(() => {
    whenUnpaired(() => setPaired(false));
    // The pairing code came in the address: take it out, so it isn't kept in the browser's history.
    if (codeFromHash(window.location.hash)) history.replaceState(null, "", window.location.pathname);
  }, []);

  if (!paired)
    return (
      <PairScreen
        initialCode={pairCode ?? ""}
        onPaired={() => {
          setPaired(true);
          setLinking(true);
        }}
      />
    );
  if (linking) return <LinkScreen onDone={() => setLinking(false)} />;

  return (
    <div className="ph-shell">
      <main className="ph-main" id="main">
        {route.tab === "home" && <HomeScreen />}
        {route.tab === "send" && <SendScreen />}
        {route.tab === "notes" && <NotesScreen />}
        {route.tab === "setup" && <SetupScreen section={route.rest} onForgotten={() => setPaired(false)} />}
      </main>
      <nav className="ph-tabs" aria-label="Companion">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={`#/${t.id}`}
            className="ph-tab"
            aria-current={route.tab === t.id ? "page" : undefined}
          >
            <span aria-hidden className="ph-tab-glyph">
              {t.glyph}
            </span>
            {t.label}
          </a>
        ))}
      </nav>
    </div>
  );
}

// -- pairing ---------------------------------------------------------------------------------------

function PairScreen({ initialCode, onPaired }: { initialCode: string; onPaired: () => void }) {
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null);
    if (!/^\d{6}$/.test(code)) return setError("The code is the six numbers on the Mac's screen.");
    if (!name.trim()) return setError("Type your name, so everyone knows who changed what.");
    setBusy(true);
    try {
      const { token } = await phoneApi.pair(code, name.trim());
      setDeviceToken(token);
      onPaired();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="ph-main ph-pair">
      <h1>Pair with AGENCY</h1>
      <p>
        At the Mac, open Settings, For a helper, Caregiver phones, and choose <b>Show a pairing code</b>.
      </p>
      <form
        className="ph-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="ph-field">
          <span>Code on the Mac</span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="ph-code-input"
            aria-describedby="code-help"
          />
        </label>
        <p id="code-help" className="ph-muted">
          Six numbers. A code works once and only for a few minutes.
        </p>
        <label className="ph-field">
          <span>Your name</span>
          <input
            autoComplete="given-name"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && (
          <p className="ph-error" role="alert">
            {error}
          </p>
        )}
        <button className="ph-btn ph-primary" type="submit" disabled={busy}>
          {busy ? "Pairing…" : "Pair this phone"}
        </button>
      </form>
    </main>
  );
}

function LinkScreen({ onDone }: { onDone: () => void }) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [person, setPerson] = useState("the person");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([phoneApi.setup(), phoneApi.home()]).then(
      ([s, h]) => {
        setContacts(s.contacts.filter((c) => c.role !== "monitoring_service"));
        setPerson(h.person);
      },
      () => onDone(),
    );
  }, [onDone]);
  const pick = async (id: string | null) => {
    try {
      await phoneApi.link(id);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    }
  };
  if (!contacts) return <main className="ph-main ph-pair">Paired. One moment…</main>;
  return (
    <main className="ph-main ph-pair">
      <h1>Paired</h1>
      <p>
        Are you on {person}&apos;s Lifeline list? Then this phone can open your alerts and say you&apos;re on
        your way.
      </p>
      <div className="ph-stack">
        {contacts.map((c) => (
          <button key={c.id} className="ph-btn" onClick={() => void pick(c.id)}>
            I&apos;m {c.name}
          </button>
        ))}
        <button className="ph-btn ph-quiet" onClick={() => void pick(null)}>
          I&apos;m not on the list
        </button>
      </div>
      {error && (
        <p className="ph-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}

// -- home --------------------------------------------------------------------------------------------

/** A short, loud beep and a buzz when a new alert opens (only works after the first tap on the page). */
function useAlertSignal(alertId: string | null, active: boolean) {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!alertId || !active || last.current === alertId) return;
    last.current = alertId;
    try {
      navigator.vibrate?.([400, 200, 400, 200, 400]);
    } catch {
      /* no vibration on this phone */
    }
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.4;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.8);
      osc.onended = () => void ctx.close();
    } catch {
      /* sound blocked until the page is tapped */
    }
  }, [alertId, active]);
}

export function HomeScreen() {
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setHome(await phoneApi.home());
      setError(null);
    } catch (err) {
      if (err instanceof PhoneError && err.status === 401) return;
      setError(err instanceof Error ? err.message : "Can't reach AGENCY.");
    }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 4000);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);
  useAlertSignal(home?.alert?.id ?? null, home?.alert?.status === "active");
  useEffect(() => {
    document.title =
      home?.alert && home.alert.status !== "acknowledged" ? "ALERT: AGENCY" : "AGENCY companion";
  }, [home?.alert]);

  if (!home)
    return (
      <div className="ph-stack">
        <h1>AGENCY</h1>
        <p>{error ?? "Loading…"}</p>
      </div>
    );
  const name = home.person;
  return (
    <div className="ph-stack">
      {error && (
        <p className="ph-error" role="alert">
          {error} Showing what AGENCY last said.
        </p>
      )}
      {home.alert ? <AlertCard home={home} /> : null}
      <h1 className="ph-hello">{name}</h1>
      <ul className="ph-status" aria-label="How AGENCY is doing">
        <StatusRow
          ok={home.running}
          label={home.running ? "AGENCY is running" : "AGENCY isn't answering"}
          sub={home.running ? "" : home.last_heard_at ? `Last heard from at ${when(home.last_heard_at)}` : ""}
        />
        <StatusRow
          ok={home.camera.ok}
          label={
            !home.running
              ? "Camera: not known"
              : home.camera.ok
                ? "Camera OK"
                : home.camera.state !== "on"
                  ? "Camera is off"
                  : `Camera can't see ${name}'s eyes`
          }
        />
        <StatusRow
          ok={!home.battery.known ? null : (home.battery.level ?? 0) > 0.2 || !!home.battery.charging}
          label={
            home.battery.known
              ? `Battery ${Math.round((home.battery.level ?? 0) * 100)}%${home.battery.charging ? ", charging" : ""}${
                  (home.battery.level ?? 0) > 0.2 || home.battery.charging ? " · OK" : " · plug it in"
                }`
              : "Battery: not known"
          }
        />
        <StatusRow
          ok={home.watch.armed ? !home.watch.checkin_pending_since : null}
          label={home.watch.armed ? "Watch over me is on" : "Watch over me is off"}
          sub={
            home.watch.checkin_pending_since
              ? `A check-in is waiting for ${name}'s answer`
              : home.watch.checkin_last_ok_at
                ? `${name} answered a check-in at ${when(home.watch.checkin_last_ok_at)}`
                : ""
          }
        />
      </ul>
      {home.waiting_for_person > 0 && (
        <p className="ph-note">
          {home.waiting_for_person === 1 ? "1 change is" : `${home.waiting_for_person} changes are`} waiting
          for {name} to allow on their screen.
        </p>
      )}
      {home.lifeline_problems.length > 0 && (
        <section className="ph-card" aria-label="Lifeline needs attention">
          <h2>Lifeline needs attention</h2>
          <ul>
            {home.lifeline_problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}
      <div className="ph-row">
        <a className="ph-btn" href="#/send">
          Send {name} a message
        </a>
      </div>
      {home.recent_alerts.length > 0 && (
        <section className="ph-card" aria-label="Recent alerts">
          <h2>Recent alerts</h2>
          <ul className="ph-list">
            {home.recent_alerts.map((a) => (
              <li key={a.id}>
                <b>{when(a.created_at)}</b> {a.is_test ? "(test) " : ""}
                {a.what}.{" "}
                {a.acknowledged_by
                  ? `${a.acknowledged_by} answered.`
                  : a.status === "cancelled"
                    ? "Cancelled."
                    : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="ph-muted">
        This page shows alerts while it&apos;s open. Lifeline still texts and calls the people on its list as
        usual. AGENCY is not an emergency service.
      </p>
    </div>
  );
}

function StatusRow({ ok, label, sub }: { ok: boolean | null; label: string; sub?: string }) {
  return (
    <li className="ph-status-row" data-ok={ok === null ? "unknown" : ok ? "yes" : "no"}>
      <span aria-hidden className="ph-dot">
        {ok === null ? "?" : ok ? "✓" : "!"}
      </span>
      <span>
        {label}
        {sub ? <span className="ph-sub">{sub}</span> : null}
      </span>
    </li>
  );
}

function AlertCard({ home }: { home: Home }) {
  const a = home.alert!;
  const acked = a.status === "acknowledged";
  return (
    <section className="ph-alert" data-state={a.is_test ? "test" : acked ? "ok" : "danger"} role="alert">
      <h2>
        {a.is_test
          ? "TEST alert"
          : acked
            ? `${a.acknowledged_by ?? "Someone"} is on the way`
            : `${home.person} needs help`}
      </h2>
      <p>{a.what}.</p>
      {a.situation_label && (
        <p>
          <b>
            {home.person} says: {a.situation_label.toLowerCase()}
          </b>
        </p>
      )}
      {a.respond_path ? (
        <a className="ph-btn ph-on-alert" href={a.respond_path}>
          Open the alert
        </a>
      ) : home.device.contact_id ? (
        <p>AGENCY is asking other people first. You&apos;ll get a link here if it asks you.</p>
      ) : (
        <p>
          This phone isn&apos;t on the Lifeline list, so it can&apos;t answer the alert. Go to {home.person}{" "}
          or call them.
        </p>
      )}
      {a.contacted.length > 0 && (
        <p className="ph-small">
          Asked so far:{" "}
          {a.contacted
            .map(
              (c) =>
                `${c.name}${c.response === "acknowledged" ? " (on the way)" : c.response === "declined" ? " (can't come)" : ""}`,
            )
            .join(", ")}
        </p>
      )}
    </section>
  );
}
