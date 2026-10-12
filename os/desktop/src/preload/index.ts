/**
 * The only bridge between AGENCY's web pages and the rest of the Mac: `window.agency` (AgencyApi in
 * os/contracts/src/host.ts). Runs sandboxed with context isolation. Main checks every call against the
 * window's role, so exposing a method here grants nothing by itself.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  CONTRACTS_VERSION,
  IPC,
  type AgencyApi,
  type AgentCommand,
  type AgentEvent,
  type CoordinatorChoice,
  type GazeEvent,
  type HelpResult,
  type HelpSource,
  type HostStatus,
  type LifelineSignal,
  type MessagingCheck,
  type MessagingSettings,
  type MessagingStatus,
  type NativeEvent,
  type NativeMethod,
  type NativeMethods,
  type OnboardingState,
  type OverlayDisplay,
  type OverlayMode,
  type PermissionKind,
  type PermissionStatus,
  type PrepareRequest,
  type PrepareResult,
  type ScreenRect,
  type SelectionEvent,
  type SendResult,
  type Suggestion,
  type Surface,
  type StopAllResult,
  type Target,
  type TargetSnapshot,
  type WindowRole,
} from "@agency/contracts";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_e: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const role = (ipcRenderer.sendSync("agency:role") ?? "shell") as WindowRole;

const api: AgencyApi = {
  contractsVersion: CONTRACTS_VERSION,
  role,
  gaze: {
    onEvent: (l) => subscribe<GazeEvent>(IPC.gaze, l),
    publish: (event) => ipcRenderer.send(IPC.gaze, event),
    onPace: (l) => subscribe<number>(IPC.gazePace, l),
  },
  targets: {
    onSnapshot: (l) => subscribe<TargetSnapshot>(IPC.targets, l),
    publishShell: (targets: Target[]) => ipcRenderer.send(IPC.shellTargets, targets),
  },
  native: {
    call: <M extends NativeMethod>(method: M, params: NativeMethods[M]["params"]) =>
      ipcRenderer.invoke(IPC.native, method, params) as Promise<NativeMethods[M]["result"]>,
    onEvent: (l) => subscribe<NativeEvent>(IPC.nativeEvent, l),
  },
  agent: {
    send: (command: AgentCommand) => ipcRenderer.send(IPC.agentCommand, command),
    onEvent: (l) => subscribe<AgentEvent>(IPC.agentEvent, l),
  },
  lifeline: {
    help: (source: HelpSource, test?: boolean) =>
      ipcRenderer.invoke(IPC.lifeline, {
        type: "lifeline.help",
        source,
        test: Boolean(test),
      } satisfies LifelineSignal) as Promise<HelpResult>,
    signal: (signal: LifelineSignal) => void ipcRenderer.invoke(IPC.lifeline, signal),
    onSurface: (l) =>
      subscribe<LifelineSignal>(IPC.lifeline, (s) => {
        if (s.type === "lifeline.surface") l();
      }),
  },
  overlay: {
    display: () => ipcRenderer.invoke(IPC.overlayDisplay) as Promise<OverlayDisplay | null>,
    onMode: (l) => subscribe<OverlayMode>(IPC.overlay, l),
    setInteractiveRegions: (rects: ScreenRect[]) => ipcRenderer.send(IPC.overlayRegions, rects),
    setInteractive: (interactive: boolean) => ipcRenderer.send(IPC.overlayInteractive, interactive),
  },
  memory: {
    suggestions: (surface: Surface, limit?: number) =>
      ipcRenderer.invoke(IPC.memory, "suggestions", { surface, limit }) as Promise<Suggestion[]>,
    usual: (path: string) => ipcRenderer.invoke(IPC.memory, "usual", { path }) as Promise<Suggestion | null>,
    event: (event: SelectionEvent) => ipcRenderer.invoke(IPC.memory, "event", event) as Promise<void>,
  },
  messaging: {
    status: () => ipcRenderer.invoke(IPC.messaging, "status") as Promise<MessagingStatus>,
    setSettings: (settings: Partial<MessagingSettings>) =>
      ipcRenderer.invoke(IPC.messaging, "setSettings", settings) as Promise<MessagingStatus>,
    check: () => ipcRenderer.invoke(IPC.messaging, "check") as Promise<MessagingCheck>,
    prepare: (request: PrepareRequest) =>
      ipcRenderer.invoke(IPC.messaging, "prepare", request) as Promise<PrepareResult>,
    send: (ticket: string, fingerprint: string) =>
      ipcRenderer.invoke(IPC.messaging, "send", { ticket, fingerprint }) as Promise<SendResult>,
    cancel: (ticket: string) => ipcRenderer.invoke(IPC.messaging, "cancel", { ticket }) as Promise<void>,
  },
  showHome: () => ipcRenderer.send(IPC.showHome),
  onShowHome: (l) => subscribe<null>(IPC.showHome, () => l()),
  stopAll: () => ipcRenderer.invoke(IPC.stopAll) as Promise<StopAllResult>,
  onStopAll: (l) => subscribe<StopAllResult>(IPC.stopAll, l),
  permissions: {
    status: () => ipcRenderer.invoke(IPC.permissions, "status") as Promise<PermissionStatus>,
    request: (kind: PermissionKind) =>
      ipcRenderer.invoke(IPC.permissions, "request", kind) as Promise<PermissionStatus>,
    openSettings: (kind: PermissionKind) =>
      ipcRenderer.invoke(IPC.permissions, "openSettings", kind) as Promise<void>,
  },
  host: {
    status: () => ipcRenderer.invoke(IPC.host, "status") as Promise<HostStatus>,
    onboarding: () => ipcRenderer.invoke(IPC.host, "onboarding") as Promise<OnboardingState>,
    setCoordinator: (setting: CoordinatorChoice) =>
      ipcRenderer.invoke(IPC.host, "setCoordinator", setting) as Promise<{ ok: boolean; error?: string }>,
    completeOnboardingStep: (step: string) =>
      ipcRenderer.invoke(IPC.host, "completeOnboardingStep", step) as Promise<OnboardingState>,
  },
};

contextBridge.exposeInMainWorld("agency", api);
