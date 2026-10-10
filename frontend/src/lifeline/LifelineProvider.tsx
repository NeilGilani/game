/**
 * Lifeline on the person's computer: how help is asked for, and what keeps working when
 * things go wrong.
 *
 * - Help can be asked for three ways: the Help button (first in scanning order), three long
 *   blinks (watched whenever the camera is on, in every input mode, even with eye control
 *   paused), or a switch press on the Help button.
 * - The coordinator owns the alert. This side shows it and sounds the alarm.
 * - If the coordinator can't be reached, the request is queued (and kept across a reload), the
 *   alarm sounds here immediately, and sending is retried until it gets through.
 * - Heartbeats tell the coordinator this screen is alive, for "Watch over me".
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, accessToken, coordinatorUrl, lifelineApi } from "../api/client";
import type { AlertDetail, HeartbeatBody, HelpSource, LifelineStatus } from "../api/types";
import { useAnnounce } from "../state/announcer";
import { useInput } from "../state/input";
import { usePreferences } from "../state/preferences";
import { alarm } from "./alarm";
import { HelpPattern, type PatternState } from "./pattern";

const QUEUE_KEY = "agency.lifeline.queued";
const HEARTBEAT_MS = 5000;

export interface QueuedHelp {
  source: HelpSource;
  test: boolean;
  at: number;
  attempts: number;
  lastError: string | null;
}

export interface LifelineState {
  status: LifelineStatus | null;
  /** The coordinator's Lifeline answered the last poll. */
  online: boolean;
  /** Server clock minus this clock, to show the coordinator's timers correctly. */
  offsetMs: number;
  open: AlertDetail | null;
  queued: QueuedHelp | null;
  pattern: PatternState;
  silenced: boolean;
  alarmReady: boolean;
  frozen: boolean;
  busy: boolean;
  error: string | null;
  requestHelp: (source: HelpSource, test?: boolean) => Promise<void>;
  cancel: () => Promise<void>;
  callNow: () => Promise<void>;
  resolve: () => Promise<void>;
  checkinOk: (source: string) => Promise<void>;
  silence: () => void;
  setArmed: (armed: boolean) => Promise<void>;
  setFrozen: (frozen: boolean) => void;
  refresh: () => Promise<void>;
  testAlarm: () => Promise<boolean>;
}

const LifelineContext = createContext<LifelineState | null>(null);

const IDLE_PATTERN: PatternState = { counted: 0, closed: false, holdProgress: 0, fired: false };

function loadQueued(): QueuedHelp | null {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<QueuedHelp>;
    if (typeof value.source !== "string" || typeof value.at !== "number") return null;
    return { source: value.source, test: !!value.test, at: value.at, attempts: 0, lastError: null };
  } catch {
    return null;
  }
}

function saveQueued(q: QueuedHelp | null): void {
  try {
    if (q) localStorage.setItem(QUEUE_KEY, JSON.stringify({ source: q.source, test: q.test, at: q.at }));
    else localStorage.removeItem(QUEUE_KEY);
  } catch {
    /* storage unavailable: the request is still retried while this page is open */
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

export function LifelineProvider({ children }: { children: ReactNode }) {
  const announce = useAnnounce();
  const input = useInput();
  const { prefs } = usePreferences();
  const [status, setStatus] = useState<LifelineStatus | null>(null);
  const [online, setOnline] = useState(true);
  const [offsetMs, setOffsetMs] = useState(0);
  const [lastOpen, setLastOpen] = useState<AlertDetail | null>(null);
  const [queued, setQueuedState] = useState<QueuedHelp | null>(loadQueued);
  const [pattern, setPattern] = useState<PatternState>(IDLE_PATTERN);
  const [silencedId, setSilencedId] = useState<string | null>(null);
  const [alarmReady, setAlarmReady] = useState(() => alarm().ready);
  const [frozen, setFrozen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queuedRef = useRef(queued);
  const setQueued = useCallback((q: QueuedHelp | null) => {
    queuedRef.current = q;
    saveQueued(q);
    setQueuedState(q);
  }, []);

  // ---- status from the coordinator ----------------------------------------------------
  const applyStatus = useCallback((s: LifelineStatus) => {
    setStatus(s);
    setOnline(true);
    setOffsetMs(Date.parse(s.server_time) - Date.now());
    setLastOpen(s.open_alert);
  }, []);

  // Bumped by every change this screen makes, so a status poll that started before the change
  // can't overwrite the newer state when it lands (the emergency screen would flicker).
  const changes = useRef(0);
  const refresh = useCallback(async () => {
    const seen = changes.current;
    try {
      const s = await lifelineApi.status();
      if (seen === changes.current) applyStatus(s);
    } catch {
      // Keep showing the last known alert: the coordinator carries on without this screen.
      setOnline(false);
    }
  }, [applyStatus]);

  const urgent = !!queued || !!lastOpen || !!status?.monitor.checkin_pending_since;
  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    const tick = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(tick, urgent ? 1000 : 3000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refresh, urgent]);

  // ---- sending help (queued until the coordinator has it) -----------------------------
  const send = useCallback(async () => {
    const q = queuedRef.current;
    if (!q) return;
    try {
      const out = await lifelineApi.help(q.source, q.test);
      changes.current += 1;
      setQueued(null);
      setLastOpen(out.alert);
      setError(null);
      await refresh();
    } catch (err) {
      const next = { ...q, attempts: q.attempts + 1, lastError: message(err) };
      queuedRef.current = next;
      setQueuedState(next);
      setOnline(!(err instanceof ApiError && err.offline));
    }
  }, [refresh, setQueued]);

  useEffect(() => {
    if (!queued) return;
    const timer = window.setInterval(() => void send(), 2000);
    return () => window.clearInterval(timer);
  }, [queued, send]);

  const openRef = useRef<AlertDetail | null>(null);
  openRef.current = lastOpen;
  const requestHelp = useCallback(
    async (source: HelpSource, test = false) => {
      if (queuedRef.current) return;
      if (openRef.current) {
        // Already being handled: the coordinator just notes the extra signal.
        announce("Help is already being called.", true);
        await lifelineApi.help(source, test).catch(() => undefined);
        await refresh();
        return;
      }
      setQueued({ source, test, at: Date.now(), attempts: 0, lastError: null });
      announce(test ? "Sending a test alert." : "Calling for help.", true);
      await send();
    },
    [announce, refresh, send, setQueued],
  );

  const act = useCallback(
    async (fn: () => Promise<unknown>, done?: string) => {
      setBusy(true);
      try {
        await fn();
        changes.current += 1;
        setError(null);
        if (done) announce(done, true);
      } catch (err) {
        setError(message(err));
        announce(message(err), true);
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [announce, refresh],
  );

  const open = lastOpen;
  const cancel = useCallback(async () => {
    if (queuedRef.current) {
      setQueued(null);
      announce("Cancelled. Nothing was sent.", true);
      return;
    }
    if (!open) return;
    await act(() => lifelineApi.cancel(open.id), "Cancelled. No one was contacted.");
  }, [act, announce, open, setQueued]);

  const callNow = useCallback(async () => {
    if (open) await act(() => lifelineApi.callNow(open.id), "Calling for help now.");
  }, [act, open]);

  const resolve = useCallback(async () => {
    if (open)
      await act(
        () => lifelineApi.resolve(open.id),
        "Alert ended. Everyone who was alerted is being told you're OK.",
      );
  }, [act, open]);

  const checkinOk = useCallback(
    async (source: string) => {
      await act(() => lifelineApi.checkin(source), "Thanks. Check-in answered.");
    },
    [act],
  );

  const setArmed = useCallback(
    async (armed: boolean) => {
      await act(
        () => lifelineApi.setMonitoring(armed),
        armed ? "Watch over me is on." : "Watch over me is off.",
      );
    },
    [act],
  );

  // ---- eye help signal ----------------------------------------------------------------
  const requestRef = useRef(requestHelp);
  requestRef.current = requestHelp;
  const lastFaceAt = useRef(0);
  useEffect(() => {
    const detector = new HelpPattern();
    let shown = 0;
    return input.vision.onFrame((frame) => {
      if (frame.face) lastFaceAt.current = frame.t;
      const state = detector.update(frame.t, frame.face ? frame.blink : null);
      // Only re-render when something visible changes.
      const key = state.counted * 10 + (state.closed ? Math.round(state.holdProgress * 4) + 1 : 0);
      if (state.fired) {
        // The emergency screen takes over from the meter.
        shown = 0;
        setPattern(IDLE_PATTERN);
        void requestRef.current("eye_signal");
      } else if (key !== shown) {
        shown = key;
        setPattern(state);
      }
    });
  }, [input.vision]);

  // No frames, no pattern: don't leave a half-finished count on screen when the camera stops.
  useEffect(() => {
    if (input.status !== "running") setPattern(IDLE_PATTERN);
  }, [input.status]);

  // ---- heartbeat ---------------------------------------------------------------------
  const visionStatus = input.status;
  const mode = prefs.input_mode;
  const bodyRef = useRef<HeartbeatBody | null>(null);
  const computeBody = useCallback((): HeartbeatBody => {
    const running = input.vision.status === "running";
    const faceVisible = running && performance.now() - lastFaceAt.current < 3000;
    return {
      signal_ready: running && faceVisible && !document.hidden,
      camera: input.vision.status,
      face_visible: faceVisible,
      page_visible: !document.hidden,
      input_mode: mode,
    };
  }, [input.vision, mode]);

  const workerRef = useRef<Worker | null>(null);
  useEffect(() => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL("./heartbeat.worker.ts", import.meta.url), { type: "module" });
    } catch {
      worker = null;
    }
    workerRef.current = worker;
    let fallback: number | null = null;
    if (!worker) {
      fallback = window.setInterval(() => {
        if (bodyRef.current) void lifelineApi.heartbeat(bodyRef.current).catch(() => undefined);
      }, HEARTBEAT_MS);
    }
    return () => {
      worker?.terminate();
      workerRef.current = null;
      if (fallback !== null) window.clearInterval(fallback);
    };
  }, []);

  useEffect(() => {
    const push = (now: boolean) => {
      const body = computeBody();
      bodyRef.current = body;
      workerRef.current?.postMessage({
        base: coordinatorUrl() || window.location.origin,
        token: accessToken(),
        intervalMs: HEARTBEAT_MS,
        running: !frozen,
        body,
        now: now && !frozen,
      });
    };
    push(true);
    const timer = window.setInterval(() => push(false), 1000);
    const onVisibility = () => push(true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [computeBody, frozen, visionStatus]);

  // ---- alarm and announcements ----------------------------------------------------------
  useEffect(() => alarm().onChange(() => setAlarmReady(alarm().ready)), []);

  const silenceKey = open ? open.id : queued ? `queued-${queued.at}` : null;
  const silenced = !!silenceKey && silencedId === silenceKey;
  const checkinPending = !!status?.monitor.checkin_pending_since && !open;
  useEffect(() => {
    const a = alarm();
    const unanswered = !!open && (open.status === "active" || (!online && open.status !== "acknowledged"));
    if (queued && !queued.test && !silenced) a.siren();
    else if (queued) a.stop();
    else if (open?.status === "pending_cancel") a.countdown();
    else if (unanswered && !silenced) a.siren();
    else a.stop();
  }, [open, online, queued, silenced]);

  const prevStatus = useRef<string | null>(null);
  useEffect(() => {
    const now = open ? `${open.id}:${open.status}` : null;
    if (now === prevStatus.current) return;
    const before = prevStatus.current;
    prevStatus.current = now;
    if (!open) return;
    if (open.status === "pending_cancel") {
      announce(`Calling for help in a few seconds. Look at Cancel if you're OK.`, true);
    } else if (open.status === "active" && before?.startsWith(open.id)) {
      announce(
        open.local_only ? "Alarm sounding. No contacts can be reached." : "Help is being called.",
        true,
      );
    } else if (open.status === "acknowledged") {
      alarm().chime();
      announce(`${open.acknowledged_by ?? "Someone"} is on the way.`, true);
    }
  }, [announce, open]);

  useEffect(() => {
    if (!checkinPending) return;
    alarm().chime();
    announce("Check-in: are you OK? Look at I'm OK.", true);
    const timer = window.setInterval(() => alarm().chime(), 20000);
    return () => window.clearInterval(timer);
  }, [announce, checkinPending]);

  const value = useMemo<LifelineState>(
    () => ({
      status,
      online,
      offsetMs,
      open,
      queued,
      pattern,
      silenced,
      alarmReady,
      frozen,
      busy,
      error,
      requestHelp,
      cancel,
      callNow,
      resolve,
      checkinOk,
      silence: () => {
        setSilencedId(silenceKey);
        alarm().stop();
      },
      setArmed,
      setFrozen,
      refresh,
      testAlarm: () => alarm().test(),
    }),
    [
      status,
      online,
      offsetMs,
      open,
      queued,
      pattern,
      silenced,
      alarmReady,
      frozen,
      busy,
      error,
      requestHelp,
      cancel,
      callNow,
      resolve,
      checkinOk,
      setArmed,
      refresh,
      silenceKey,
    ],
  );
  return <LifelineContext.Provider value={value}>{children}</LifelineContext.Provider>;
}

export function useLifeline(): LifelineState {
  const ctx = useContext(LifelineContext);
  if (!ctx) throw new Error("useLifeline outside LifelineProvider");
  return ctx;
}
