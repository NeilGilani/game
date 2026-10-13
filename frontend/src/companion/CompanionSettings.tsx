/**
 * Settings, For a helper, Caregiver phones: turn the companion on, pair a phone with one look at a QR code, see
 * and remove paired phones, see every change carers made, and read or leave hand-over notes.
 */
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { QrCode } from "../components/QrCode";
import { Page } from "../components/Shell";
import { Toggle } from "../screens/SettingsViews";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import {
  companionApi,
  when,
  type CompanionChange,
  type CompanionStatus,
  type HandoverNote,
  type PairingCode,
} from "./macApi";
import "./companion.css";

const STATUS_WORDS: Record<CompanionChange["status"], string> = {
  applied: "Done",
  waiting_person: "Waiting for the person",
  waiting_mac: "Being applied",
  declined: "Not allowed",
  failed: "Didn't work",
  replaced: "Replaced by a newer change",
};

function useSecondsLeft(until: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.round((Date.parse(until) - now) / 1000)) : 0;
}

export function CompanionSettings() {
  const announce = useAnnounce();
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [log, setLog] = useState<CompanionChange[]>([]);
  const [notes, setNotes] = useState<HandoverNote[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const left = useSecondsLeft(code?.expires_at ?? null);

  const load = useCallback(async () => {
    try {
      const s = await companionApi.status();
      setStatus(s);
      if (!s.pairing) setCode(null);
      if (s.enabled) {
        const [l, n] = await Promise.all([companionApi.changes(), companionApi.notes()]);
        setLog(l);
        setNotes(n);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Can't reach the coordinator.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (code && left === 0) setCode(null);
  }, [code, left]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const enabled = !!status?.enabled;

  return (
    <Page label="Caregiver phones">
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings · For a helper</div>
          <h1>Caregiver phones</h1>
          <p>
            Carers can set AGENCY up from their own phone, see that it&apos;s running, get Lifeline alerts
            while the page is open, send a message or photo to this screen, and leave notes for the next
            shift.
          </p>
        </div>
        <button className="btn" onClick={() => navigate("/settings/helper")} data-dwell>
          <Icon name="back" /> Back
        </button>
      </div>

      <div className="cmp-settings">
        {status && !status.available && (
          <p className="panel">Caregiver phones are turned off on this coordinator (AGENCY_COMPANION=off).</p>
        )}
        {status?.available && (
          <Toggle
            label="Let carers' phones connect"
            value={enabled}
            onChange={(v) =>
              void act(async () => {
                await companionApi.setEnabled(v);
                setCode(null);
                announce(v ? "Caregiver phones are on." : "Caregiver phones are off.");
              })
            }
            help={
              enabled
                ? "Only phones on this home network, and only after pairing"
                : "Nothing on the network can reach AGENCY's phone page"
            }
          />
        )}
        {error && (
          <p className="panel panel-danger" role="alert">
            {error}
          </p>
        )}

        {enabled && (
          <section className="panel stack" aria-label="Pair a phone">
            <h2>
              <Icon name="phone" /> Pair a phone
            </h2>
            {code ? (
              <div className="cmp-pair">
                <QrCode value={code.link} size={220} label="QR code to pair a phone with AGENCY" />
                <div className="stack">
                  <p>Scan this with the carer&apos;s phone camera, or open this address and type the code:</p>
                  <p className="cmp-url">{code.url}</p>
                  <p className="cmp-code" aria-label={`Pairing code ${code.code.split("").join(" ")}`}>
                    {code.code}
                  </p>
                  <p className="muted">
                    Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} more. The
                    phone must be on the same Wi-Fi as this computer.
                  </p>
                  <div className="row">
                    <button
                      className="btn"
                      onClick={() => void act(async () => setCode(await companionApi.pair()))}
                      disabled={busy}
                      data-dwell
                    >
                      <Icon name="refresh" /> New code
                    </button>
                    <button
                      className="btn"
                      onClick={() =>
                        void act(async () => {
                          await companionApi.cancelPair();
                          setCode(null);
                        })
                      }
                      disabled={busy}
                      data-dwell
                    >
                      <Icon name="x" /> Stop pairing
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <p>Shows a QR code and a six-digit code for a few minutes. Each phone gets its own key.</p>
                <button
                  className="btn btn-primary"
                  onClick={() => void act(async () => setCode(await companionApi.pair()))}
                  disabled={busy}
                  data-dwell
                >
                  <Icon name="plus" /> Show a pairing code
                </button>
              </>
            )}
            {!status?.secure && (
              <p className="muted">
                Phones connect over plain HTTP on this home network. Use it only on Wi-Fi you trust; the setup
                guide shows how to turn on HTTPS.
              </p>
            )}
          </section>
        )}

        {enabled && (
          <section className="panel stack" aria-label="Paired phones">
            <h2>
              <Icon name="shield" /> Paired phones
            </h2>
            {status && status.devices.length === 0 && <p className="muted">No phones are paired yet.</p>}
            <ul className="cmp-list">
              {status?.devices.map((d) => (
                <li key={d.id}>
                  <Icon name="phone" />
                  <span className="grow">
                    <strong>{d.name}</strong>
                    {d.contact_name ? ` · gets Lifeline alerts as ${d.contact_name}` : ""}
                    <br />
                    <span className="muted">
                      Paired {when(d.created_at)} · last seen {when(d.last_seen_at) || "never"}
                    </span>
                  </span>
                  <button
                    className="btn"
                    onClick={() =>
                      void act(async () => {
                        await companionApi.revoke(d.id);
                        announce(`${d.name}'s phone was removed.`);
                      })
                    }
                    disabled={busy}
                    data-dwell
                  >
                    <Icon name="x" /> Remove {d.name}&apos;s phone
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {enabled && (
          <section className="panel stack" aria-label="Changes from phones">
            <h2>
              <Icon name="list" /> Who changed what
            </h2>
            {log.length === 0 && <p className="muted">Nothing yet.</p>}
            <ul className="cmp-list">
              {log.slice(0, 20).map((c) => (
                <li key={c.id}>
                  <span className="grow">
                    <strong>{c.author}</strong> · {when(c.created_at)}
                    <br />
                    {c.summary}
                    {c.reason && c.status !== "applied" ? <span className="muted"> ({c.reason})</span> : null}
                  </span>
                  {c.kind !== "device" && (
                    <span className="cmp-status" data-status={c.status}>
                      {STATUS_WORDS[c.status]}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {enabled && (
          <section className="panel stack" aria-label="Hand-over notes">
            <h2>
              <Icon name="edit" /> Hand-over notes
            </h2>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                const text = note.trim();
                if (!text) return;
                void act(async () => {
                  await companionApi.addNote(text, "");
                  setNote("");
                });
              }}
            >
              <label className="field">
                <strong>Leave a note for the next carer</strong>
                <textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button className="btn btn-primary" type="submit" disabled={busy || !note.trim()} data-dwell>
                <Icon name="check" /> Save note
              </button>
            </form>
            <ul className="cmp-list">
              {notes.map((n) => (
                <li key={n.id}>
                  <span className="grow">
                    <strong>{n.author}</strong> · {when(n.created_at)}
                    <br />
                    <span className="cmp-note-text">{n.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Page>
  );
}
