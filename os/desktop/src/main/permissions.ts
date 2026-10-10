/**
 * macOS privacy permissions, with plain-language explanations for onboarding and deep links to the right
 * System Settings pane. agency-native runs inside AGENCY.app, so macOS attributes its permissions to the app.
 */

import type { PermissionKind, PermissionState, PermissionStatus } from "@agency/contracts";

export const PERMISSION_KINDS: PermissionKind[] = [
  "camera",
  "accessibility",
  "screen-recording",
  "microphone",
  "speech-recognition",
];

export const SETTINGS_PANES: Record<PermissionKind, string> = {
  camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "speech-recognition": "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
};

/** Plain language for the person and their helper. Shown in onboarding and Settings. */
export const EXPLANATIONS: Record<PermissionKind, { title: string; why: string; required: boolean }> = {
  camera: {
    title: "Camera",
    why: "Your eyes move the pointer. The camera picture stays on this Mac. It is never saved or sent anywhere.",
    required: true,
  },
  accessibility: {
    title: "Accessibility",
    why: "Lets your eyes press buttons in every app, not just in AGENCY.",
    required: true,
  },
  "screen-recording": {
    title: "Screen Recording",
    why: "Lets AGENCY see the screen during a task you started, so it can check its work. Nothing is recorded or kept.",
    required: false,
  },
  microphone: {
    title: "Microphone",
    why: "Lets AGENCY hear the other person on a call, so you can answer them. Used only during calls.",
    required: false,
  },
  "speech-recognition": {
    title: "Speech Recognition",
    why: "Turns what the other person says into words on your screen. It runs on this Mac.",
    required: false,
  },
};

export function mapMediaStatus(status: string): PermissionState {
  if (status === "granted") return "granted";
  if (status === "denied" || status === "restricted") return "denied";
  return "not-determined";
}

export interface PermissionDeps {
  platform: string;
  mediaStatus(kind: "camera" | "microphone" | "screen"): string;
  askMedia(kind: "camera" | "microphone"): Promise<boolean>;
  accessibilityTrusted(prompt: boolean): boolean;
  /** agency-native's view, when it is running (needed for speech recognition). */
  nativeStatus(): Promise<PermissionStatus | null>;
  nativeRequest(kind: PermissionKind): Promise<PermissionStatus | null>;
  openUrl(url: string): Promise<void>;
}

export class Permissions {
  constructor(private readonly deps: PermissionDeps) {}

  async status(): Promise<PermissionStatus> {
    if (this.deps.platform !== "darwin") {
      // No TCC outside macOS (Linux CI): report what we can't check as not determined, honestly.
      return {
        camera: "not-determined",
        accessibility: "not-determined",
        "screen-recording": "not-determined",
        microphone: "not-determined",
        "speech-recognition": "not-determined",
      };
    }
    const native = await this.deps.nativeStatus().catch(() => null);
    return {
      camera: mapMediaStatus(this.deps.mediaStatus("camera")),
      microphone: mapMediaStatus(this.deps.mediaStatus("microphone")),
      "screen-recording": mapMediaStatus(this.deps.mediaStatus("screen")),
      accessibility: this.deps.accessibilityTrusted(false)
        ? "granted"
        : (native?.accessibility ?? "not-determined"),
      "speech-recognition": native?.["speech-recognition"] ?? "not-determined",
    };
  }

  async request(kind: PermissionKind): Promise<PermissionStatus> {
    if (this.deps.platform === "darwin") {
      const current = (await this.status())[kind];
      if (current === "granted") return this.status();
      if (current === "denied") {
        // macOS won't ask twice; only System Settings can change it now.
        await this.openSettings(kind);
      } else if (kind === "camera" || kind === "microphone") {
        await this.deps.askMedia(kind);
      } else if (kind === "accessibility") {
        this.deps.accessibilityTrusted(true);
      } else {
        const res = await this.deps.nativeRequest(kind).catch(() => null);
        if (!res) await this.openSettings(kind);
      }
    }
    return this.status();
  }

  async openSettings(kind: PermissionKind): Promise<void> {
    if (this.deps.platform !== "darwin") return;
    await this.deps.openUrl(SETTINGS_PANES[kind]);
  }
}
