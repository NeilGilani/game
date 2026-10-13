/**
 * Where My day and care routines are kept: this computer's local storage only (`agency.daily.v1`). Nothing is
 * sent anywhere. Calendar import from the Mac isn't built (the native helper has no Calendar access yet), so
 * everything is added here, by the person or a helper.
 *
 * Practice mode (the web demo, or `agency.fakes` with "daily") starts with a made-up sample day once.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { fakeForced } from "../state/host";
import { checkData, EMPTY_DATA, sampleDay, type DailyData } from "./model";

export const DAILY_KEY = "agency.daily.v1";
const SEEDED_KEY = "agency.daily.sampleSeeded";

export function webDemo(): boolean {
  return import.meta.env.VITE_WEB_DEMO === "1";
}

/** The web demo or a test asked for practice: a sample day, a practice home and a practice carer's phone. */
export function practiceMode(): boolean {
  return webDemo() || fakeForced("daily");
}

/** `undefined` when storage can't be used at all (then the page keeps the day in memory). */
function readRaw(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

function writeRaw(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode or full: the change lives until the page closes */
  }
}

let cache: { raw: string | null; data: DailyData } | null = null;
let memory: string | null = null;
const listeners = new Set<() => void>();

function raw(): string | null {
  const stored = readRaw(DAILY_KEY);
  return stored === undefined ? memory : stored;
}

export function loadDaily(now = Date.now()): DailyData {
  let r = raw();
  if (r === null && practiceMode() && readRaw(SEEDED_KEY) !== "1") {
    r = JSON.stringify(sampleDay(now));
    writeRaw(DAILY_KEY, r);
    writeRaw(SEEDED_KEY, "1");
    memory = r;
  }
  if (cache && cache.raw === r) return cache.data;
  let data: DailyData;
  try {
    data = r === null ? structuredClone(EMPTY_DATA) : checkData(JSON.parse(r));
  } catch {
    data = structuredClone(EMPTY_DATA);
  }
  cache = { raw: r, data };
  return data;
}

export function saveDaily(data: DailyData): void {
  const r = JSON.stringify(data);
  memory = r;
  writeRaw(DAILY_KEY, r);
  for (const l of listeners) l();
}

export function updateDaily(change: (data: DailyData) => DailyData): DailyData {
  const next = change(loadDaily());
  saveDaily(next);
  return next;
}

/** Start again with nothing (the sample day isn't added again). */
export function clearDaily(): void {
  writeRaw(SEEDED_KEY, "1");
  saveDaily(structuredClone(EMPTY_DATA));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => e.key === DAILY_KEY && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The day's data, kept in step across every screen (and other tabs). */
export function useDaily(): DailyData {
  return useSyncExternalStore(subscribe, () => loadDaily());
}

/** The time, refreshed every `ms` (routines come due without anyone touching the screen). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
