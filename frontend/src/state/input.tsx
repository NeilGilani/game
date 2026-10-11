import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { InputMode } from "../api/types";
import type { CameraErrorKind } from "../vision/camera";
import { type StoredCalibration, isStoredCalibration } from "../vision/calibrationStore";
import { type VisionStatus, visionEngine, type VisionEngine } from "../vision/tracker";
import { usePreferences } from "./preferences";

/** Eye calibrations from the gaze engine (v2). The old key held legacy models, which are no longer used. */
/** v3: scans with RealEye's eye model. Older saved scans are ignored, so the scan runs again by itself. */
const CALIBRATION_KEY = "agency.calibration.v3";
const LEGACY_CALIBRATION_KEYS = ["agency.calibration", "agency.calibration.v2"];
const CAMERA_OK_KEY = "agency.cameraConsented";

export const MODE_LABELS: Record<InputMode, { short: string; long: string; camera: boolean }> = {
  gaze: { short: "Eye gaze", long: "Eye gaze with dwell (webcam)", camera: true },
  head: { short: "Head pointer", long: "Head movement with dwell (webcam, no calibration)", camera: true },
  scan_blink: { short: "Blink switch", long: "Scanning, long blink to select (webcam)", camera: true },
  scan_key: {
    short: "Key switch",
    long: "Scanning, Space key to select (keyboard, not camera)",
    camera: false,
  },
  pointer: { short: "Mouse & keys", long: "Mouse, trackpad, keyboard or touch", camera: false },
};

function loadCalibration(): { model: StoredCalibration | null; remembered: boolean } {
  for (const [storage, remembered] of [
    [localStorage, true],
    [sessionStorage, false],
  ] as const) {
    try {
      const raw = storage.getItem(CALIBRATION_KEY);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      if (isStoredCalibration(parsed)) return { model: parsed, remembered };
    } catch {
      /* ignore corrupt or unavailable storage */
    }
  }
  return { model: null, remembered: false };
}

export type Tracking = "idle" | "ok" | "weak" | "lost";

interface InputState {
  mode: InputMode;
  usesCamera: boolean;
  vision: VisionEngine;
  status: VisionStatus;
  error: CameraErrorKind | null;
  /** The eye calibration (eye gaze only; the head pointer needs none). */
  calibration: StoredCalibration | null;
  calibrationRemembered: boolean;
  calibrationNeeded: boolean;
  setCalibration: (model: StoredCalibration | null, remember: boolean) => void;
  eyeControlPaused: boolean;
  setEyeControlPaused: (paused: boolean) => void;
  tracking: Tracking;
  setTracking: (t: Tracking) => void;
  fallbackActive: boolean;
  setFallbackActive: (active: boolean) => void;
  suspended: boolean;
  setSuspended: (s: boolean) => void;
  startCamera: () => Promise<void>;
  stopCamera: () => void;
}

const InputContext = createContext<InputState | null>(null);

export function InputProvider({ children }: { children: ReactNode }) {
  const { prefs } = usePreferences();
  const vision = useMemo(() => visionEngine(), []);
  const [status, setStatus] = useState<VisionStatus>(vision.status);
  const [error, setError] = useState<CameraErrorKind | null>(vision.error);
  const [{ model: calibration, remembered }, setCal] = useState(loadCalibration);
  const [eyeControlPaused, setEyeControlPaused] = useState(false);
  const [tracking, setTracking] = useState<Tracking>("idle");
  const [fallbackActive, setFallbackActive] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const mode = prefs.input_mode;
  const usesCamera = MODE_LABELS[mode].camera;

  useEffect(
    () =>
      vision.onStatus((s, e) => {
        setStatus(s);
        setError(e);
        if (s === "running") {
          try {
            localStorage.setItem(CAMERA_OK_KEY, "1");
          } catch {
            /* ignore */
          }
        }
      }),
    [vision],
  );

  useEffect(() => {
    vision.setCalibration(calibration);
  }, [vision, calibration]);

  // The head pointer needs no calibration: it starts centred on the current head pose.
  useEffect(() => {
    vision.setKind(mode === "head" ? "head" : "gaze");
  }, [vision, mode]);

  // Start the camera automatically for camera modes once the person has granted access before.
  useEffect(() => {
    let consented = false;
    try {
      consented = localStorage.getItem(CAMERA_OK_KEY) === "1";
    } catch {
      consented = false;
    }
    if (usesCamera && consented && vision.status === "off") void vision.start();
  }, [usesCamera, vision]);

  const setCalibration = useCallback((model: StoredCalibration | null, remember: boolean) => {
    try {
      for (const storage of [localStorage, sessionStorage]) {
        storage.removeItem(CALIBRATION_KEY);
        for (const key of LEGACY_CALIBRATION_KEYS) storage.removeItem(key);
      }
      if (model) (remember ? localStorage : sessionStorage).setItem(CALIBRATION_KEY, JSON.stringify(model));
    } catch {
      /* storage unavailable: keep in memory only */
    }
    setCal({ model, remembered: remember && !!model });
  }, []);

  const value: InputState = {
    mode,
    usesCamera,
    vision,
    status,
    error,
    calibration,
    calibrationRemembered: remembered,
    calibrationNeeded: mode === "gaze" && !calibration,
    setCalibration,
    eyeControlPaused,
    setEyeControlPaused,
    tracking,
    setTracking,
    fallbackActive,
    setFallbackActive,
    suspended,
    setSuspended,
    startCamera: () => vision.start(),
    stopCamera: () => {
      vision.stop();
      setTracking("idle");
    },
  };
  return <InputContext.Provider value={value}>{children}</InputContext.Provider>;
}

export function useInput(): InputState {
  const ctx = useContext(InputContext);
  if (!ctx) throw new Error("useInput outside InputProvider");
  return ctx;
}
