/**
 * The home, by eye: a big tile per device with what AGENCY last set it to, then the device's actions as big
 * choices. Heating, ovens and anything a helper marked need a confirmation look. Never locks or doors.
 * In the browser and the web demo this is a practice home and says so.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import {
  homeSource,
  KIND_ICON,
  needsConfirmation,
  stateLine,
  type HomeAction,
  type HomeDevice,
  type HomeStatus,
} from "./homeControl";
import { BackButton, DayPage, HomeButton, LookToConfirm, pageOf, Paging, PracticeNote } from "./parts";

const TILES_PER_PAGE = 6;

type View =
  | { view: "devices" }
  | { view: "device"; device: HomeDevice }
  | { view: "confirm"; device: HomeDevice; action: HomeAction }
  | { view: "running"; device: HomeDevice; action: HomeAction }
  | { view: "result"; device: HomeDevice; text: string; ok: boolean };

export function HomeTiles() {
  const announce = useAnnounce();
  const source = useMemo(homeSource, []);
  const [status, setStatus] = useState<HomeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState<View>({ view: "devices" });
  const [page, setPage] = useState(0);

  const refresh = useCallback(() => {
    source.status().then(
      (s) => {
        setStatus(s);
        setError(null);
      },
      (err: unknown) => setError(err instanceof Error ? err.message : "Couldn't reach the home."),
    );
  }, [source]);
  useEffect(refresh, [refresh]);

  const practice = source.kind === "practice";
  const note = practice ? (
    <PracticeNote>
      Practice home: nothing real changes. In the Mac app, a helper can connect Apple Shortcuts.
    </PracticeNote>
  ) : null;

  const run = async (device: HomeDevice, action: HomeAction, confirmed: boolean) => {
    setV({ view: "running", device, action });
    const r = await source.run(device.id, action.id, confirmed).catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : "It didn't work.",
    }));
    const text = r.ok
      ? `${device.name}: ${r.state}.${practice ? " (Practice: nothing real changed.)" : ""}`
      : `${device.name}: ${r.error}`;
    announce(text);
    setV({ view: "result", device, text, ok: r.ok });
    refresh();
  };

  const choose = (device: HomeDevice, action: HomeAction) =>
    needsConfirmation(device, action)
      ? setV({ view: "confirm", device, action })
      : void run(device, action, false);

  if (v.view === "confirm" || v.view === "running") {
    if (v.view === "running" && !needsConfirmation(v.device, v.action))
      return (
        <DayPage tab="home" title={`${v.device.name}: ${v.action.label}…`} bar={null}>
          {note}
        </DayPage>
      );
    return (
      <DayPage tab="home" title={`${v.device.name}: ${v.action.label}?`} bar={null}>
        <LookToConfirm
          question={`This changes ${v.device.name}: ${v.action.label}. It could matter for your comfort or safety.`}
          yes={`Yes, ${v.action.label.toLowerCase()}`}
          busy={v.view === "running"}
          onYes={() => void run(v.device, v.action, true)}
          onNo={() => setV({ view: "device", device: v.device })}
        />
        {note}
      </DayPage>
    );
  }

  if (v.view === "result") {
    return (
      <DayPage
        tab="home"
        title={v.text}
        bar={
          <>
            <BackButton
              label={`Back to ${v.device.name}`}
              onBack={() => setV({ view: "device", device: v.device })}
            />
            <button className="btn btn-xl btn-primary" onClick={() => setV({ view: "devices" })} data-dwell>
              <Icon name="home" flat /> All devices
            </button>
          </>
        }
      >
        {note}
      </DayPage>
    );
  }

  if (v.view === "device") {
    const d = v.device;
    return (
      <DayPage
        tab="home"
        title={d.name}
        sub={status ? stateLine(d, status.states) : undefined}
        bar={<BackButton label="All devices" onBack={() => setV({ view: "devices" })} />}
      >
        <div className="flow-options" data-count={d.actions.length} role="group" aria-labelledby="day-title">
          {d.actions.map((a) => (
            <button key={a.id} className="choice" onClick={() => choose(d, a)} data-dwell>
              <span className="choice-label">{a.label}</span>
              {needsConfirmation(d, a) && <span className="choice-sub">Asks you to confirm</span>}
            </button>
          ))}
        </div>
        {note}
      </DayPage>
    );
  }

  const devices = status?.setup.enabled ? status.setup.devices : [];
  const p = pageOf(devices, page, TILES_PER_PAGE);
  const title = error
    ? error
    : !status
      ? "Checking your home…"
      : !status.available
        ? (status.reason ?? "Home control isn't available here.")
        : devices.length === 0
          ? "No devices yet"
          : "Your home";
  return (
    <DayPage
      tab="home"
      title={title}
      sub={
        status && devices.length === 0 && status.available
          ? "A helper can set up lights, the TV, a fan, heating and blinds in Settings, For a helper, My day and home. Never locks or doors."
          : undefined
      }
      bar={
        <>
          <HomeButton />
          <span className="spacer" />
          <Paging page={p.page} pages={p.pages} onPage={setPage} />
        </>
      }
    >
      {devices.length > 0 && (
        <div className="flow-options" data-count={p.items.length} role="group" aria-label="Your devices">
          {p.items.map((d) => (
            <button
              key={d.id}
              className="choice day-device"
              onClick={() => setV({ view: "device", device: d })}
              data-dwell
              data-testid="day-device"
            >
              <span className="choice-pic" aria-hidden>
                <Icon name={KIND_ICON[d.kind]} size={44} />
              </span>
              <span className="choice-label">{d.name}</span>
              <span className="choice-sub">{stateLine(d, status!.states)}</span>
            </button>
          ))}
        </div>
      )}
      {note}
    </DayPage>
  );
}
