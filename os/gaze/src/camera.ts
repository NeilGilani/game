/** Camera access and the failures a person can actually hit, in plain language. */

export type CameraErrorKind =
  | "unsupported"
  | "insecure-context"
  | "permission-denied"
  | "no-camera"
  | "camera-busy"
  | "stream-lost"
  | "model-failed"
  | "unknown";

export interface CameraErrorInfo {
  title: string;
  body: string;
}

export const CAMERA_ERRORS: Record<CameraErrorKind, CameraErrorInfo> = {
  unsupported: {
    title: "This browser can't use the camera",
    body: "Open AGENCY in a current version of Chrome, Edge or Safari. You can keep using AGENCY with the keyboard, mouse or switch scanning.",
  },
  "insecure-context": {
    title: "Camera needs a secure address",
    body: "Browsers only allow the camera on https or on localhost. Open AGENCY at http://localhost on this MacBook.",
  },
  "permission-denied": {
    title: "Camera permission was not given",
    body: "Allow camera access for this page (the camera icon in the address bar), then press Try again. Video stays on this computer.",
  },
  "no-camera": {
    title: "No camera found",
    body: "Check that the built-in camera is enabled and not covered, then press Try again.",
  },
  "camera-busy": {
    title: "The camera is in use",
    body: "Another app (for example a video call) is using the camera. Close it, then press Try again.",
  },
  "stream-lost": {
    title: "The camera stopped",
    body: "The camera feed ended unexpectedly. Press Try again. Eye control is paused until it's back.",
  },
  "model-failed": {
    title: "Face tracking couldn't start",
    body: "The face-tracking model failed to load. Reload the page; if it keeps happening, use switch scanning or the keyboard.",
  },
  unknown: {
    title: "Something went wrong with the camera",
    body: "Press Try again. You can keep using AGENCY with the keyboard, mouse or switch scanning.",
  },
};

export interface CameraEnvironment {
  secure: boolean;
  hasMediaDevices: boolean;
}

export function classifyCameraError(error: unknown, env: CameraEnvironment): CameraErrorKind {
  if (!env.secure) return "insecure-context";
  if (!env.hasMediaDevices) return "unsupported";
  const name =
    typeof error === "object" && error && "name" in error ? String((error as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "permission-denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no-camera";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "camera-busy";
    case "ModelLoadError":
      return "model-failed";
    default:
      return "unknown";
  }
}

export function cameraEnvironment(): CameraEnvironment {
  return {
    secure: typeof window !== "undefined" ? window.isSecureContext : false,
    hasMediaDevices: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
  };
}

export async function openCamera(): Promise<MediaStream> {
  const env = cameraEnvironment();
  if (!env.secure || !env.hasMediaDevices) {
    throw Object.assign(new Error("camera unavailable"), {
      name: env.secure ? "NotSupportedError" : "SecurityError",
    });
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    // 1280x720: at a normal distance the face fills only a small part of a laptop camera's view, and at
    // 640x480 each iris was a handful of pixels, too few for steady gaze. Face Landmarker crops the face
    // and scales it to its own input size, so the extra pixels go to the eyes, at little extra cost.
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
}
