/** App settings in <userData>/settings.json. Secrets (a Pi token) are encrypted with the OS keychain. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MessagingSettings } from "@agency/contracts";

export type CoordinatorSetting =
  | { mode: "bundled" }
  /** A Raspberry Pi (DEPLOY_PI.md): Lifeline's watchdog keeps running even if the Mac dies. */
  | { mode: "remote"; url: string; tokenEncrypted: string | null };

export interface AppSettings {
  coordinator: CoordinatorSetting;
  onboarding: { completedSteps: string[]; done: boolean };
  /** Electron accelerator for the global Stop hotkey. */
  stopHotkey: string;
  /** Electron accelerator for Help (opt-in; empty disables). */
  helpHotkey: string;
  /** Real calls and texts through the person's iPhone (messaging.ts): off until turned on in Settings. */
  messaging: MessagingSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  coordinator: { mode: "bundled" },
  onboarding: { completedSteps: [], done: false },
  stopHotkey: "Command+Shift+Escape",
  helpHotkey: "",
  messaging: { enabled: false, textVia: "auto", callVia: "phone" },
};

export function loadSettings(file: string): AppSettings {
  if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AppSettings>;
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...raw,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, ...(raw.onboarding ?? {}) },
      messaging: {
        ...DEFAULT_SETTINGS.messaging,
        ...(raw.messaging ?? {}),
        // Only an explicit true turns real sends on.
        enabled: raw.messaging?.enabled === true,
      },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(file: string, settings: AppSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, file);
}
