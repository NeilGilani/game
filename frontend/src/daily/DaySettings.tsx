/**
 * Settings, For a helper, My day and home: easiest with a keyboard and mouse. Who a request may go to and whether
 * that's on, the day's appointments and visits, care reminders, and the home's devices (named Apple Shortcuts).
 * Everything starts off or empty; nothing real happens until it is set up here, with the person.
 */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import { Toggle } from "../screens/SettingsViews";
import { carerSource, type CarerView } from "./carer";
import {
  HOME_KINDS,
  HOME_LIMITS,
  homeSource,
  KIND_WORDS as HOME_KIND_WORDS,
  refusedHomeReason,
  type HomeAction,
  type HomeDevice,
  type HomeDeviceKind,
  type HomeSetup,
  type HomeStatus,
} from "./homeControl";
import {
  clock,
  dayKey,
  every,
  KIND_WORDS,
  MAX_ITEMS,
  MAX_ROUTINES,
  MAX_TITLE,
  newRoutine,
  ROUTINE_PRESETS,
  sampleDay,
  validTime,
  type ItemKind,
  type Repeat,
  type Routine,
  type RoutineKind,
} from "./model";
import { clearDaily, newId, practiceMode, saveDaily, updateDaily, useDaily } from "./store";
import "./daily.css";

const REPEAT_WORDS: Record<Repeat, string> = {
  once: "Just that day",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Every week",
};

const EVERY_CHOICES = [30, 60, 90, 120, 180, 240, 360, 480];
const SNOOZE_CHOICES = [10, 15, 30, 60];

// ---- Tell my carer --------------------------------------------------------------------------------------------

function CarerSection() {
  const announce = useAnnounce();
  const source = carerSource();
  const [view, setView] = useState<CarerView | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    source
      .view()
      .then(setView, (err: unknown) =>
        setNote(err instanceof Error ? err.message : "Couldn't reach the coordinator."),
      );
  }, [source]);

  const save = async (change: { notify_enabled?: boolean; carer_id?: string | null }) => {
    if (!view) return;
    try {
      const next = await source.save({
        notify_enabled: change.notify_enabled ?? view.settings.notify_enabled,
        carer_id: change.carer_id !== undefined ? change.carer_id : view.settings.carer_id,
      });
      setView(next);
      const text = next.settings.notify_enabled
        ? `Requests can go to ${next.carer?.name ?? "the first Lifeline contact"}. Each one asks the person first.`
        : "Telling a carer is off.";
      setNote(text);
      announce(text);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "That didn't save.");
    }
  };

  return (
    <section className="panel stack" aria-labelledby="h-carer">
      <h2 id="h-carer">
        <Icon name="message" /> Tell my carer
      </h2>
      <p>
        Lets the person send a non-urgent request (&ldquo;I&rsquo;m cold&rdquo;, a care reminder, something on
        their day) to one carer. It is off until you turn it on together. Each request shows the exact words
        and who gets them, and waits for the person to confirm. It is one text, never a call, and never
        Lifeline: for emergencies they use Help.
      </p>
      {view ? (
        <>
          <Toggle
            label="Tell my carer"
            value={view.settings.notify_enabled}
            onChange={(v) => void save({ notify_enabled: v })}
            help={view.settings.notify_enabled ? "Each request asks first" : "Nothing is sent"}
          />
          {view.contacts.length === 0 ? (
            <p className="muted">
              No Lifeline contacts yet. Add one in <a href="#/lifeline/setup">Lifeline setup</a> first.
            </p>
          ) : (
            <div className="grid grid-2" role="radiogroup" aria-label="Who gets requests">
              {view.contacts.map((c) => (
                <button
                  key={c.id}
                  className="tile"
                  role="radio"
                  aria-checked={view.carer?.id === c.id}
                  onClick={() => void save({ carer_id: c.id })}
                  data-dwell
                >
                  <span className="tile-title">{c.name}</span>
                  <span className="tile-sub">By {c.how}</span>
                  <span className="tile-check">
                    <Icon name="check" size={22} />
                  </span>
                </button>
              ))}
            </div>
          )}
          {source.kind === "practice" && (
            <p className="muted">Practice: Jordan is a pretend carer on this page. Nobody is contacted.</p>
          )}
        </>
      ) : (
        !note && <p className="muted">Checking…</p>
      )}
      {note && <p role="status">{note}</p>}
    </section>
  );
}

// ---- My day ---------------------------------------------------------------------------------------------------

function DaySection() {
  const data = useDaily();
  const announce = useAnnounce();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ItemKind>("appointment");
  const [date, setDate] = useState(() => dayKey(Date.now()));
  const [time, setTime] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("once");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const t = title.replace(/\s+/g, " ").trim();
    if (!t) return setError("Type what it is.");
    if (time && !validTime(time)) return setError("That time isn't valid.");
    if (data.items.length >= MAX_ITEMS) return setError(`At most ${MAX_ITEMS} items. Remove some first.`);
    updateDaily((d) => ({
      ...d,
      items: [
        ...d.items,
        {
          id: newId("h"),
          title: t.slice(0, MAX_TITLE),
          kind,
          date,
          time: time || null,
          repeat,
          addedBy: "helper",
        },
      ],
    }));
    setTitle("");
    setTime("");
    setError(null);
    announce(`Added: ${t}.`);
  };

  return (
    <section className="panel stack" aria-labelledby="h-day">
      <h2 id="h-day">
        <Icon name="calendar" /> My day
      </h2>
      <p className="muted">
        Kept on this computer only. Calendar import from the Mac isn&rsquo;t available yet, so add things
        here.
      </p>
      {data.items.length > 0 && (
        <ul className="day-setup-list" aria-label="Planned">
          {data.items.map((i) => (
            <li key={i.id}>
              <span>
                <strong>{i.title}</strong> · {KIND_WORDS[i.kind]} · {i.date}
                {i.time ? ` at ${clock(i.time)}` : ", any time"} · {REPEAT_WORDS[i.repeat]}
                {i.addedBy === "person" ? " · added by the person" : ""}
              </span>
              <button
                className="btn"
                onClick={() => updateDaily((d) => ({ ...d, items: d.items.filter((x) => x.id !== i.id) }))}
                aria-label={`Remove ${i.title}`}
              >
                <Icon name="x" /> Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="day-setup-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label className="field">
          <span>What</span>
          <input value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
            {(Object.keys(KIND_WORDS) as ItemKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_WORDS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Day</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value || dayKey(Date.now()))} />
        </label>
        <label className="field">
          <span>Time (empty: any time)</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label className="field">
          <span>Repeats</span>
          <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
            {(Object.keys(REPEAT_WORDS) as Repeat[]).map((r) => (
              <option key={r} value={r}>
                {REPEAT_WORDS[r]}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" type="submit">
          <Icon name="plus" /> Add to the day
        </button>
      </form>
      {error && (
        <p className="ll-field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// ---- Care reminders -------------------------------------------------------------------------------------------

function RoutineRow({ r }: { r: Routine }) {
  const change = (c: Partial<Routine>) =>
    updateDaily((d) => ({ ...d, routines: d.routines.map((x) => (x.id === r.id ? { ...x, ...c } : x)) }));
  return (
    <li className="day-setup-routine">
      <label className="field">
        <span>Reminder</span>
        <input
          value={r.label}
          maxLength={MAX_TITLE}
          onChange={(e) => e.target.value.trim() && change({ label: e.target.value })}
        />
      </label>
      <label className="field">
        <span>How often</span>
        <select value={r.everyMinutes} onChange={(e) => change({ everyMinutes: Number(e.target.value) })}>
          {[...new Set([...EVERY_CHOICES, r.everyMinutes])].map((m) => (
            <option key={m} value={m}>
              {every(m)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>From</span>
        <input
          type="time"
          value={r.from}
          onChange={(e) => validTime(e.target.value) && change({ from: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Until</span>
        <input
          type="time"
          value={r.to}
          onChange={(e) => validTime(e.target.value) && change({ to: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Later means</span>
        <select value={r.snoozeMinutes} onChange={(e) => change({ snoozeMinutes: Number(e.target.value) })}>
          {SNOOZE_CHOICES.map((m) => (
            <option key={m} value={m}>
              {m} minutes
            </option>
          ))}
        </select>
      </label>
      <label className="ll-inline">
        <input type="checkbox" checked={r.enabled} onChange={(e) => change({ enabled: e.target.checked })} />{" "}
        On
      </label>
      <button
        className="btn"
        onClick={() => updateDaily((d) => ({ ...d, routines: d.routines.filter((x) => x.id !== r.id) }))}
        aria-label={`Remove ${r.label}`}
      >
        <Icon name="x" /> Remove
      </button>
    </li>
  );
}

function RoutineSection() {
  const data = useDaily();
  const [custom, setCustom] = useState("");
  const add = (kind: RoutineKind, label?: string) => {
    if (data.routines.length >= MAX_ROUTINES) return;
    updateDaily((d) => ({ ...d, routines: [...d.routines, newRoutine(kind, newId("r"), label)] }));
  };
  return (
    <section className="panel stack" aria-labelledby="h-care">
      <h2 id="h-care">
        <Icon name="clock" /> Care reminders
      </h2>
      <p>
        Gentle prompts during waking hours that the person can do, snooze or ask a carer about. How often is
        for the person and their care team to decide; the starting times below are only examples. These are
        not medication dosing advice and not clinical alarms: nothing happens if a reminder is ignored.
      </p>
      {data.routines.length > 0 && (
        <ul className="day-setup-list" aria-label="Care reminders">
          {data.routines.map((r) => (
            <RoutineRow key={r.id} r={r} />
          ))}
        </ul>
      )}
      <div className="day-setup-buttons">
        {(Object.keys(ROUTINE_PRESETS) as (keyof typeof ROUTINE_PRESETS)[]).map((k) => (
          <button
            key={k}
            className="btn"
            onClick={() => add(k)}
            disabled={data.routines.length >= MAX_ROUTINES}
          >
            <Icon name="plus" /> {ROUTINE_PRESETS[k].label}
          </button>
        ))}
      </div>
      <form
        className="day-setup-form"
        onSubmit={(e) => {
          e.preventDefault();
          const label = custom.replace(/\s+/g, " ").trim();
          if (label) add("custom", label.slice(0, MAX_TITLE));
          setCustom("");
        }}
      >
        <label className="field">
          <span>Another reminder</span>
          <input value={custom} maxLength={MAX_TITLE} onChange={(e) => setCustom(e.target.value)} />
        </label>
        <button className="btn" type="submit" disabled={!custom.trim()}>
          <Icon name="plus" /> Add
        </button>
      </form>
    </section>
  );
}

// ---- The home -------------------------------------------------------------------------------------------------

function defaultActions(name: string, kind: HomeDeviceKind): HomeAction[] {
  if (kind === "thermostat")
    return [
      { id: "warmer", label: "Warmer", shortcut: `${name} warmer` },
      { id: "cooler", label: "Cooler", shortcut: `${name} cooler` },
    ];
  if (kind === "blinds")
    return [
      { id: "open", label: "Open", shortcut: `${name} open`, state: "Open" },
      { id: "close", label: "Close", shortcut: `${name} close`, state: "Closed" },
    ];
  return [
    { id: "on", label: "On", shortcut: `${name} on` },
    { id: "off", label: "Off", shortcut: `${name} off` },
  ];
}

function ActionRow({
  a,
  names,
  onChange,
  onRemove,
}: {
  a: HomeAction;
  names: string;
  onChange: (a: HomeAction) => void;
  onRemove: () => void;
}) {
  return (
    <li className="day-setup-action">
      <label className="field">
        <span>Button</span>
        <input
          value={a.label}
          maxLength={HOME_LIMITS.label}
          onChange={(e) => onChange({ ...a, label: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Shortcut&rsquo;s exact name</span>
        <input
          value={a.shortcut}
          maxLength={HOME_LIMITS.shortcut}
          list={names}
          onChange={(e) => onChange({ ...a, shortcut: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Value for the shortcut (optional)</span>
        <input
          value={a.input ?? ""}
          maxLength={HOME_LIMITS.input}
          onChange={(e) => onChange({ ...a, input: e.target.value || undefined })}
        />
      </label>
      <label className="ll-inline">
        <input
          type="checkbox"
          checked={!!a.confirm}
          onChange={(e) => onChange({ ...a, confirm: e.target.checked || undefined })}
        />{" "}
        Ask to confirm
      </label>
      <button className="btn" onClick={onRemove} aria-label={`Remove ${a.label}`}>
        <Icon name="x" />
      </button>
    </li>
  );
}

function HomeSection() {
  const announce = useAnnounce();
  const source = useMemo(homeSource, []);
  const [status, setStatus] = useState<HomeStatus | null>(null);
  const [draft, setDraft] = useState<HomeSetup | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<HomeDeviceKind>("light");

  useEffect(() => {
    source.status().then(
      (s) => {
        setStatus(s);
        setDraft(structuredClone(s.setup));
      },
      (err: unknown) => setNote(err instanceof Error ? err.message : "Couldn't reach the home."),
    );
  }, [source]);

  if (!status || !draft)
    return (
      <section className="panel stack" aria-labelledby="h-home">
        <h2 id="h-home">
          <Icon name="home" /> The home
        </h2>
        <p className="muted">{note ?? "Checking…"}</p>
      </section>
    );

  const setDevice = (id: string, change: (d: HomeDevice) => HomeDevice) =>
    setDraft({ ...draft, devices: draft.devices.map((d) => (d.id === id ? change(d) : d)) });
  const refused = refusedHomeReason(newName);

  const addDevice = () => {
    const name = newName.replace(/\s+/g, " ").trim();
    if (!name || refused || draft.devices.length >= HOME_LIMITS.devices) return;
    const id = `${
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 30) || "device"
    }-${draft.devices.length + 1}`;
    setDraft({
      ...draft,
      devices: [...draft.devices, { id, name, kind: newKind, actions: defaultActions(name, newKind) }],
    });
    setNewName("");
  };

  const save = async () => {
    const r = await source.save(draft);
    const text = r.ok ? "Home setup saved." : r.error;
    if (r.ok) {
      setStatus(r.status);
      setDraft(structuredClone(r.status.setup));
    }
    setNote(text);
    announce(text);
  };

  const list = async () => {
    const r = await source.shortcuts();
    if (r.ok) setNames(r.names);
    setNote(r.ok ? `${r.names.length} shortcuts on this Mac.` : r.error);
  };

  return (
    <section className="panel stack" aria-labelledby="h-home">
      <h2 id="h-home">
        <Icon name="home" /> The home
      </h2>
      {source.kind === "practice" ? (
        <p>
          Practice home: these devices are pretend and nothing real changes. In the AGENCY Mac app, the home
          runs shortcuts you make in Apple&rsquo;s Shortcuts app (for example one called &ldquo;Bedroom light
          on&rdquo; that turns on a HomeKit light).
        </p>
      ) : (
        <p>
          Make one shortcut in the Shortcuts app for each button (for example &ldquo;Bedroom light on&rdquo;),
          run it once there so macOS can ask its questions, then add it here with its exact name. AGENCY only
          ever runs the shortcuts listed here.
          {!status.available && ` ${status.reason ?? ""}`}
        </p>
      )}
      <p className="day-warning" role="note">
        <Icon name="shield" /> Never add a shortcut that unlocks, opens or controls a lock, door, garage door
        or gate. AGENCY refuses those names, but it can&rsquo;t see inside a shortcut. Heating, ovens and
        anything you tick always ask the person to confirm.
      </p>
      <Toggle
        label="Home control"
        value={draft.enabled}
        onChange={(v) => setDraft({ ...draft, enabled: v })}
        help="Saved with the button below"
      />
      <datalist id="day-shortcut-names">
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {draft.devices.map((d) => (
        <fieldset key={d.id} className="day-setup-device">
          <legend>
            {d.name} · {HOME_KIND_WORDS[d.kind]}
          </legend>
          <ul className="day-setup-list">
            {d.actions.map((a, i) => (
              <ActionRow
                key={a.id}
                a={a}
                names="day-shortcut-names"
                onChange={(next) =>
                  setDevice(d.id, (x) => ({ ...x, actions: x.actions.map((y, j) => (j === i ? next : y)) }))
                }
                onRemove={() =>
                  setDevice(d.id, (x) => ({ ...x, actions: x.actions.filter((_, j) => j !== i) }))
                }
              />
            ))}
          </ul>
          <div className="day-setup-buttons">
            <button
              className="btn"
              disabled={d.actions.length >= HOME_LIMITS.actions}
              onClick={() =>
                setDevice(d.id, (x) => ({
                  ...x,
                  actions: [...x.actions, { id: `a${Date.now().toString(36)}`, label: "New", shortcut: "" }],
                }))
              }
            >
              <Icon name="plus" /> Add a button
            </button>
            <button
              className="btn"
              onClick={() => setDraft({ ...draft, devices: draft.devices.filter((x) => x.id !== d.id) })}
            >
              <Icon name="x" /> Remove {d.name}
            </button>
          </div>
        </fieldset>
      ))}
      <form
        className="day-setup-form"
        onSubmit={(e) => {
          e.preventDefault();
          addDevice();
        }}
      >
        <label className="field">
          <span>New device</span>
          <input value={newName} maxLength={HOME_LIMITS.name} onChange={(e) => setNewName(e.target.value)} />
        </label>
        <label className="field">
          <span>What it is</span>
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as HomeDeviceKind)}>
            {HOME_KINDS.map((k) => (
              <option key={k} value={k}>
                {HOME_KIND_WORDS[k]}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="submit" disabled={!newName.trim() || !!refused}>
          <Icon name="plus" /> Add device
        </button>
      </form>
      {refused && (
        <p className="ll-field-error" role="alert">
          {refused}
        </p>
      )}
      <div className="day-setup-buttons">
        <button className="btn btn-primary" onClick={() => void save()}>
          <Icon name="check" /> Save the home setup
        </button>
        <button className="btn" onClick={() => void list()}>
          <Icon name="list" /> List this Mac&rsquo;s shortcuts
        </button>
      </div>
      {note && <p role="status">{note}</p>}
    </section>
  );
}

// ---- Page -----------------------------------------------------------------------------------------------------

export function DaySettings() {
  const announce = useAnnounce();
  return (
    <Page label="My day and home">
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings, for a helper</div>
          <h1>My day and home</h1>
          <p>
            Set this up with the person. They choose what&rsquo;s on their day, when reminders ask, and
            whether a request may go to a carer.
          </p>
        </div>
        <button className="btn" onClick={() => navigate("/settings/helper")} data-dwell>
          <Icon name="gear" /> Helper settings
        </button>
      </div>
      <CarerSection />
      <DaySection />
      <RoutineSection />
      <HomeSection />
      <section className="panel stack" aria-labelledby="h-practice">
        <h2 id="h-practice">
          <Icon name="sparkle" /> Practice
        </h2>
        <p className="muted">
          A made-up sample day shows how My day works
          {practiceMode() ? " (it was added when practice started)" : ""}. Clearing removes everything on the
          day and every care reminder.
        </p>
        <div className="day-setup-buttons">
          <button
            className="btn"
            onClick={() => {
              saveDaily(sampleDay(Date.now()));
              announce("Sample day added.");
            }}
          >
            <Icon name="calendar" /> Use a sample day
          </button>
          <button
            className="btn"
            onClick={() => {
              clearDaily();
              announce("My day cleared.");
            }}
          >
            <Icon name="x" /> Clear my day
          </button>
        </div>
      </section>
    </Page>
  );
}
