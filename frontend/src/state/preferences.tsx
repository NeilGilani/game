import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Preferences } from "../api/types";
import { useConnection } from "./connection";

export const DEFAULT_PREFERENCES: Preferences = {
  input_mode: "pointer",
  dwell_ms: 1200,
  dwell_stability_px: 60,
  target_snap_px: 48,
  scan_interval_ms: 1500,
  blink_ms: 450,
  text_scale: 1,
  theme: "system",
  reduced_motion: false,
  show_gaze_cursor: true,
  confirm_consequential: true,
  auto_fallback_to_scan: true,
  speak_feedback: false,
};

const STORAGE_KEY = "agency.preferences";
const EASY_READ_KEY = "agency.easyRead";

/** The "Easy-read font" setting (Atkinson Hyperlegible), kept on this device. */
export function applyEasyRead(on?: boolean): void {
  try {
    if (on === undefined) on = localStorage.getItem(EASY_READ_KEY) === "1";
    else localStorage.setItem(EASY_READ_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (on) document.documentElement.dataset.font = "easy-read";
  else delete document.documentElement.dataset.font;
}
applyEasyRead();

function loadLocal(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_PREFERENCES, ...(JSON.parse(raw) as Partial<Preferences>) };
  } catch {
    /* ignore */
  }
  return DEFAULT_PREFERENCES;
}

interface PreferencesState {
  prefs: Preferences;
  update: (patch: Partial<Preferences>) => void;
  synced: boolean;
}

const PreferencesContext = createContext<PreferencesState | null>(null);

/**
 * Accessibility preferences: applied immediately, cached on this device, and stored on the
 * coordinator so they follow the person. They contain no camera or biometric data.
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(loadLocal);
  const [synced, setSynced] = useState(false);
  const { online, health } = useConnection();
  const pulled = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    if (!online || !health || pulled.current) return;
    pulled.current = true;
    api
      .preferences()
      .then((remote) => {
        if (!dirty.current && localStorage.getItem(STORAGE_KEY) === null)
          setPrefs({ ...DEFAULT_PREFERENCES, ...remote });
        setSynced(true);
      })
      .catch(() => setSynced(false));
  }, [online, health]);

  const update = useCallback((patch: Partial<Preferences>) => {
    dirty.current = true;
    setPrefs((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      api
        .savePreferences(next)
        .then(() => setSynced(true))
        .catch(() => setSynced(false));
      return next;
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--text-scale", String(prefs.text_scale));
    if (prefs.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", prefs.theme);
    root.toggleAttribute("data-reduced-motion", prefs.reduced_motion);
  }, [prefs.text_scale, prefs.theme, prefs.reduced_motion]);

  return (
    <PreferencesContext.Provider value={{ prefs, update, synced }}>{children}</PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesState {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences outside PreferencesProvider");
  return ctx;
}
