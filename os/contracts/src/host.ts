/**
 * The desktop host (os/desktop): what renderers see as `window.agency`, how the main process loads the other
 * packages, and the messages it exchanges with the agent utility process. Added in contracts v0 (additive).
 *
 * Renderers never get Node or Electron. The main process checks every call against the calling window's role,
 * so a method being on this interface does not mean every window may use it (see `NATIVE_ALLOWED`).
 */

import type { AgentCommand, AgentEvent } from "./agent";
import type { GazeEvent } from "./gaze";
import type { HelpSource, LifelineSignal } from "./lifeline";
import type { NativeEvent, NativeMethod, NativeMethods, PermissionKind, PermissionStatus } from "./native";
import type { ScreenRect, Target, TargetSnapshot } from "./targets";

export type WindowRole = "shell" | "overlay" | "gaze" | "onboarding";

/** Native methods each renderer role may call through `window.agency.native.call`. Everything else is main-only. */
export const NATIVE_ALLOWED: Record<WindowRole, readonly NativeMethod[]> = {
  shell: [
    "permissions.status",
    "apps.list",
    "apps.launch",
    "apps.activate",
    "apps.frontmost",
    "speech.say",
    "speech.voices",
    "speech.listen",
  ],
  overlay: [
    "ax.press",
    "input.click",
    "input.scroll",
    "input.type",
    "input.key",
    "apps.frontmost",
    "apps.activate",
  ],
  gaze: [],
  onboarding: ["permissions.status"],
};

export type Unsubscribe = () => void;

/** The display an overlay window covers, in global screen points. */
export interface OverlayDisplay {
  id: number;
  bounds: ScreenRect;
  scaleFactor: number;
  primary: boolean;
}

export type OverlayMode =
  | { type: "show" }
  | { type: "hide" }
  | { type: "keyboard"; on: boolean }
  | { type: "numbers"; on: boolean }
  | { type: "zoom"; on: boolean }
  /** Eye control paused: only protected targets (Help, Stop, Resume) stay selectable. */
  | { type: "paused"; on: boolean };

export interface StopAllResult {
  /** When main received the request (ms since epoch). */
  at: number;
  agent: "sent" | "unavailable";
  native: "ok" | "failed" | "unavailable";
}

export interface HelpResult {
  /** The coordinator accepted the alert. False means it is queued and being retried; the screen still surfaces. */
  delivered: boolean;
  alertId: string | null;
  created: boolean;
}

export type ProcessName = "native" | "agent" | "coordinator" | "gaze";
export type ProcessState = "starting" | "running" | "restarting" | "stopped" | "failed" | "fake" | "absent";

export interface HostStatus {
  version: string;
  contractsVersion: number;
  platform: string;
  processes: Record<ProcessName, ProcessState>;
  coordinator: { mode: "bundled" | "remote" | "external"; url: string | null; reachable: boolean };
  lifeline: { lastHeartbeatAt: string | null; lastHeartbeatOk: boolean };
  gazeSource: "engine" | "mouse" | "none";
}

export interface OnboardingState {
  completedSteps: string[];
  done: boolean;
}

/** `window.agency`, exposed by the preload script to every AGENCY window. */
export interface AgencyApi {
  readonly contractsVersion: number;
  readonly role: WindowRole;
  gaze: {
    onEvent(listener: (event: GazeEvent) => void): Unsubscribe;
    /** Gaze window only: publish events from the engine. */
    publish(event: GazeEvent): void;
  };
  targets: {
    /** Overlay: merged shell + accessibility + web targets, in global screen points. */
    onSnapshot(listener: (snapshot: TargetSnapshot) => void): Unsubscribe;
    /**
     * Shell: publish its own selectable targets with rects in window client coordinates (CSS pixels); main
     * converts them to global screen points.
     */
    publishShell(targets: Target[]): void;
  };
  native: {
    call<M extends NativeMethod>(
      method: M,
      params: NativeMethods[M]["params"],
    ): Promise<NativeMethods[M]["result"]>;
    onEvent(listener: (event: NativeEvent) => void): Unsubscribe;
  };
  agent: {
    send(command: AgentCommand): void;
    onEvent(listener: (event: AgentEvent) => void): Unsubscribe;
  };
  lifeline: {
    /** Never blocks: resolves when main has taken the request, even if the coordinator is unreachable. */
    help(source: HelpSource, test?: boolean): Promise<HelpResult>;
    signal(signal: LifelineSignal): void;
    onSurface(listener: () => void): Unsubscribe;
  };
  overlay: {
    display(): Promise<OverlayDisplay | null>;
    onMode(listener: (mode: OverlayMode) => void): Unsubscribe;
    /** Overlay: true while the mouse is over one of its own targets, so clicks reach it instead of passing through. */
    setInteractive(interactive: boolean): void;
  };
  stopAll(): Promise<StopAllResult>;
  /** Every window hears when Stop was used (from any window, the hotkey or the agent). */
  onStopAll(listener: (result: StopAllResult) => void): Unsubscribe;
  permissions: {
    status(): Promise<PermissionStatus>;
    /** Shows the macOS prompt when one exists, otherwise opens the right System Settings pane. */
    request(kind: PermissionKind): Promise<PermissionStatus>;
    openSettings(kind: PermissionKind): Promise<void>;
  };
  host: {
    status(): Promise<HostStatus>;
    onboarding(): Promise<OnboardingState>;
    completeOnboardingStep(step: string): Promise<OnboardingState>;
  };
}

/**
 * Messages between main and the agent utility process (os/agent), over `process.parentPort` / `MessagePort`.
 * Entry point: `os/agent/dist/utility.cjs` (built by the agent package), forked with `utilityProcess.fork`.
 */
export type HostToAgent =
  | { kind: "command"; command: AgentCommand }
  | { kind: "ping"; id: number }
  /** Reply to an `AgentToHost` native request. */
  | { kind: "native.result"; id: number; result?: unknown; error?: string };

export type AgentToHost =
  | { kind: "event"; event: AgentEvent }
  | { kind: "pong"; id: number }
  /** The agent asks main to call agency-native for it (the agent may use screen.capture during a task). */
  | { kind: "native.request"; id: number; method: NativeMethod; params: unknown }
  | { kind: "log"; level: "info" | "warn" | "error"; message: string };

/**
 * Where the main process finds the other packages. Each is optional at runtime: when one is missing the host uses
 * its own fallback (mouse gaze, a minimal overlay with Help and Stop, a fake agent) and reports it in HostStatus.
 */
export const HOST_ENTRIES = {
  /** Built by @agency/overlay. Loaded once per display with ?display=<id>. */
  overlay: "os/overlay/dist/index.html",
  /** Built by @agency/gaze. Loaded in a hidden window that alone may use the camera. */
  gaze: "os/gaze/dist/engine.html",
  /** Built by @agency/agent. */
  agent: "os/agent/dist/utility.cjs",
  /** Built by os/native-macos (SwiftPM). Override with AGENCY_NATIVE_PATH. */
  native: "os/native-macos/.build/release/agency-native",
  /** Built by frontend (Vite). */
  shell: "frontend/dist/index.html",
} as const;
