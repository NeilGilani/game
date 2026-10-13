/**
 * Settings for the home (Mac app): turn it on, and name the devices and the Shortcuts that control them. The Mac
 * app's main process checks everything again when it is saved and before anything runs (os/desktop/src/main/home).
 */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Toggle } from "../screens/SettingsViews";
import type {
  HomeActionDef,
  HomeDeviceDef,
  HomeDeviceKind,
  HomeSettings,
} from "../../../os/contracts/src/home";
import { homeApi } from "./home";

const KINDS: { kind: HomeDeviceKind; label: string; actions: Omit<HomeActionDef, "shortcut">[] }[] = [
  {
    kind: "light",
    label: "Light",
    actions: [
      { id: "on", label: "Turn on", confirm: false },
      { id: "off", label: "Turn off", confirm: false },
    ],
  },
  {
    kind: "tv",
    label: "TV",
    actions: [
      { id: "on", label: "Turn on", confirm: false },
      { id: "off", label: "Turn off", confirm: false },
    ],
  },
  {
    kind: "fan",
    label: "Fan",
    actions: [
      { id: "on", label: "Turn on", confirm: false },
      { id: "off", label: "Turn off", confirm: false },
    ],
  },
  {
    kind: "thermostat",
    label: "Thermostat (always asks to confirm)",
    actions: [
      { id: "warmer", label: "Warmer", confirm: true },
      { id: "cooler", label: "Cooler", confirm: true },
    ],
  },
  {
    kind: "blinds",
    label: "Blinds",
    actions: [
      { id: "open", label: "Open", confirm: false },
      { id: "close", label: "Close", confirm: false },
    ],
  },
  {
    kind: "heater",
    label: "Heater (always asks to confirm)",
    actions: [
      { id: "on", label: "Turn on", confirm: true },
      { id: "off", label: "Turn off", confirm: true },
    ],
  },
  { kind: "plug", label: "Smart plug", actions: [{ id: "on", label: "Turn on", confirm: false }] },
  { kind: "other", label: "Something else", actions: [{ id: "go", label: "Run", confirm: false }] },
];

function slug(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || "device";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

export function HomeSettingsSection() {
  const api = homeApi();
  const [settings, setSettings] = useState<HomeSettings | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<HomeDeviceKind>("light");

  useEffect(() => {
    if (!api) return;
    void api
      .settings()
      .then(setSettings)
      .catch(() => setError("AGENCY couldn't read the home setup."));
    void api.shortcuts().then((r) => (r.ok ? setNames(r.names) : setError(r.error)));
  }, [api]);

  if (!api)
    return (
      <section className="stack" aria-label="The home">
        <h2>
          <Icon name="home" /> The home
        </h2>
        <p>
          Lights, TV, fan, heating and blinds through Apple Shortcuts need the AGENCY Mac app. Here, My day
          shows a practice home that changes only on screen.
        </p>
      </section>
    );

  const save = async (next: HomeSettings, done: string) => {
    const r = await api.setSettings(next);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setSettings(r.settings);
    setError(null);
    setNote(done);
  };

  const setAction = (d: HomeDeviceDef, a: HomeActionDef, change: Partial<HomeActionDef>) => {
    if (!settings) return;
    setSettings({
      ...settings,
      devices: settings.devices.map((x) =>
        x.id === d.id
          ? { ...x, actions: x.actions.map((y) => (y.id === a.id ? { ...y, ...change } : y)) }
          : x,
      ),
    });
  };

  return (
    <section className="stack" aria-label="The home">
      <h2>
        <Icon name="home" /> The home
      </h2>
      <p>
        AGENCY runs Apple Shortcuts that you set up in the Shortcuts app (for example "Bedroom lamp on", using
        HomeKit). Name each device, then pick the shortcut for each action. Heating and heaters always ask the
        person to confirm. <strong>Never add doors, locks, garage doors or gates</strong>, and never pick a
        shortcut that opens the home: AGENCY refuses those names, but it can't see inside a shortcut.
      </p>
      <datalist id="day-shortcuts">
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {error && (
        <p className="papers-error" role="alert">
          {error}
        </p>
      )}
      {note && !error && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
      {settings && (
        <>
          <Toggle
            label="Control the home"
            value={settings.enabled}
            onChange={(v) =>
              void save({ ...settings, enabled: v }, v ? "Home control is on." : "Home control is off.")
            }
            help={settings.enabled ? `${settings.devices.length} devices` : "My day shows a practice home"}
          />
          {settings.devices.map((d) => (
            <fieldset key={d.id} className="day-device-edit">
              <legend>
                <strong>{d.name}</strong>
              </legend>
              {d.actions.map((a) => (
                <div key={a.id} className="row">
                  <label className="field">
                    <strong>{a.label}: shortcut</strong>
                    <input
                      list="day-shortcuts"
                      value={a.shortcut}
                      maxLength={100}
                      onChange={(e) => setAction(d, a, { shortcut: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <strong>Input (optional)</strong>
                    <input
                      value={a.input ?? ""}
                      maxLength={60}
                      onChange={(e) => setAction(d, a, { input: e.target.value })}
                    />
                  </label>
                  <label className="day-check">
                    <input
                      type="checkbox"
                      checked={a.confirm}
                      disabled={d.kind === "thermostat" || d.kind === "heater"}
                      onChange={(e) => setAction(d, a, { confirm: e.target.checked })}
                    />{" "}
                    Ask to confirm
                  </label>
                </div>
              ))}
              <label className="field">
                <strong>Status shortcut (optional, its text shows as the state)</strong>
                <input
                  list="day-shortcuts"
                  value={d.statusShortcut ?? ""}
                  maxLength={100}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      devices: settings.devices.map((x) =>
                        x.id === d.id ? { ...x, statusShortcut: e.target.value || undefined } : x,
                      ),
                    })
                  }
                />
              </label>
              <div className="row">
                <button
                  className="btn btn-primary"
                  onClick={() => void save(settings, `Saved ${d.name}.`)}
                  data-dwell
                >
                  <Icon name="check" /> Save
                </button>
                <button
                  className="btn"
                  onClick={() =>
                    void save(
                      { ...settings, devices: settings.devices.filter((x) => x.id !== d.id) },
                      `Removed ${d.name}.`,
                    )
                  }
                  data-dwell
                >
                  Remove
                </button>
              </div>
            </fieldset>
          ))}
          <form
            className="row"
            aria-label="Add a device"
            onSubmit={(e) => {
              e.preventDefault();
              const n = name.trim();
              if (!n) return setError('Name the device first, like "Bedroom lamp".');
              const template = KINDS.find((k) => k.kind === kind)!;
              const device: HomeDeviceDef = {
                id: slug(
                  n,
                  settings.devices.map((d) => d.id),
                ),
                name: n.slice(0, 40),
                kind,
                actions: template.actions.map((a) => ({ ...a, shortcut: `${n} ${a.label.toLowerCase()}` })),
              };
              setName("");
              void save(
                { ...settings, devices: [...settings.devices, device] },
                `Added ${device.name}. Check its shortcuts.`,
              );
            }}
          >
            <label className="field">
              <strong>Device name</strong>
              <input
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                placeholder="Bedroom lamp"
              />
            </label>
            <label className="field">
              <strong>Kind</strong>
              <select value={kind} onChange={(e) => setKind(e.target.value as HomeDeviceKind)}>
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" type="submit" data-dwell>
              <Icon name="plus" /> Add device
            </button>
          </form>
        </>
      )}
    </section>
  );
}
