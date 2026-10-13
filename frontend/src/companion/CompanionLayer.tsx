/**
 * Caregiver phones, on the person's screen. Mounted once in the shell; does nothing until a helper turns
 * caregiver phones on in Settings.
 *
 * - A carer's message or photo appears big, with one look to put it away ("Got it").
 * - A change that waits for the person (a real phone number, turning a protection off) asks them: Allow or Don't.
 * - Changes kept on this Mac (phrases, details, favourite sites, the Papers folder) are applied here and reported
 *   back, and every applied change is shown and read aloud, so the person always knows who changed what.
 * - It tells the coordinator the battery level, and what the Mac keeps, so a phone can show and edit it.
 *
 * A Lifeline alert or check-in always comes first: while one is open, nothing here is shown.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { SELECTION_RESET_EVENT } from "../components/common";
import { useLifeline } from "../lifeline/LifelineProvider";
import { useAnnounce } from "../state/announcer";
import { browserApi } from "../browser/store";
import { currentFolder, papersApi } from "../papers/source";
import { applyChange, noticeFor, readSnapshot, type MacParts } from "./apply";
import { companionApi, when, type CompanionChange, type CompanionStatus, type InboxMessage } from "./macApi";
import "./companion.css";

const POLL_MS = 3000;
const IDLE_POLL_MS = 10_000;
const SNAPSHOT_MS = 15_000;
const PRESENCE_MS = 60_000;

function macParts(): MacParts {
  const storage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  return {
    storage: storage ?? { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    browser: browserApi(),
    papers: papersApi(),
    folder: currentFolder,
  };
}

interface Battery {
  level: number;
  charging: boolean;
}

async function battery(): Promise<Battery | null> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<Battery> };
  if (typeof nav.getBattery !== "function") return null;
  try {
    const b = await nav.getBattery();
    return { level: b.level, charging: b.charging };
  } catch {
    return null;
  }
}

/** The web demo has no coordinator of its own to pair phones with. */
export function CompanionLayer() {
  if (import.meta.env.VITE_WEB_DEMO === "1") return null;
  return <CompanionOnMac />;
}

function CompanionOnMac() {
  const ll = useLifeline();
  const announce = useAnnounce();
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [inbox, setInbox] = useState<InboxMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [later, setLater] = useState<Set<number>>(new Set());
  const applying = useRef(new Set<number>());
  const since = useRef<number | null>(null);
  const announced = useRef(new Set<number>());
  const lastSnapshot = useRef("");
  const enabled = !!status?.enabled;

  const refresh = useCallback(async () => {
    try {
      const s = await companionApi.status();
      setStatus(s);
      if (!s.enabled) {
        setInbox([]);
        return;
      }
      const [open, messages, firstLog] = await Promise.all([
        companionApi.open(),
        companionApi.inbox(),
        companionApi.changes(),
      ]);
      setInbox(messages);
      let applied = false;
      for (const change of open) {
        if (change.status !== "waiting_mac" || applying.current.has(change.id)) continue;
        applied = true;
        applying.current.add(change.id);
        const result = await applyChange(change, macParts());
        await companionApi.applied(change.id, result.ok, result.reason).catch(() => undefined);
        lastSnapshot.current = ""; // send the new state to phones at once
      }
      // Show each change from a phone once, when it has really happened (not the history from before this screen
      // started). A change applied here only counts after the Mac has applied it, so read the log afterwards.
      if (since.current === null)
        since.current = Math.max(
          0,
          ...firstLog.filter((c) => !c.status.startsWith("waiting")).map((c) => c.id),
        );
      const log = applied ? await companionApi.changes() : firstLog;
      const fresh = log.filter(
        (c) =>
          c.id > (since.current ?? 0) &&
          c.device_id &&
          c.status === "applied" &&
          !announced.current.has(c.id),
      );
      for (const c of fresh) announced.current.add(c.id);
      const latest = fresh[0];
      if (latest) {
        const text = noticeFor(latest);
        setNotice(text);
        announce(text);
      }
    } catch {
      /* the coordinator is away: Lifeline's own banner says so; try again next time */
    }
  }, [announce]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), enabled ? POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh, enabled]);

  // What the Mac keeps, for the phones (only while caregiver phones are on).
  useEffect(() => {
    if (!enabled) {
      lastSnapshot.current = "";
      return;
    }
    const send = async () => {
      const snap = await readSnapshot(macParts());
      const key = JSON.stringify(snap);
      if (key === lastSnapshot.current) return;
      await companionApi.snapshot(snap).then(
        () => (lastSnapshot.current = key),
        () => undefined,
      );
    };
    void send();
    const t = window.setInterval(() => void send(), SNAPSHOT_MS);
    return () => window.clearInterval(t);
  }, [enabled]);

  // "Battery OK" on the phones.
  useEffect(() => {
    if (!enabled) return;
    const send = async () => {
      const b = await battery();
      await companionApi.presence(b?.level ?? null, b?.charging ?? null).catch(() => undefined);
    };
    void send();
    const t = window.setInterval(() => void send(), PRESENCE_MS);
    return () => window.clearInterval(t);
  }, [enabled]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 9000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const message = inbox[0] ?? null;
  const ask = (status?.waiting_for_person ?? []).find((c) => !later.has(c.id)) ?? null;
  const lifelineFirst = !!(ll.open || ll.queued || ll.status?.monitor.checkin_pending_since);
  const showing = lifelineFirst ? null : message ? `m${message.id}` : ask ? `c${ask.id}` : null;

  useEffect(() => {
    if (showing) window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
  }, [showing]);

  useEffect(() => {
    if (!showing || lifelineFirst) return;
    if (message) announce(`Message from ${message.author}. ${message.text}`);
    else if (ask) announce(`${ask.author} asks to change something. ${ask.summary}`);
    // Announce once per item shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing]);

  const gotIt = async (m: InboxMessage) => {
    setBusy(true);
    try {
      await companionApi.seen(m.id);
      setInbox((list) => list.filter((x) => x.id !== m.id));
    } catch {
      /* keep it showing; the next poll tries again */
    } finally {
      setBusy(false);
    }
  };

  const decide = async (c: CompanionChange, allow: boolean) => {
    setBusy(true);
    try {
      await companionApi.decide(c.id, allow);
      announce(allow ? "Allowed." : "Not allowed.");
      await refresh();
    } catch {
      /* already decided elsewhere: the next poll clears it */
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {notice && !showing && (
        <div className="cmp-notice" role="status">
          <Icon name="phone" size={22} /> <span>{notice}</span>
        </div>
      )}
      {!lifelineFirst && message && (
        <div
          className="cmp-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cmp-message-title"
          data-dwell-scope="modal"
        >
          <div className="cmp-card">
            <p className="cmp-from" id="cmp-message-title">
              <Icon name="message" size={28} /> From {message.author} · {when(message.created_at)}
            </p>
            {message.photo && (
              <img className="cmp-photo" src={message.photo} alt={`Photo from ${message.author}`} />
            )}
            {message.text && <p className="cmp-text">{message.text}</p>}
            <button
              className="btn btn-xl btn-primary cmp-wide"
              onClick={() => void gotIt(message)}
              disabled={busy}
              data-dwell
            >
              <Icon name="check" /> Got it
            </button>
          </div>
        </div>
      )}
      {!lifelineFirst && !message && ask && (
        <div
          className="cmp-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cmp-ask-title"
          data-dwell-scope="modal"
        >
          <div className="cmp-card">
            <p className="cmp-from">
              <Icon name="phone" size={28} /> From {ask.author}&apos;s phone · {when(ask.created_at)}
            </p>
            <h1 id="cmp-ask-title" className="cmp-ask">
              {ask.author} wants to change something. Is that OK?
            </h1>
            <p className="cmp-text">{ask.summary}</p>
            <p className="muted">
              This makes a difference to your safety or who AGENCY contacts, so it waits for you.
            </p>
            <div className="cmp-actions">
              <button
                className="btn btn-xl"
                onClick={() => void decide(ask, false)}
                disabled={busy}
                data-dwell
              >
                <Icon name="x" /> Don&apos;t allow
              </button>
              <button
                className="btn btn-xl"
                onClick={() => setLater((s) => new Set(s).add(ask.id))}
                disabled={busy}
                data-dwell
              >
                <Icon name="back" /> Later
              </button>
              <button
                className="btn btn-xl btn-primary"
                onClick={() => void decide(ask, true)}
                disabled={busy}
                data-dwell
                data-approval-gate
              >
                <Icon name="check" /> Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
