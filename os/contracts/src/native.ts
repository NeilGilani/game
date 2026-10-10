/**
 * agency-native: the Swift helper (os/native-macos). Newline-delimited JSON-RPC 2.0 over stdio.
 * Only the Electron main process talks to it. Methods map 1:1 to the entries below.
 * Events are JSON-RPC notifications: {"jsonrpc":"2.0","method":"event","params":<NativeEvent>}.
 * Logs go to stderr (the host writes them to ~/Library/Logs/AGENCY/native.log), never stdout.
 */

import type { TargetSnapshot } from "./targets";

export type PermissionKind = "accessibility" | "screen-recording" | "camera" | "microphone" | "speech-recognition";
export type PermissionState = "granted" | "denied" | "not-determined";
export type PermissionStatus = Record<PermissionKind, PermissionState>;
export type Modifier = "cmd" | "ctrl" | "alt" | "shift" | "fn";

export interface AppInfo {
  bundleId: string;
  name: string;
  path: string;
  running: boolean;
  frontmost: boolean;
  /** Small PNG icon, base64, for Home's Apps screen. */
  iconPng?: string;
}

export interface NativeMethods {
  "permissions.status": { params: Record<string, never>; result: PermissionStatus };
  "permissions.request": { params: { kind: PermissionKind }; result: PermissionStatus };
  "ax.targets": { params: { maxCount?: number; includeWeb?: boolean }; result: TargetSnapshot };
  /** Prefer this: performs the element's AXPress/AXConfirm action. */
  "ax.press": { params: { targetId: string }; result: { ok: boolean; error?: string } };
  "input.click": { params: { x: number; y: number; button?: "left" | "right"; count?: 1 | 2 }; result: { ok: boolean } };
  "input.scroll": { params: { x: number; y: number; dx: number; dy: number }; result: { ok: boolean } };
  /** Refuses (ok: false) when the focused element is a secure text field. */
  "input.type": { params: { text: string }; result: { ok: boolean; error?: string } };
  "input.key": { params: { key: string; modifiers?: Modifier[] }; result: { ok: boolean } };
  "apps.list": { params: { includeIcons?: boolean }; result: { apps: AppInfo[] } };
  "apps.launch": { params: { bundleId: string }; result: { ok: boolean; error?: string } };
  "apps.activate": { params: { bundleId: string }; result: { ok: boolean } };
  "apps.frontmost": { params: Record<string, never>; result: { app: AppInfo | null } };
  /** For the agent during a task only. Never written to disk by the helper. */
  "screen.capture": {
    params: { displayId?: number; maxWidth?: number; format?: "png" | "jpeg" };
    result: { data: string; width: number; height: number; scale: number; format: "png" | "jpeg" };
  };
  "speech.say": { params: { text: string; voiceId?: string; rate?: number }; result: { ok: boolean } };
  "speech.voices": { params: Record<string, never>; result: { voices: { id: string; name: string; personal: boolean }[] } };
  /** On-device recognition only (SFSpeechRecognizer.requiresOnDeviceRecognition). Results arrive as events. */
  "speech.listen": { params: { on: boolean; locale?: string }; result: { ok: boolean; error?: string } };
  /** Global kill switch: stop all synthetic input immediately. */
  "input.stopAll": { params: Record<string, never>; result: { ok: boolean } };
}

export type NativeMethod = keyof NativeMethods;

export type NativeEvent =
  | { type: "frontmost-changed"; app: AppInfo | null }
  | { type: "targets-changed"; owner: string | null }
  | { type: "speech-partial"; text: string }
  | { type: "speech-final"; text: string }
  | { type: "permission-changed"; status: PermissionStatus };
