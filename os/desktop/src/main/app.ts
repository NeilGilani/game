/**
 * AGENCY.app main process: creates the shell, the per-display overlays and the gaze host; supervises
 * agency-native, the agent and the coordinator; routes gaze, targets, agent events, Lifeline and Stop.
 */

import { join } from "node:path";
import {
  BrowserWindow,
  app,
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
  type ProcessName,
  type ProcessState,
  type ScreenRect,
  type SelectionEvent,
  type StopAllResult,
  type TargetSnapshot,
  type WindowRole,
} from "@agency/contracts";
import { CoordinatorClient } from "./coordinator";
import { LifelineHost, type HeartbeatBody } from "./lifeline";
import { createLogger, setLogDir } from "./log";
import { MouseGaze } from "./mouse-gaze";
import type { Paths } from "./paths";
import { PERMISSION_KINDS, Permissions } from "./permissions";
import { AgentHost, NativeHost, Sidecar } from "./processes";
import { createHandler, SCHEME } from "./protocol";
import { applyPermissionHandlers, applySecurity } from "./security";
import { loadSettings, saveSettings, type AppSettings } from "./settings";
import { stopAll } from "./stop";
import { Supervisor } from "./supervisor";
import { sanitizeTargets, TargetMerger, toGlobal } from "./targets";

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
  readonly supervisors: Supervisor[] = [];
  lifeline: LifelineHost;
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
    applySecurity(app, { allowedOrigins, isGaze: (c) => this.roleOf(c) === "gaze", log });
    applyPermissionHandlers(session.defaultSession, {
      allowedOrigins,
      isGaze: (c) => this.roleOf(c) === "gaze",
      log,
    });

    protocol.handle(
      SCHEME,
      createHandler(
        () => ({
          shell: paths.shellDir,
          overlay: paths.overlayDir.dir,
          gaze: paths.gazeDir,
          host: paths.hostRenderer,
        }),
        this.client,
      ),
    );
    if (this.opts.shellDevUrl) this.injectDevToken(this.opts.shellDevUrl);

    this.registerIpc();

    // Lifeline-critical pieces first: coordinator, then windows, then the heartbeat.
    const coordinatorReady = this.startCoordinator();
    this.createOverlays();
    screen.on("display-added", () => this.createOverlays());
    screen.on("display-removed", () => this.createOverlays());
    screen.on("display-metrics-changed", () => this.createOverlays());
    this.createShell();
    this.startGaze();
    this.startNative();
    this.registerHotkeys();
    // The agent needs the coordinator's address (memory API); start it once that is known, either way.
    void coordinatorReady.finally(() => this.startAgent());
    await coordinatorReady;
    this.lifeline.start();
    this.statusTimer = setInterval(() => void this.pollLifelineStatus(), 5_000);
    log.info("startup complete");
  }

  async shutdown(): Promise<void> {
    globalShortcut.unregisterAll();
    this.lifeline.stop();
    this.mouse.end();
    if (this.axTimer) clearInterval(this.axTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.regionTimer) clearInterval(this.regionTimer);
    await Promise.allSettled(this.supervisors.map((s) => s.stop()));
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
      { ...spec, dataDir: this.opts.userData },
      this.client,
      createLogger("coordinator"),
    );
    this.sidecar = sidecar;
    const sup = new Supervisor({
      name: "coordinator",
      start: () => sidecar.start(),
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

  private startAgent(): void {
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
            AGENCY_AGENT_SETTINGS: join(this.opts.userData, "agent-settings.json"),
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
    const dir = this.opts.paths.gazeDir;
    if (dir && process.env.AGENCY_GAZE !== "mouse") {
      const win = new BrowserWindow({
        show: false,
        width: 320,
        height: 240,
        webPreferences: this.webPreferences("gaze", { backgroundThrottling: false }),
      });
      this.gazeWin = win;
      this.track(win, "gaze");
      void win.loadURL(`${SCHEME}://gaze/engine.html`);
      this.setState("gaze", "starting");
      win.webContents.on("render-process-gone", () => {
        this.setState("gaze", "restarting");
        log.error("gaze engine crashed; using the mouse until it is back");
        this.useMouseGaze();
        setTimeout(() => !win.isDestroyed() && void win.loadURL(`${SCHEME}://gaze/engine.html`), 1_000);
      });
      // Until the engine sends its first event, the mouse keeps working.
      this.useMouseGaze();
    } else {
      this.setState("gaze", "absent");
      this.useMouseGaze();
    }
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

  private createShell(): void {
    const win = new BrowserWindow({
      title: "AGENCY",
      show: false,
      fullscreen: !this.opts.windowed,
      width: 1440,
      height: 900,
      backgroundColor: "#f7f5f0",
      webPreferences: this.webPreferences("shell"),
    });
    this.shell = win;
    this.track(win, "shell");
    win.once("ready-to-show", () => win.show());
    win.on("focus", () => this.scheduleTargets());
    win.on("blur", () => this.scheduleTargets());
    win.webContents.on("render-process-gone", (_e, details) => {
      log.error(`shell renderer gone (${details.reason}); reloading`);
      setTimeout(() => !win.isDestroyed() && void win.loadURL(this.shellUrl()), 500);
    });
    const onboarding = !this.settings.onboarding.done && !this.opts.skipOnboarding;
    void win.loadURL(onboarding ? ONBOARDING_URL : this.shellUrl());
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
  // Lifeline and Stop

  surfaceEmergency(): void {
    this.surfaced = true;
    this.record("lifeline.surface");
    const win = this.shell;
    if (!win || win.isDestroyed()) {
      this.createShell();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setAlwaysOnTop(true, "pop-up-menu");
    win.show();
    win.moveTop();
    if (process.platform === "darwin") app.focus({ steal: true });
    win.focus();
    // Onboarding or a missing interface must not hide the emergency screen.
    const url = win.webContents.getURL();
    if (!url.startsWith(this.shellUrl())) void win.loadURL(this.shellUrl());
    win.webContents.send(IPC.lifeline, { type: "lifeline.surface" } satisfies LifelineSignal);
    for (const o of this.overlays.values())
      o.win.webContents.send(IPC.lifeline, { type: "lifeline.surface" } satisfies LifelineSignal);
  }

  private releaseSurface(): void {
    if (!this.surfaced) return;
    this.surfaced = false;
    const win = this.shell;
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(false);
      win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
    }
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

  async stopAll(origin: string): Promise<StopAllResult> {
    this.record("stop.request", { origin });
    const result = await stopAll(
      {
        agent: () => this.agent?.send({ type: "stop.all" }) ?? false,
        native: () =>
          this.native?.rpc.connected ? this.native.call("input.stopAll", {}, 1_000).then((r) => r.ok) : null,
        notify: (r) => {
          this.shell?.webContents.send(IPC.stopAll, r);
          for (const o of this.overlays.values()) o.win.webContents.send(IPC.stopAll, r);
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
    for (const o of this.overlays.values()) if (!o.win.isDestroyed()) o.win.webContents.send(IPC.gaze, ev);
    if (this.shell && !this.shell.isDestroyed()) this.shell.webContents.send(IPC.gaze, ev);
  }

  private onEngineEvent(ev: GazeEvent): void {
    if (this.gazeSource !== "engine") {
      this.gazeSource = "engine";
      this.mouse.end();
      this.setState("gaze", "running");
      log.info("gaze engine is publishing; mouse fallback off");
    }
    this.engineSeenAt = Date.now();
    if (ev.type === "sample" || ev.type === "tracking")
      this.lastTracking.face = ev.type === "sample" ? true : ev.state !== "lost";
    this.routeGaze(ev);
  }

  private onAgentEvent(ev: AgentEvent): void {
    this.record("agent.event", ev.type);
    this.shell?.webContents.send(IPC.agentEvent, ev);
    for (const o of this.overlays.values()) o.win.webContents.send(IPC.agentEvent, ev);
  }

  private onNativeEvent(ev: NativeEvent): void {
    if (ev.type === "targets-changed" || ev.type === "frontmost-changed") void this.refreshAxTargets();
    this.shell?.webContents.send(IPC.nativeEvent, ev);
    for (const o of this.overlays.values()) o.win.webContents.send(IPC.nativeEvent, ev);
  }

  private shellFrontmost(): boolean {
    return Boolean(this.shell && !this.shell.isDestroyed() && this.shell.isFocused());
  }

  private async refreshAxTargets(): Promise<void> {
    if (!this.native?.rpc.connected || this.shellFrontmost()) return;
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
      const snap: TargetSnapshot = this.merger.merged(Date.now(), this.shellFrontmost());
      for (const o of this.overlays.values())
        if (!o.win.isDestroyed()) o.win.webContents.send(IPC.targets, snap);
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
    return Promise.reject(new Error("The AGENCY Bridge is not connected."));
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

    on(IPC.gaze, ["gaze"], (_e, ev) => this.onEngineEvent(ev as GazeEvent));

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
      if (cmd.type === "stop.all") void this.stopAll("renderer");
      else if (!this.agent?.send(cmd)) log.warn(`agent not running; dropped ${cmd.type}`);
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
      throw new Error("unknown operation");
    });

    // The onboarding page runs in the shell window; give it its own role while it is loaded.
    app.on("web-contents-created", (_e, contents) => {
      contents.on("did-navigate", (_ev, url) => {
        const role = this.roles.get(contents.id);
        if (role === "shell" || role === "onboarding")
          this.roles.set(contents.id, url.startsWith(ONBOARDING_URL) ? "onboarding" : "shell");
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
    const win = this.shell;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    if (process.platform === "darwin") app.focus({ steal: true });
    win.focus();
    win.webContents.send(IPC.showHome, null);
    this.record("home");
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
