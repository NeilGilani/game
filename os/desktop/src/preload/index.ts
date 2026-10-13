/**
 * The only bridge between AGENCY's web pages and the rest of the Mac: `window.agency` (AgencyApi in
 * os/contracts/src/host.ts). Runs sandboxed with context isolation. Main checks every call against the
 * window's role, so exposing a method here grants nothing by itself.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  CONTRACTS_VERSION,
  IPC,
  type ActivateResult,
  type AgencyApi,
  type BrowserApi,
  type BrowserEvent,
  type BrowserSettings,
  type BrowserState,
  type Favourite,
  type FieldResult,
  type HistoryEntry,
  type OpenResult,
  type PageFrame,
  type PopupInfo,
  type ReaderArticle,
  type SitePermissionEntry,
  type VideoState,
  type AgentCommand,
  type AgentEvent,
  type CoordinatorChoice,
  type GazeEvent,
  type HelpResult,
  type HelpSource,
  type HomeRunResult,
  type HomeSaveResult,
  type HomeSetup,
  type HomeShortcutsResult,
  type HomeStatus,
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
  type PaperFile,
  type PapersFolder,
  type PapersFolderChoice,
  type PermissionKind,
  type PermissionStatus,
  type PrepareRequest,
  type PrepareResult,
  type RealOrderingSetting,
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

/** AGENCY Browser's calls (main allows them from the shell only and checks every argument). */
const b = (op: string, ...args: unknown[]) => ipcRenderer.invoke(IPC.browser, op, ...args);

const browser: BrowserApi = {
  state: () => b("state") as Promise<BrowserState>,
  onEvent: (l) => subscribe<BrowserEvent>(IPC.browserEvent, l),
  layout: (rect, visible) => void b("layout", rect, visible).catch(() => undefined),
  open: (request) => b("open", request) as Promise<OpenResult>,
  navigate: (tabId, url) => b("navigate", tabId, url) as Promise<OpenResult>,
  back: (tabId) => b("back", tabId) as Promise<void>,
  forward: (tabId) => b("forward", tabId) as Promise<void>,
  reload: (tabId) => b("reload", tabId) as Promise<void>,
  stopLoading: (tabId) => b("stopLoading", tabId) as Promise<void>,
  start: (tabId) => b("start", tabId) as Promise<void>,
  newTab: () => b("newTab") as Promise<number>,
  closeTab: (tabId) => b("closeTab", tabId) as Promise<void>,
  activateTab: (tabId) => b("activateTab", tabId) as Promise<void>,
  zoom: (tabId, change) => b("zoom", tabId, change) as Promise<number>,
  thumbnails: () => b("thumbnails") as Promise<Record<number, string>>,
  frame: (tabId) => b("frame", tabId) as Promise<PageFrame | null>,
  activate: (tabId, ref, confirmed) =>
    b("activate", tabId, ref, confirmed === true) as Promise<ActivateResult>,
  field: (tabId, ref, op) => b("field", tabId, ref, op) as Promise<FieldResult>,
  chooseOption: (tabId, ref, option) => b("chooseOption", tabId, ref, option) as Promise<boolean>,
  scroll: (tabId, request) => void b("scroll", tabId, request).catch(() => undefined),
  reader: (tabId) => b("reader", tabId) as Promise<ReaderArticle | null>,
  popup: (tabId) => b("popup", tabId) as Promise<PopupInfo | null>,
  closePopup: (tabId, ref) => b("closePopup", tabId, ref) as Promise<boolean>,
  video: (tabId, command) => b("video", tabId, command) as Promise<VideoState | null>,
  exitBigScreen: () => void b("exitBigScreen").catch(() => undefined),
  answer: (id, answer) => void b("answer", id, answer).catch(() => undefined),
  history: () => b("history") as Promise<HistoryEntry[]>,
  clearHistory: () => b("clearHistory") as Promise<void>,
  favourites: () => b("favourites") as Promise<Favourite[]>,
  setFavourites: (list) => b("setFavourites", list) as Promise<Favourite[]>,
  settings: () => b("settings") as Promise<BrowserSettings>,
  setSettings: (s) => b("setSettings", s) as Promise<BrowserSettings>,
  sitePermissions: () => b("sitePermissions") as Promise<SitePermissionEntry[]>,
  forgetSitePermission: (origin, permission) =>
    b("forgetSitePermission", origin, permission) as Promise<void>,
  clearSiteData: () => b("clearSiteData") as Promise<void>,
};

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
    realOrdering: () => ipcRenderer.invoke(IPC.host, "realOrdering") as Promise<RealOrderingSetting>,
    setRealOrdering: (setting: RealOrderingSetting) =>
      ipcRenderer.invoke(IPC.host, "setRealOrdering", setting) as Promise<{
        ok: boolean;
        error?: string;
        setting?: RealOrderingSetting;
      }>,
  },
  // Main allows these from the shell only, and checks every name and byte (src/main/papers.ts).
  papers: {
    folder: () => ipcRenderer.invoke(IPC.papers, "folder") as Promise<PapersFolder | null>,
    chooseFolder: (choice: PapersFolderChoice) =>
      ipcRenderer.invoke(IPC.papers, "chooseFolder", choice) as Promise<PapersFolder | null>,
    clearFolder: () => ipcRenderer.invoke(IPC.papers, "clearFolder") as Promise<void>,
    list: () => ipcRenderer.invoke(IPC.papers, "list") as Promise<PaperFile[]>,
    read: (name: string) => ipcRenderer.invoke(IPC.papers, "read", name) as Promise<Uint8Array>,
    saveCopy: (original: string, suffix: "filled" | "signed", bytes: Uint8Array) =>
      ipcRenderer.invoke(IPC.papers, "saveCopy", original, suffix, bytes) as Promise<{ name: string }>,
  },
  // Main allows the home from the shell only, and runs only shortcuts a helper saved (src/main/home/control.ts).
  home: {
    status: () => ipcRenderer.invoke(IPC.home, "status") as Promise<HomeStatus>,
    save: (setup: HomeSetup) => ipcRenderer.invoke(IPC.home, "save", setup) as Promise<HomeSaveResult>,
    shortcuts: () => ipcRenderer.invoke(IPC.home, "shortcuts") as Promise<HomeShortcutsResult>,
    run: (deviceId: string, actionId: string, confirmed: boolean) =>
      ipcRenderer.invoke(IPC.home, "run", deviceId, actionId, confirmed) as Promise<HomeRunResult>,
  },
  // Main allows AGENCY Browser from the shell only (the role is checked there, on every call).
  browser,
};

contextBridge.exposeInMainWorld("agency", api);
