/**
 * The home, by eye: each device is a big tile with what AGENCY knows about its state. Choosing one shows its
 * actions; anything that could matter for safety (heating) asks for a confirmation look, placed on the other side
 * of the screen after a pause. No doors or locks, ever.
 */
import { useCallback, useEffect, useState } from "react";
import { ErrorNote, STOP_ALL_EVENT } from "../components/common";
import { SecondConfirm } from "../papers/parts";
import { formatClock } from "./day";
import { homeSource, stopPracticeHome, type HomeDeviceView, type HomeSource } from "./home";
import { Bar, Choice, Choices, Head, PageButtons, PracticeBadge } from "./parts";

const PER_PAGE = 6;

const KIND_ICON: Record<HomeDeviceView["kind"], string> = {
  light: "sparkle",
  tv: "tv",
  fan: "refresh",
  thermostat: "target",
  blinds: "list",
  heater: "target",
  plug: "chip",
  other: "grid",
};

function stateText(d: HomeDeviceView): string {
  if (!d.state) return "State not known";
  if (d.stateFromDevice) return d.state;
  return `Last: ${d.state}${d.stateAt ? ` at ${formatClock(new Date(d.stateAt))}` : ""}`;
}

type Pending = { ticket: string; fingerprint: string; summary: string };

export function HomeScreen() {
  const [source, setSource] = useState<HomeSource | null>(null);
  const [devices, setDevices] = useState<HomeDeviceView[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    const h = await homeSource();
    setSource(h.source);
    setDevices(h.status.devices);
    setNote(h.note);
    if (!h.source.practice)
      void h.source
        .refresh()
        .then((s) => setDevices(s.devices))
        .catch(() => undefined);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Stop forgets anything waiting for a confirmation.
  useEffect(() => {
    const stop = () => {
      stopPracticeHome();
      setPending(null);
      setBusy(false);
    };
    window.addEventListener(STOP_ALL_EVENT, stop);
    return () => window.removeEventListener(STOP_ALL_EVENT, stop);
  }, []);

  const device = devices.find((d) => d.id === chosen) ?? null;

  const run = async (src: HomeSource, p: Pending) => {
    setBusy(true);
    const r = await src.run(p.ticket, p.fingerprint).catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : "That didn't work.",
    }));
    setBusy(false);
    setPending(null);
    if (r.ok) {
      setError(null);
      setMessage(`Done: ${r.summary}.`);
      const s = await src.status().catch(() => null);
      if (s) setDevices(s.devices);
    } else {
      setMessage(null);
      setError(r.error);
    }
  };

  const choose = async (actionId: string) => {
    if (!source || !device || busy) return;
    setMessage(null);
    const p = await source.prepare(device.id, actionId).catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : "That didn't work.",
    }));
    if (!p.ok) {
      setError(p.error);
      return;
    }
    setError(null);
    const next = { ticket: p.ticket, fingerprint: p.fingerprint, summary: p.summary };
    // The tile names exactly what happens; safety actions get a second, separate look.
    if (p.confirm) setPending(next);
    else await run(source, next);
  };

  const pages = Math.max(1, Math.ceil(devices.length / PER_PAGE));
  const current = Math.min(page, pages - 1);
  const shown = devices.slice(current * PER_PAGE, current * PER_PAGE + PER_PAGE);
  const badge = source?.practice ? <PracticeBadge label="Practice home" /> : null;

  if (device && source) {
    return (
      <div className="flow day" aria-label={device.name} data-testid="day-device">
        <Head
          icon={KIND_ICON[device.kind]}
          eyebrow={`The home · ${stateText(device)}`}
          badge={badge}
          title={pending ? "Are you sure?" : device.name}
          help={
            device.actions.some((a) => a.confirm) && !pending
              ? "Heating asks you to confirm first."
              : undefined
          }
        />
        <div className="day-body stack">
          {error && <ErrorNote message={error} />}
          {message && (
            <p className="day-done" role="status">
              {message}
            </p>
          )}
          {pending ? (
            <SecondConfirm
              question={`${pending.summary}?`}
              yes={busy ? "Working…" : `Yes: ${pending.summary}`}
              onYes={() => void run(source, pending)}
              onNo={() => {
                void source.cancel(pending.ticket);
                setPending(null);
              }}
              side="right"
            />
          ) : (
            <Choices count={device.actions.length} label={device.name}>
              {device.actions.map((a) => (
                <Choice
                  key={a.id}
                  icon={a.confirm ? "shield" : KIND_ICON[device.kind]}
                  label={a.label}
                  sub={a.confirm ? "Asks you to confirm" : device.name}
                  onPick={() => void choose(a.id)}
                />
              ))}
            </Choices>
          )}
        </div>
        <Bar
          back={() => {
            if (pending) void source.cancel(pending.ticket);
            setPending(null);
            setChosen(null);
            setMessage(null);
            setError(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flow day" aria-label="The home" data-testid="day-home">
      <Head
        icon="home"
        eyebrow="The home"
        badge={badge}
        title="What would you like to change?"
        help={note ?? "Doors and locks are never controlled by AGENCY."}
      />
      <div className="day-body">
        {error && <ErrorNote message={error} />}
        <Choices count={shown.length} label="Devices">
          {shown.map((d) => (
            <Choice
              key={d.id}
              icon={KIND_ICON[d.kind]}
              label={d.name}
              sub={stateText(d)}
              testId={`day-device-${d.id}`}
              onPick={() => {
                setChosen(d.id);
                setMessage(null);
                setError(null);
              }}
            />
          ))}
        </Choices>
      </div>
      <Bar>
        <PageButtons page={current} pages={pages} onPage={setPage} />
      </Bar>
    </div>
  );
}
