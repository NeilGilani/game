/**
 * AGENCY.app main process: creates the shell, the per-display overlays and the gaze host; supervises
 * agency-native, the agent and the coordinator; routes gaze, targets, agent events, Lifeline and Stop.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  globalShortcut,
  ipcMain,
  protocol,
  safeStorage,
  screen,
  session,
  shell as electronShell,
  systemPreferences,
  utilityProcess,
  type Display,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import {
  AGENT_NATIVE_ALLOWED,
  CONTRACTS_VERSION,
  IPC,
  NATIVE_ALLOWED,
  type AgentCommand,
  type AgentEvent,
  type CoordinatorChoice,
  type GazeEvent,
  type HelpSource,
  type HostStatus,
  type LifelineSignal,
  type NativeEvent,
  type NativeMethod,
  type OnboardingState,
  type OverlayDisplay,
  type PermissionKind,
  type PrepareRequest,
  type ProcessName,
  type ProcessState,
  type RealOrderingSetting,
  type ScreenRect,
  type SelectionEvent,
  type StopAllResult,
  type TargetSnapshot,
  type WindowRole,
} from "@agency/contracts";
import { BridgeHost } from "./bridge";
import { BrowserHost } from "./browser/host";
import { browserCall } from "./browser/ipc";
import { CoordinatorClient } from "./coordinator";
import { HomeControl, homeCall } from "./home/control";
import { runShortcuts, writeInputFile } from "./home/shortcuts";
import { LifelineHost, type HeartbeatBody } from "./lifeline";
import { createLogger, setLogDir } from "./log";
import { Messaging, runOsascript } from "./messaging";
import { MouseGaze } from "./mouse-gaze";
import { displayFolder, listPapers, readPaper, saveCopy, validFolder } from "./papers";
import { parseOrdering, readOrdering, writeOrdering } from "./ordering";
import type { Paths } from "./paths";
import { PERMISSION_KINDS, Permissions } from "./permissions";
import { AgentHost, NativeHost, Sidecar } from "./processes";
import { createHandler, SCHEME } from "./protocol";
import { applyPermissionHandlers, applySecurity } from "./security";
import { loadSettings, saveSettings, type AppSettings } from "./settings";
import { stopAll } from "./stop";
import { Supervisor } from "./supervisor";
import { readBundleId, sanitizeTargets, TargetMerger, toGlobal } from "./targets";

const log = createLogger("main");
const SHELL_URL = `${SCHEME}://shell/`;
const ONBOARDING_URL = `${SCHEME}://host/onboarding/index.html`;
const ONBOARDING_STEPS = ["welcome", ...PERMISSION_KINDS, "done"];

export interface AppOptions {
  paths: Paths;
  userData: string;
  logDir: string;
  windowed: boolean;
  test: boolean;
  skipOnboarding: boolean;
  /** Development: load the shell from a Vite dev server instead of agency://shell. */
  shellDevUrl: string | null;
  /** Use an existing coordinator (Pi or dev) instead of the bundled sidecar. */
  coordinatorUrl: string | null;
  coordinatorToken: string | null;
}

interface OverlayWin {
  win: BrowserWindow;
  display: OverlayDisplay;
  interactive: boolean;
  /** Clickable regions in global points, when the overlay manages click-through by regions. */
  regions: ScreenRect[];
}

/** No gaze sample for this long: hand the pointer back to the mouse. */
const GAZE_STALE_MS = 3_000;

export class AgencyApp {
  readonly settingsFile: string;
  settings: AppSettings;
  readonly client = new CoordinatorClient();
  readonly merger = new TargetMerger();
  readonly roles = new Map<number, WindowRole>();
  shell: BrowserWindow | null = null;
  gazeWin: BrowserWindow | null = null;
  readonly overlays = new Map<number, OverlayWin>();
  readonly states: Record<ProcessName, ProcessState> = {
    native: "absent",
    agent: "absent",
    coordinator: "absent",
    gaze: "absent",
  };
  native: NativeHost | null = null;
  agent: AgentHost | null = null;
  sidecar: Sidecar | null = null;
  bridge: BridgeHost | null = null;
  /** AGENCY Browser (main/browser): web pages in the shell, for the person and the assistant. */
  browser: BrowserHost | null = null;
  /** Where the assistant's web tools go for the current task: AGENCY Browser or Chrome (the AGENCY Bridge). */
  webTarget: "agency" | "chrome" = "agency";
  readonly supervisors: Supervisor[] = [];
  lifeline: LifelineHost;
  /** Real texts and calls through the person's iPhone; off until turned on in Settings. */
  messaging: Messaging;
  /** The home by eye: named Apple Shortcuts a helper set up (home/control.ts); off until turned on. */
  home: HomeControl;
  permissions: Permissions;
  mouse: MouseGaze;
  gazeSource: HostStatus["gazeSource"] = "none";
  surfaced = false;
  lastStop: StopAllResult | null = null;
  readonly events: { kind: string; at: number; detail?: unknown }[] = [];
  private lastTracking: { state: string; face: boolean } = { state: "lost", face: false };
  private targetTimer: ReturnType<typeof setTimeout> | null = null;
  private axTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private engineSeenAt = 0;
  private gazeWatch: ReturnType<typeof setInterval> | null = null;
  private readonly selfBundleId = readBundleId(process.execPath, (p) => readFileSync(p, "utf8"));

  constructor(readonly opts: AppOptions) {
    setLogDir(opts.logDir);
    this.settingsFile = join(opts.userData, "settings.json");
    this.settings = loadSettings(this.settingsFile);
    this.lifeline = new LifelineHost({
      client: this.client,
      log: createLogger("lifeline"),
      surface: () => this.surfaceEmergency(),
      heartbeat: () => this.heartbeatBody(),
    });
    this.messaging = new Messaging({
      platform: process.platform,
      settings: () => this.settings.messaging,
      saveSettings: (s) => {
        this.settings.messaging = s;
        saveSettings(this.settingsFile, this.settings);
      },
      // The saved people (Lifeline contacts) come from the coordinator, never from a window.
      lifelineSettings: () => this.client.request("GET", "/api/lifeline/settings"),
      osascript: runOsascript,
      openUrl: (url) => electronShell.openExternal(url),
      logFile: join(opts.userData, "real-sends.jsonl"),
      log: createLogger("messaging"),
    });
    this.home = new HomeControl({
      platform: process.platform,
      file: join(opts.userData, "home.json"),
      run: runShortcuts,
      writeInput: writeInputFile,
      log: createLogger("home"),
    });
    this.permissions = new Permissions({
      platform: process.platform,
      mediaStatus: (kind) =>
        process.platform === "darwin" ? systemPreferences.getMediaAccessStatus(kind) : "granted",
      askMedia: (kind) => systemPreferences.askForMediaAccess(kind),
      accessibilityTrusted: (prompt) =>
        process.platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(prompt) : false,
      nativeStatus: async () =>
        this.native?.rpc.connected && !this.native.fake
          ? this.native.call("permissions.status", {}, 2_000)
          : null,
      nativeRequest: async (kind) =>
        this.native?.rpc.connected && !this.native.fake
          ? this.native.call("permissions.request", { kind }, 60_000)
          : null,
      openUrl: (url) => electronShell.openExternal(url),
    });
    this.mouse = new MouseGaze(
      () => screen.getCursorScreenPoint(),
      (ev) => this.routeGaze(ev),
    );
  }

  private record(kind: string, detail?: unknown): void {
    this.events.push({ kind, at: Date.now(), ...(detail === undefined ? {} : { detail }) });
    if (this.events.length > 500) this.events.shift();
  }

  // ------------------------------------------------------------------------------------------------------
  // Startup

  async start(): Promise<void> {
    const paths = this.opts.paths;
    log.info(`AGENCY ${app.getVersion()} starting (packaged=${paths.packaged}, test=${this.opts.test})`);

    const allowedOrigins = () => [
      "agency://shell",
      "agency://host",
      ...(this.opts.shellDevUrl ? [new URL(this.opts.shellDevUrl).origin] : []),
    ];
    // The shell runs the calibrated eye-tracking pipeline (the same one as the web app) and shares the pointer
    // with the overlay; the hidden engine window only exists with AGENCY_GAZE=engine. Frames stay in the window.
    const mayUseCamera = (c: WebContents) => {
      const role = this.roleOf(c);
      return role === "shell" || role === "gaze";
    };
    applySecurity(app, {
      allowedOrigins,
      mayUseCamera,
      log,
      openExternal: (url) =>
        void electronShell
          .openExternal(url)
          .catch((err: Error) => log.warn(`could not open ${url}: ${err.message}`)),
      isBrowser: (contents) => this.browser?.owns(contents) ?? false,
    });
    applyPermissionHandlers(session.defaultSession, { allowedOrigins, mayUseCamera, log });
    if (process.env.AGENCY_BROWSER !== "0") this.startBrowser();

    protocol.handle(
      SCHEME,
      createHandler(
        () => ({
          shell: paths.shellDir,
          overlay: paths.overlayDir.dir,
          gaze: paths.gazeDir.dir,
          host: paths.hostRenderer,
        }),
        this.client,
      ),
    );
    if (this.opts.shellDevUrl) this.injectDevToken(this.opts.shellDevUrl);

    this.registerIpc();
    this.setupMacChrome();

    // Lifeline-critical pieces first: coordinator, then windows, then the heartbeat.
    const coordinatorReady = this.startCoordinator();
    this.createOverlays();
    screen.on("display-added", () => this.createOverlays());
    screen.on("display-removed", () => this.createOverlays());
    screen.on("display-metrics-changed", () => this.createOverlays());
    this.createShell();
    this.startGaze();
    this.startNative();
    this.startBridge();
    this.registerHotkeys();
    // The agent needs the coordinator's address (memory API); start it once that is known, either way.
    void coordinatorReady.finally(() => this.startAgent());
    await coordinatorReady;
    // Quit while the coordinator was still starting: start nothing more.
    if (this.shuttingDown) return;
    this.lifeline.start();
    this.statusTimer = setInterval(() => void this.pollLifelineStatus(), 5_000);
    log.info("startup complete");
  }

  private shuttingDown = false;

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    globalShortcut.unregisterAll();
    this.lifeline.stop();
    this.mouse.end();
    if (this.axTimer) clearInterval(this.axTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.regionTimer) clearInterval(this.regionTimer);
    if (this.gazeWatch) clearInterval(this.gazeWatch);
    this.browser?.flush();
    await Promise.allSettled([...this.supervisors.map((s) => s.stop()), this.bridge?.stop()]);
  }

  private setState(name: ProcessName, state: ProcessState): void {
    this.states[name] = state;
    this.record("process", { name, state });
  }

  private async startCoordinator(): Promise<void> {
    const remote = this.settings.coordinator;
    if (this.opts.coordinatorUrl) {
      this.client.set({ mode: "external", url: this.opts.coordinatorUrl, token: this.opts.coordinatorToken });
      this.setState("coordinator", (await this.client.healthy()) ? "running" : "failed");
      log.info(`using external coordinator at ${this.opts.coordinatorUrl}`);
      return;
    }
    if (remote.mode === "remote") {
      let token: string | null = null;
      if (remote.tokenEncrypted && safeStorage.isEncryptionAvailable()) {
        token = safeStorage.decryptString(Buffer.from(remote.tokenEncrypted, "base64"));
      }
      this.client.set({ mode: "remote", url: remote.url, token });
      this.setState("coordinator", (await this.client.healthy()) ? "running" : "failed");
      log.info(`using Raspberry Pi coordinator at ${remote.url}`);
      return;
    }
    const spec = this.opts.paths.sidecar;
    if (!spec) {
      log.error("no bundled coordinator found; Lifeline cannot reach a coordinator until one is configured");
      this.setState("coordinator", "absent");
      return;
    }
    const sidecar = new Sidecar(
      { ...spec, dataDir: this.opts.userData, companionDir: this.opts.paths.shellDir },
      this.client,
      createLogger("coordinator"),
    );
    this.sidecar = sidecar;
    const sup = new Supervisor({
      name: "coordinator",
      start: () => sidecar.start(),
      cancelStart: () => sidecar.cancelStart(),
      health: () => sidecar.health(),
      healthIntervalMs: 5_000,
      backoffMs: { initial: 500, max: 10_000 },
      log: createLogger("coordinator"),
      onState: (s) => this.setState("coordinator", s),
    });
    this.supervisors.push(sup);
    await sup.start();
  }

  private startNative(): void {
    const spec = this.opts.paths.native;
    if (!spec) {
      log.warn("agency-native not found: eye control works inside AGENCY only");
      return;
    }
    const nlog = createLogger("native");
    const native = new NativeHost(spec, nlog, (ev) => this.onNativeEvent(ev), {
      ...(process.env.AGENCY_FAKE_NATIVE_LOG
        ? { AGENCY_FAKE_NATIVE_LOG: process.env.AGENCY_FAKE_NATIVE_LOG }
        : {}),
    });
    this.native = native;
    const sup = new Supervisor({
      name: "native",
      start: () => native.start(),
      health: () => native.health().catch(() => false),
      healthIntervalMs: 5_000,
      log: nlog,
      onState: (s) => this.setState("native", s === "running" && native.fake ? "fake" : s),
    });
    this.supervisors.push(sup);
    void sup.start();
    this.axTimer = setInterval(() => void this.refreshAxTargets(), 1_500);
  }

  private startBridge(): void {
    if (process.env.AGENCY_BRIDGE === "0") return;
    const blog = createLogger("bridge");
    const bridge = new BridgeHost({
      dir: join(this.opts.userData, "bridge"),
      hostScript: this.opts.paths.bridgeHost,
      runtime: process.execPath,
      install: !this.opts.test || process.env.AGENCY_BRIDGE_INSTALL === "1",
      log: blog,
      onTargets: (snap) => {
        this.merger.update("web", snap);
        this.scheduleTargets();
      },
      onStopped: () => void this.stopAll("chrome"),
    });
    this.bridge = bridge;
    bridge.start().catch((err: Error) => blog.error(`bridge did not start: ${err.message}`));
  }

  private startBrowser(): void {
    const blog = createLogger("browser");
    try {
      this.browser = new BrowserHost({
        userData: this.opts.userData,
        preload: this.opts.paths.browserPreload,
        log: blog,
        internalOrigins: () => this.internalOrigins(),
        emit: (ev) => {
          if (ev.type !== "state") this.record("browser.event", ev.type);
          this.sendTo(this.shell, IPC.browserEvent, ev);
        },
        downloadsDir: () => app.getPath("downloads"),
        agentSettingsFile: this.agentSettingsFile,
      });
    } catch (err) {
      blog.error(`AGENCY Browser did not start: ${(err as Error).message}`);
      this.browser = null;
    }
  }

  /** AGENCY's own services, which no web page may reach: the coordinator and the development shell. */
  internalOrigins(): string[] {
    const out: string[] = [];
    const add = (url: string | null | undefined) => {
      if (!url) return;
      try {
        out.push(new URL(url).origin);
      } catch {
        // not an address
      }
    };
    add(this.client.current?.url);
    add(this.opts.coordinatorUrl);
    add(this.opts.shellDevUrl);
    return out;
  }

  /**
   * Which browser the assistant's web tools use for the task starting now: AGENCY Browser unless the task (or the
   * helper's setting, with Chrome's bridge connected) says the person's Chrome.
   */
  private chooseWebTarget(selections: Record<string, string>): void {
    const b = this.browser;
    const chromeReady = this.bridge?.connection === "ready";
    if (!b) {
      this.webTarget = "chrome";
      return;
    }
    const wanted = selections.browser;
    const chrome =
      wanted === "chrome" || (wanted !== "agency" && b.settings.agentBrowser === "chrome" && chromeReady);
    this.webTarget = chrome ? "chrome" : "agency";
    this.record("agent.web", this.webTarget);
    if (!chrome) b.startAgentTask(selections.browserTab === "current");
  }

  private startAgent(): void {
    if (this.shuttingDown) return;
    const spec = this.opts.paths.agent;
    if (!spec) {
      log.warn("agent runtime not found");
      return;
    }
    const alog = createLogger("agent");
    const agent = new AgentHost(
      () =>
        utilityProcess.fork(spec.entry, [], {
          serviceName: "AGENCY Agent",
          stdio: "pipe",
          env: {
            ...process.env,
            AGENCY_AGENT_DATA: join(this.opts.userData, "agent"),
            AGENCY_AUDIT_FILE: join(this.opts.userData, "agent-audit.jsonl"),
            AGENCY_AGENT_SETTINGS: this.agentSettingsFile,
            // The agent's web tools: main serves them from AGENCY Browser even when Chrome's bridge is off.
            ...(this.browser ? { AGENCY_BRIDGE: "1" } : {}),
            ...(this.client.current
              ? {
                  AGENCY_COORDINATOR_URL: this.client.current.url,
                  ...(this.client.current.token
                    ? { AGENCY_COORDINATOR_TOKEN: this.client.current.token }
                    : {}),
                }
              : {}),
          },
        }),
      alog,
      (ev) => this.onAgentEvent(ev),
      (target, method, params) => this.agentRpc(target, method, params),
      spec.fake,
    );
    this.agent = agent;
    const sup = new Supervisor({
      name: "agent",
      start: () => agent.start(),
      health: () => agent.health(),
      healthIntervalMs: 5_000,
      log: alog,
      onState: (s) => this.setState("agent", s === "running" && agent.fake ? "fake" : s),
    });
    this.supervisors.push(sup);
    void sup.start();
  }

  private startGaze(): void {
    const mode = process.env.AGENCY_GAZE ?? "shell";
    if (mode === "shell") {
      // Default: the shell's calibrated camera pipeline publishes the pointer (onShellGaze). The mouse works
      // until it does, and again whenever it stops (camera off, eye control paused).
      this.setState("gaze", "starting");
      this.useMouseGaze();
      this.watchGaze();
    } else if (mode === "engine") {
      const win = new BrowserWindow({
        show: false,
        width: 320,
        height: 240,
        webPreferences: this.webPreferences("gaze", { backgroundThrottling: false }),
      });
      this.gazeWin = win;
      this.track(win, "gaze");
      win.webContents.on("did-finish-load", () => this.paceGaze());
      void win.loadURL(`${SCHEME}://gaze/${this.opts.paths.gazeDir.entry}`);
      this.setState("gaze", "starting");
      win.webContents.on("render-process-gone", () => {
        this.setState("gaze", "restarting");
        log.error("gaze engine crashed; using the mouse until it is back");
        this.useMouseGaze();
        setTimeout(
          () => !win.isDestroyed() && void win.loadURL(`${SCHEME}://gaze/${this.opts.paths.gazeDir.entry}`),
          1_000,
        );
      });
      // Until the engine sends its first sample the mouse keeps working, and again whenever it stops publishing.
      this.useMouseGaze();
      this.watchGaze();
    } else {
      this.setState("gaze", "absent");
      this.useMouseGaze();
    }
  }

  /** Real gaze went quiet (camera off, eye control paused, engine stuck): the mouse moves the pointer again. */
  private watchGaze(): void {
    if (this.gazeWatch) return;
    this.gazeWatch = setInterval(() => {
      if (this.gazeSource === "engine" && Date.now() - this.engineSeenAt > GAZE_STALE_MS) {
        log.info("eye tracking stopped publishing; the mouse moves the pointer until it is back");
        this.setState("gaze", "starting");
        this.useMouseGaze();
      }
    }, 1_000);
  }

  private useMouseGaze(): void {
    this.gazeSource = "mouse";
    this.mouse.begin();
  }

  // ------------------------------------------------------------------------------------------------------
  // Windows

  private webPreferences(role: WindowRole, extra: Electron.WebPreferences = {}): Electron.WebPreferences {
    return {
      preload: this.opts.paths.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      additionalArguments: [`--agency-role=${role}`],
      ...extra,
    };
  }

  private track(win: BrowserWindow, role: WindowRole): void {
    const id = win.webContents.id;
    this.roles.set(id, role);
    win.on("closed", () => this.roles.delete(id));
  }

  roleOf(contents: WebContents | null | undefined): WindowRole | null {
    return contents ? (this.roles.get(contents.id) ?? null) : null;
  }

  shellUrl(): string {
    if (this.opts.shellDevUrl) return this.opts.shellDevUrl;
    return this.opts.paths.shellDir ? SHELL_URL : `${SCHEME}://host/shell-missing/index.html`;
  }

  /**
   * The shell tracks the eyes itself with its own camera pipeline. While it's in front (and showing the interface,
   * not onboarding), the hidden gaze window (which serves the overlay over other apps) idles instead of running a
   * second full face tracker on the same camera; it goes back to full rate as soon as another app is in front or the
   * shell window closes. The engine never goes below its own floor (10 fps), where Lifeline's three long blinks are
   * still resolved, whatever is asked here.
   */
  paceGaze(): void {
    const shell = this.shell;
    const shellTracking =
      !!shell && !shell.isDestroyed() && shell.isFocused() && this.roleOf(shell.webContents) === "shell";
    this.sendTo(this.gazeWin, IPC.gazePace, gazePaceFps(shellTracking));
  }

  /** @param forceShell load the interface even if onboarding isn't finished (the emergency screen needs it). */
  private createShell(forceShell = false): BrowserWindow {
    const win = new BrowserWindow({
      title: "AGENCY",
      show: false,
      fullscreen: !this.opts.windowed,
      width: 1440,
      height: 900,
      // macOS: an inset title bar over a vibrant window background; the interface's own background sits on top.
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset" as const,
            trafficLightPosition: { x: 20, y: 22 },
            vibrancy: "under-window" as const,
            visualEffectState: "active" as const,
            backgroundColor: "#00000000",
          }
        : { backgroundColor: "#f7f5f0" }),
      // Not throttled in the background: it keeps tracking the eyes while another app is in front.
      webPreferences: this.webPreferences("shell", { backgroundThrottling: false }),
    });
    this.shell = win;
    this.track(win, "shell");
    win.once("ready-to-show", () => win.show());
    win.on("focus", () => {
      this.scheduleTargets();
      this.paceGaze();
    });
    win.on("blur", () => {
      this.scheduleTargets();
      this.paceGaze();
    });
    win.on("closed", () => {
      if (this.shell === win) this.shell = null;
      // A closed shell tracks nothing: the gaze window must not stay slowed down for it.
      this.paceGaze();
      this.scheduleTargets();
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      log.error(`shell renderer gone (${details.reason}); reloading`);
      setTimeout(() => !win.isDestroyed() && void win.loadURL(this.shellUrl()), 500);
    });
    const onboarding = !forceShell && !this.settings.onboarding.done && !this.opts.skipOnboarding;
    void win.loadURL(onboarding ? ONBOARDING_URL : this.shellUrl());
    return win;
  }

  /** The shell window, shown and focused; recreated if the person closed it (AGENCY is their home). */
  showShell(): BrowserWindow {
    let win = this.shell;
    if (!win || win.isDestroyed()) win = this.createShell();
    if (win.isMinimized()) win.restore();
    win.show();
    if (process.platform === "darwin") app.focus({ steal: true });
    win.focus();
    return win;
  }

  /** Sends to one window, if it is still there. A closed or crashed window never breaks the caller. */
  private sendTo(win: BrowserWindow | null | undefined, channel: string, payload: unknown): void {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      log.warn(`${channel}: could not reach a window: ${(err as Error).message}`);
    }
  }

  private toOverlays(channel: string, payload: unknown): void {
    for (const o of this.overlays.values()) this.sendTo(o.win, channel, payload);
  }

  createOverlays(): void {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay().id;
    const wanted = new Set(displays.map((d) => d.id));
    for (const [id, o] of this.overlays) {
      if (!wanted.has(id)) {
        o.win.destroy();
        this.overlays.delete(id);
      }
    }
    for (const d of displays) {
      const existing = this.overlays.get(d.id);
      const display = toOverlayDisplay(d, primary);
      if (existing) {
        existing.display = display;
        existing.win.setBounds(d.bounds);
        continue;
      }
      this.overlays.set(d.id, { win: this.createOverlay(display), display, interactive: false, regions: [] });
    }
  }

  private createOverlay(display: OverlayDisplay): BrowserWindow {
    const { x, y, width, height } = display.bounds;
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      show: false,
      transparent: true,
      backgroundColor: "#00000000",
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      roundedCorners: false,
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: this.webPreferences("overlay", { backgroundThrottling: false }),
    });
    this.track(win, "overlay");
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setContentProtection(false);
    win.webContents.on("render-process-gone", () => {
      log.error(`overlay on display ${display.id} crashed; reloading`);
      setTimeout(
        () => !win.isDestroyed() && void win.loadURL(overlayUrl(display, this.opts.paths.overlayDir.entry)),
        300,
      );
    });
    void win.loadURL(overlayUrl(display, this.opts.paths.overlayDir.entry));
    win.once("ready-to-show", () => win.showInactive());
    return win;
  }

  // ------------------------------------------------------------------------------------------------------
  // Mac chrome: dock icon in development, the app menu, About

  private about: BrowserWindow | null = null;

  showAbout(): void {
    if (this.about && !this.about.isDestroyed()) {
      this.about.show();
      return;
    }
    const win = new BrowserWindow({
      title: "About AGENCY",
      width: 420,
      height: 470,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset" as const,
            vibrancy: "under-window" as const,
            visualEffectState: "active" as const,
            backgroundColor: "#00000000",
          }
        : {}),
      webPreferences: this.webPreferences("about"),
    });
    this.about = win;
    const q = new URLSearchParams({ v: app.getVersion(), b: process.env.AGENCY_BUILD ?? "" });
    void win.loadURL(`${SCHEME}://host/about/index.html?${q}`);
    win.once("ready-to-show", () => win.show());
  }

  private setupMacChrome(): void {
    if (process.platform !== "darwin") return;
    if (!this.opts.paths.packaged) {
      const icon = join(this.opts.paths.appDir, "build", "icon.png");
      if (existsSync(icon)) app.dock?.setIcon(icon);
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "AGENCY",
          submenu: [
            { label: "About AGENCY", click: () => this.showAbout() },
            { type: "separator" },
            {
              label: "Stop everything",
              accelerator: this.settings.stopHotkey || undefined,
              click: () => void this.stopAll("menu"),
            },
            { label: "Call for help", click: () => void this.help("help_button") },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { role: "editMenu" },
        { role: "windowMenu" },
      ]),
    );
  }

  // ------------------------------------------------------------------------------------------------------
  // Lifeline and Stop

  surfaceEmergency(): void {
    this.surfaced = true;
    this.record("lifeline.surface");
    const signal = { type: "lifeline.surface" } satisfies LifelineSignal;
    // The person closed the shell: open it again, straight onto the interface (never onboarding), and raise it the
    // same way as an open one.
    const existing = this.shell;
    const fresh = !existing || existing.isDestroyed();
    const win = !existing || existing.isDestroyed() ? this.createShell(true) : existing;
    if (win.isMinimized()) win.restore();
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setAlwaysOnTop(true, "pop-up-menu");
    win.show();
    win.moveTop();
    if (process.platform === "darwin") app.focus({ steal: true });
    win.focus();
    // Onboarding or a missing interface must not hide the emergency screen.
    const loading = fresh || !win.webContents.getURL().startsWith(this.shellUrl());
    if (loading) {
      if (!fresh) void win.loadURL(this.shellUrl());
      // A page that is still loading can't hear the signal yet: tell it again once it has loaded.
      win.webContents.once("did-finish-load", () => this.sendTo(win, IPC.lifeline, signal));
    }
    // No web page may sit in front of the emergency screen, whatever the shell last asked for.
    this.browser?.setEmergency(true);
    this.sendTo(win, IPC.lifeline, signal);
    this.toOverlays(IPC.lifeline, signal);
  }

  private releaseSurface(): void {
    if (!this.surfaced) return;
    this.surfaced = false;
    const win = this.shell;
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(false);
      win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
    }
    this.browser?.setEmergency(false);
    this.record("lifeline.release");
  }

  private async pollLifelineStatus(): Promise<void> {
    if (!this.surfaced || this.lifeline.helpPending) return;
    try {
      const status = await this.client.request<{ alert?: unknown; open_alert?: unknown }>(
        "GET",
        "/api/lifeline/status",
      );
      if (!status.alert && !status.open_alert) this.releaseSurface();
    } catch {
      // Keep the emergency screen up while we can't tell.
    }
  }

  help(source: HelpSource, test = false) {
    this.record("lifeline.help", { source, test });
    return this.lifeline.help(source, test);
  }

  private stopping: Promise<StopAllResult> | null = null;

  /** Requests that arrive while a Stop is in progress join it, so a window answering the broadcast can't loop. */
  stopAll(origin: string): Promise<StopAllResult> {
    this.record("stop.request", { origin });
    if (this.stopping) return this.stopping;
    this.stopping = this.runStop().finally(() => setTimeout(() => (this.stopping = null), 300));
    return this.stopping;
  }

  private async runStop(): Promise<StopAllResult> {
    // No real text or call goes out after Stop, even one already approved and waiting.
    this.messaging.cancelAll();
    // A shortcut still running for the home is aborted.
    this.home.stopAll();
    // The assistant does nothing more in AGENCY Browser until the person starts a new task.
    this.browser?.stopAgent();
    const result = await stopAll(
      {
        agent: () => {
          this.bridge?.stopAll();
          return this.agent?.send({ type: "stop.all" }) ?? false;
        },
        native: () =>
          this.native?.rpc.connected ? this.native.call("input.stopAll", {}, 1_000).then((r) => r.ok) : null,
        notify: (r) => {
          this.sendTo(this.shell, IPC.stopAll, r);
          this.toOverlays(IPC.stopAll, r);
        },
      },
      log,
    );
    this.lastStop = result;
    this.record("stop.done", result);
    return result;
  }

  private registerHotkeys(): void {
    const stop = this.settings.stopHotkey;
    if (stop && !globalShortcut.register(stop, () => void this.stopAll("hotkey")))
      log.warn(`could not register Stop hotkey ${stop}`);
    const help = this.settings.helpHotkey;
    if (help && !globalShortcut.register(help, () => void this.help("switch")))
      log.warn(`could not register Help hotkey ${help}`);
  }

  private heartbeatBody(): HeartbeatBody {
    const engine = this.gazeSource === "engine";
    return {
      // The eye help signal only works while the camera engine is tracking a face.
      signal_ready: engine && this.lastTracking.state !== "lost" && this.lastTracking.face,
      camera: engine ? (this.lastTracking.state === "lost" ? "lost" : "on") : "off",
      face_visible: engine && this.lastTracking.face,
      page_visible: Boolean(this.shell && !this.shell.isDestroyed() && this.shell.isVisible()),
      input_mode: this.gazeSource === "mouse" ? "pointer" : "gaze",
    };
  }

  // ------------------------------------------------------------------------------------------------------
  // Routing

  routeGaze(ev: GazeEvent): void {
    if (ev.type === "tracking") this.lastTracking = { ...this.lastTracking, state: ev.state };
    if (ev.type === "blink") this.lastTracking = { ...this.lastTracking, face: ev.face };
    if (ev.type === "help-signal") void this.help("eye_signal");
    this.toOverlays(IPC.gaze, ev);
    this.sendTo(this.shell, IPC.gaze, ev);
  }

  /**
   * Gaze from the shell's calibrated pipeline. Rects arrive in the shell's client coordinates (CSS pixels); the
   * overlay needs global screen points. Only samples and tracking are taken: the shell raises its own Lifeline
   * help signal through the coordinator, so it isn't sent twice.
   */
  private onShellGaze(sender: WebContents, ev: GazeEvent): void {
    if (ev.type !== "sample" && ev.type !== "tracking") return;
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win.isDestroyed()) return;
    if (ev.type === "sample") {
      const s = ev.sample;
      if (![s.x, s.y, s.t, s.confidence].every((n) => Number.isFinite(n))) return;
      const b = win.getContentBounds();
      const zoom = sender.getZoomFactor();
      const global: GazeEvent = {
        type: "sample",
        sample: { ...s, x: b.x + s.x * zoom, y: b.y + s.y * zoom, source: "webcam-gaze" },
      };
      this.takeEngine();
      this.lastTracking.face = true;
      this.toOverlays(IPC.gaze, global);
      return;
    }
    this.lastTracking = { ...this.lastTracking, state: ev.state, face: ev.state !== "lost" };
    this.toOverlays(IPC.gaze, ev);
  }

  /** Real gaze is arriving: the mouse stops standing in for it. */
  private takeEngine(): void {
    this.engineSeenAt = Date.now();
    if (this.gazeSource !== "engine") {
      this.gazeSource = "engine";
      this.mouse.end();
      this.setState("gaze", "running");
      log.info("eye tracking is publishing; mouse fallback off");
    }
  }

  private onEngineEvent(ev: GazeEvent): void {
    // Only real samples replace the mouse: an uncalibrated engine sends tracking and blinks but no pointer.
    if (ev.type === "sample") {
      this.takeEngine();
      this.lastTracking.face = true;
    } else if (ev.type === "tracking") {
      this.lastTracking.face = ev.state !== "lost";
    }
    this.routeGaze(ev);
  }

  private onAgentEvent(ev: AgentEvent): void {
    this.record("agent.event", ev.type);
    if (ev.type === "task.done" || ev.type === "task.failed" || ev.type === "task.stopped")
      this.browser?.agentEnded();
    this.sendTo(this.shell, IPC.agentEvent, ev);
    this.toOverlays(IPC.agentEvent, ev);
  }

  private onNativeEvent(ev: NativeEvent): void {
    if (ev.type === "targets-changed" || ev.type === "frontmost-changed") void this.refreshAxTargets();
    this.sendTo(this.shell, IPC.nativeEvent, ev);
    this.toOverlays(IPC.nativeEvent, ev);
  }

  private shellFrontmost(): boolean {
    return Boolean(this.shell && !this.shell.isDestroyed() && this.shell.isFocused());
  }

  private async refreshAxTargets(): Promise<void> {
    if (!this.native?.rpc.connected) return;
    if (this.shellFrontmost()) {
      // Don't keep another app's (or our own) old targets around while AGENCY is in front.
      this.merger.clear("ax");
      this.scheduleTargets();
      return;
    }
    try {
      const snap = await this.native.call("ax.targets", { maxCount: 300, includeWeb: true }, 1_000);
      this.merger.update("ax", snap);
      this.scheduleTargets();
    } catch {
      // Accessibility not granted yet, or the app is busy: keep the last snapshot.
    }
  }

  private scheduleTargets(): void {
    if (this.targetTimer) return;
    this.targetTimer = setTimeout(() => {
      this.targetTimer = null;
      const snap: TargetSnapshot = this.merger.merged(Date.now(), this.shellFrontmost(), this.selfBundleId);
      this.toOverlays(IPC.targets, snap);
    }, 50);
  }

  /** Calls from the agent: allowlisted native methods; the AGENCY Bridge once Instance 5 connects it. */
  private agentRpc(target: "native" | "bridge", method: string, params: unknown): Promise<unknown> {
    if (target === "native") {
      if (!AGENT_NATIVE_ALLOWED.includes(method as NativeMethod)) {
        return Promise.reject(new Error(`${method} is not available to the agent.`));
      }
      return this.callNative(method as NativeMethod, params);
    }
    // The same tools, served by AGENCY Browser or by the person's Chrome, as chosen when the task started.
    if (this.webTarget === "agency" && this.browser) return this.browser.agentCall(method, params);
    if (!this.bridge) return Promise.reject(new Error("The AGENCY Bridge is not connected."));
    return this.bridge.agentCall(method, params);
  }

  private callNative(method: NativeMethod, params: unknown): Promise<unknown> {
    if (!this.native?.rpc.connected) return Promise.reject(new Error("agency-native is not running"));
    return this.native.rpc.call(method, params as never);
  }

  // ------------------------------------------------------------------------------------------------------
  // IPC (every handler checks the sender's role)

  private requireRole(e: IpcMainEvent | IpcMainInvokeEvent, allowed: WindowRole[]): WindowRole {
    const role = this.roleOf(e.sender);
    if (!role || !allowed.includes(role)) {
      throw new Error(`not allowed from ${role ?? "unknown window"}`);
    }
    return role;
  }

  private registerIpc(): void {
    const on = (channel: string, roles: WindowRole[], fn: (e: IpcMainEvent, ...args: unknown[]) => void) =>
      ipcMain.on(channel, (e, ...args) => {
        try {
          this.requireRole(e, roles);
          fn(e, ...args);
        } catch (err) {
          log.warn(`${channel}: ${(err as Error).message}`);
        }
      });
    const handle = (
      channel: string,
      roles: WindowRole[] | "any",
      fn: (e: IpcMainInvokeEvent, role: WindowRole, ...args: unknown[]) => unknown,
    ) =>
      ipcMain.handle(channel, (e, ...args) => {
        const role = this.requireRole(
          e,
          roles === "any" ? ["shell", "overlay", "gaze", "onboarding"] : roles,
        );
        return fn(e, role, ...args);
      });

    ipcMain.on("agency:role", (e) => {
      e.returnValue = this.roleOf(e.sender);
    });

    on(IPC.gaze, ["gaze", "shell"], (e, ev) => {
      if (!ev || typeof ev !== "object") return;
      if (this.roleOf(e.sender) === "shell") this.onShellGaze(e.sender, ev as GazeEvent);
      else this.onEngineEvent(ev as GazeEvent);
    });

    on(IPC.shellTargets, ["shell"], (e, targets) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) return;
      const b = win.getContentBounds();
      this.merger.update("shell", {
        t: Date.now(),
        owner: "agency.shell",
        targets: toGlobal(sanitizeTargets(targets), b, e.sender.getZoomFactor()),
        truncated: false,
      });
      this.scheduleTargets();
    });

    handle(IPC.native, "any", async (_e, role, method, params) => {
      const m = method as NativeMethod;
      if (!NATIVE_ALLOWED[role].includes(m)) throw new Error(`${role} may not call ${String(method)}`);
      return this.callNative(m, params ?? {});
    });

    on(IPC.agentCommand, ["shell", "overlay"], (_e, command) => {
      const cmd = command as AgentCommand;
      if (cmd.type === "stop.all") {
        void this.stopAll("renderer");
        return;
      }
      // The person started a task: Chrome may act again after an earlier Stop (only for a task the agent will run).
      if (cmd.type === "task.start" && this.agent?.running) {
        this.bridge?.newTask();
        this.chooseWebTarget(cmd.request.selections ?? {});
      }
      if (!this.agent?.send(cmd)) log.warn(`agent not running; dropped ${cmd.type}`);
    });

    handle(IPC.lifeline, "any", (_e, _role, signal) => {
      const s = signal as LifelineSignal;
      if (s.type === "lifeline.help") return this.help(s.source, Boolean(s.test));
      this.surfaceEmergency();
      return null;
    });

    handle(IPC.stopAll, "any", (_e, role) => this.stopAll(role));

    on(IPC.overlayInteractive, ["overlay"], (e, interactive) => {
      for (const o of this.overlays.values()) {
        if (o.win.webContents.id !== e.sender.id) continue;
        o.interactive = interactive === true;
        o.win.setIgnoreMouseEvents(!o.interactive, { forward: true });
      }
    });

    on(IPC.overlayRegions, ["overlay"], (e, rects) => {
      for (const o of this.overlays.values()) {
        if (o.win.webContents.id !== e.sender.id) continue;
        o.regions = sanitizeRects(rects);
      }
      this.updateRegionWatch();
    });

    on(IPC.showHome, ["shell", "overlay"], () => this.showHome());

    handle(IPC.memory, ["shell", "overlay"], (_e, _role, op, arg) => this.memory(String(op), arg));

    // Real texts and calls: the shell only. Main resolves numbers and checks every rule itself (messaging.ts).
    handle(IPC.messaging, ["shell"], (_e, _role, op, arg) => this.messagingCall(String(op), arg));
    handle(IPC.papers, ["shell"], (_e, _role, op, ...args) => this.papers(String(op), args));
    // The home: the shell only, and only the devices a helper saved (home/control.ts checks every run).
    handle(IPC.home, ["shell"], (_e, _role, op, ...args) => homeCall(this.home, String(op), args));
    // AGENCY Browser: the shell only. Pages reach main only through their preload, checked by the browser host.
    handle(IPC.browser, ["shell"], (e, _role, op, ...args) => {
      if (!this.browser) throw new Error("AGENCY Browser is off.");
      return browserCall(this.browser, e.sender, String(op), args);
    });
    ipcMain.on(IPC.pageReply, (e, msg) => this.browser?.onPageMessage(e, "reply", msg));
    ipcMain.on(IPC.pageEvent, (e, msg) => this.browser?.onPageMessage(e, "event", msg));

    handle(IPC.overlayDisplay, ["overlay"], (e) => {
      for (const o of this.overlays.values()) if (o.win.webContents.id === e.sender.id) return o.display;
      return null;
    });

    handle(IPC.permissions, ["shell", "onboarding"], (_e, _role, op, kind) => {
      const k = kind as PermissionKind;
      if (op === "status") return this.permissions.status();
      if (!PERMISSION_KINDS.includes(k)) throw new Error("unknown permission");
      if (op === "request") return this.permissions.request(k);
      if (op === "openSettings") return this.permissions.openSettings(k);
      throw new Error("unknown operation");
    });

    handle(IPC.host, "any", (_e, role, op, arg) => {
      if (op === "status") return this.status();
      if (op === "onboarding") return this.onboardingState();
      if (op === "setCoordinator" && role === "shell") return this.setCoordinator(arg as CoordinatorChoice);
      if (op === "completeOnboardingStep" && (role === "onboarding" || role === "shell"))
        return this.completeStep(String(arg));
      if (op === "realOrdering") return readOrdering(this.agentSettingsFile);
      if (op === "setRealOrdering" && role === "shell") return this.setRealOrdering(arg);
      throw new Error("unknown operation");
    });

    // The onboarding page runs in the shell window; give it its own role while it is loaded.
    app.on("web-contents-created", (_e, contents) => {
      contents.on("did-navigate", (_ev, url) => {
        const role = this.roles.get(contents.id);
        if (role === "shell" || role === "onboarding") {
          this.roles.set(contents.id, url.startsWith(ONBOARDING_URL) ? "onboarding" : "shell");
          this.paceGaze();
        }
      });
    });
  }

  // ------------------------------------------------------------------------------------------------------
  // Overlay click-through by regions, Home, memory

  private regionTimer: ReturnType<typeof setInterval> | null = null;

  private updateRegionWatch(): void {
    const any = [...this.overlays.values()].some((o) => o.regions.length > 0);
    if (any && !this.regionTimer) this.regionTimer = setInterval(() => this.checkRegions(), 33);
    if (!any && this.regionTimer) {
      clearInterval(this.regionTimer);
      this.regionTimer = null;
    }
  }

  private checkRegions(): void {
    const p = screen.getCursorScreenPoint();
    for (const o of this.overlays.values()) {
      if (o.regions.length === 0 || o.win.isDestroyed()) continue;
      const inside = o.regions.some(
        (r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height,
      );
      if (inside !== o.interactive) {
        o.interactive = inside;
        o.win.setIgnoreMouseEvents(!inside, { forward: true });
      }
    }
  }

  showHome(): void {
    // Home must always be reachable, even after the person closed the AGENCY window.
    const win = this.showShell();
    this.sendTo(win, IPC.showHome, null);
    this.record("home");
  }

  messagingCall(op: string, arg: unknown): Promise<unknown> {
    const a = (arg ?? {}) as Record<string, unknown>;
    if (op === "status") return this.messaging.status();
    if (op === "setSettings") return this.messaging.setSettings(a as Partial<AppSettings["messaging"]>);
    if (op === "check") return this.messaging.check();
    if (op === "prepare") return this.messaging.prepare(a as unknown as PrepareRequest);
    if (op === "send") return this.messaging.send(String(a.ticket ?? ""), String(a.fingerprint ?? ""));
    if (op === "cancel") {
      this.messaging.cancel(String(a.ticket ?? ""));
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error("unknown messaging operation"));
  }

  /** Papers: only the folder a helper chose, through the checks in papers.ts. */
  private async papers(op: string, args: unknown[]): Promise<unknown> {
    const home = app.getPath("home");
    const current = this.settings.papersFolder;
    const describe = (folder: string | null) => (folder ? { display: displayFolder(folder, home) } : null);
    if (op === "folder") return describe(current);
    if (op === "clearFolder") {
      this.settings.papersFolder = null;
      saveSettings(this.settingsFile, this.settings);
      return null;
    }
    if (op === "chooseFolder") {
      let folder: string | null = null;
      if (args[0] === "papers") {
        folder = join(app.getPath("documents"), "AGENCY Papers");
        await mkdir(folder, { recursive: true });
      } else if (args[0] === "downloads") folder = app.getPath("downloads");
      else if (args[0] === "pick") {
        const options = {
          title: "Choose the folder for Papers",
          buttonLabel: "Use this folder",
          properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
        };
        const r = this.shell
          ? await dialog.showOpenDialog(this.shell, options)
          : await dialog.showOpenDialog(options);
        if (r.canceled || !r.filePaths[0]) return describe(current);
        folder = r.filePaths[0];
      } else throw new Error("unknown folder choice");
      if (!(await validFolder(folder, home)))
        throw new Error(
          "AGENCY can't use that folder for Papers. Choose a folder of documents, not the whole disk or home folder.",
        );
      this.settings.papersFolder = folder;
      saveSettings(this.settingsFile, this.settings);
      this.record("papers-folder");
      return describe(folder);
    }
    if (!current) throw new Error("No Papers folder is set up yet. A helper can choose one in Settings.");
    if (op === "list") return listPapers(current);
    if (op === "read") return readPaper(current, String(args[0] ?? ""));
    if (op === "saveCopy") {
      const raw = args[2];
      const bytes =
        raw instanceof Uint8Array ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : raw;
      const saved = await saveCopy(current, String(args[0] ?? ""), args[1], bytes);
      this.record("papers-saved", { name: saved.name });
      return saved;
    }
    throw new Error("unknown operation");
  }

  private async memory(op: string, arg: unknown): Promise<unknown> {
    const a = (arg ?? {}) as Record<string, unknown>;
    if (op === "suggestions") {
      const surface = String(a.surface ?? "home").replace(/[^a-z]/g, "");
      const limit = Math.max(1, Math.min(20, Number(a.limit ?? 6) || 6));
      return this.client.request("GET", `/api/memory/suggestions?surface=${surface}&limit=${limit}`);
    }
    if (op === "usual") {
      return this.client.request("GET", `/api/memory/usual?path=${encodeURIComponent(String(a.path ?? ""))}`);
    }
    if (op === "event") {
      const ev = arg as SelectionEvent;
      if (!Array.isArray(ev?.path) || ev.path.some((p) => typeof p !== "string"))
        throw new Error("bad event");
      await this.client.request("POST", "/api/memory/events", ev);
      return undefined;
    }
    throw new Error("unknown memory operation");
  }

  // ------------------------------------------------------------------------------------------------------
  // Status and onboarding

  status(): HostStatus {
    const ep = this.client.current;
    return {
      version: app.getVersion(),
      contractsVersion: CONTRACTS_VERSION,
      platform: process.platform,
      processes: { ...this.states },
      coordinator: {
        mode: ep?.mode ?? "bundled",
        url: ep?.url ?? null,
        reachable: this.states.coordinator === "running",
      },
      lifeline: this.lifeline.heartbeatStatus,
      gazeSource: this.gazeSource,
    };
  }

  onboardingState(): OnboardingState {
    return {
      completedSteps: [...this.settings.onboarding.completedSteps],
      done: this.settings.onboarding.done,
    };
  }

  /** The agent's caregiver limits (os/agent settingsFromFile): main writes it, the agent only reads it. */
  get agentSettingsFile(): string {
    return join(this.opts.userData, "agent-settings.json");
  }

  /** Settings' "Order for real": checked here, then written for the agent (it re-reads it on every check). */
  setRealOrdering(value: unknown): { ok: boolean; error?: string; setting?: RealOrderingSetting } {
    const setting = parseOrdering(value);
    if (!setting) return { ok: false, error: "That isn't a valid setting (the limit must be $5 to $500)." };
    try {
      writeOrdering(this.agentSettingsFile, setting);
    } catch (err) {
      log.error(`could not save ordering setting: ${(err as Error).message}`);
      return { ok: false, error: "The setting couldn't be saved." };
    }
    log.info(`ordering for real ${setting.enabled ? "on" : "off"}, limit $${setting.maxOrder.toFixed(2)}`);
    this.record("ordering.set", setting.enabled ? "on" : "off");
    return { ok: true, setting };
  }

  completeStep(step: string): OnboardingState {
    if (!ONBOARDING_STEPS.includes(step)) throw new Error("unknown step");
    const ob = this.settings.onboarding;
    if (!ob.completedSteps.includes(step)) ob.completedSteps.push(step);
    if (step === "done") {
      ob.done = true;
      saveSettings(this.settingsFile, this.settings);
      if (this.shell && !this.shell.isDestroyed()) void this.shell.loadURL(this.shellUrl());
    } else {
      saveSettings(this.settingsFile, this.settings);
    }
    return this.onboardingState();
  }

  async setCoordinator(choice: CoordinatorChoice): Promise<{ ok: boolean; error?: string }> {
    if (choice.mode === "bundled") {
      this.settings.coordinator = { mode: "bundled" };
    } else {
      let url: URL;
      try {
        url = new URL(choice.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
      } catch {
        return { ok: false, error: "That address doesn't look right. It should start with http://" };
      }
      const probe = new CoordinatorClient();
      probe.set({ mode: "remote", url: url.origin, token: choice.token || null });
      try {
        await probe.request("GET", "/api/lifeline/status", undefined, 5_000);
      } catch (err) {
        return {
          ok: false,
          error: `Couldn't reach the coordinator at ${url.origin} (${(err as Error).message}).`,
        };
      }
      if (choice.token && !safeStorage.isEncryptionAvailable()) {
        return { ok: false, error: "This Mac can't store the access token safely." };
      }
      this.settings.coordinator = {
        mode: "remote",
        url: url.origin,
        tokenEncrypted: choice.token ? safeStorage.encryptString(choice.token).toString("base64") : null,
      };
    }
    saveSettings(this.settingsFile, this.settings);
    log.info(`coordinator set to ${this.settings.coordinator.mode}; restarting`);
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 500);
    return { ok: true };
  }

  /** Development: the Vite dev server forwards /api to the coordinator; add the token on the way. */
  private injectDevToken(devUrl: string): void {
    const origin = new URL(devUrl).origin;
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: [`${origin}/api/*`, `${origin}/respond*`] },
      (details, cb) => {
        const token = this.client.current?.token;
        cb({
          requestHeaders: token
            ? { ...details.requestHeaders, "X-Agency-Token": token }
            : details.requestHeaders,
        });
      },
    );
  }

  /** For tests: when did the engine last publish? */
  get engineLastSeen(): number {
    return this.engineSeenAt;
  }
}

function sanitizeRects(input: unknown): ScreenRect[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 64)
    .filter(
      (r): r is ScreenRect =>
        Boolean(r) &&
        [r.x, r.y, r.width, r.height].every((n: unknown) => typeof n === "number" && Number.isFinite(n)),
    )
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
}

/** Frames a second for the hidden gaze engine: slowed while the shell tracks the eyes itself, full rate otherwise. */
export function gazePaceFps(shellTracking: boolean): number {
  return shellTracking ? 10 : 30;
}

function toOverlayDisplay(d: Display, primary: number): OverlayDisplay {
  return { id: d.id, bounds: { ...d.bounds }, scaleFactor: d.scaleFactor, primary: d.id === primary };
}

function overlayUrl(d: OverlayDisplay, entry: string): string {
  const q = new URLSearchParams({
    display: String(d.id),
    x: String(d.bounds.x),
    y: String(d.bounds.y),
    w: String(d.bounds.width),
    h: String(d.bounds.height),
    scale: String(d.scaleFactor),
  });
  return `${SCHEME}://overlay/${entry}?${q}`;
}
