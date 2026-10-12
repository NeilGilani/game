/**
 * AgencyApp's window handling with a stand-in for Electron: Help and Home stay reachable after the person closes the
 * AGENCY window, a closed or crashed window never breaks Stop, and the hidden gaze engine is only slowed while the
 * shell is really tracking the eyes.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@agency/contracts";

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  private readonly listeners = new Map<string, Listener[]>();
  on(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  once(event: string, fn: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }
  off(event: string, fn: Listener): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((l) => l !== fn),
    );
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(...args);
  }
}

let nextId = 1;
const handlers = new Map<string, (...args: unknown[]) => unknown>();

class FakeContents extends FakeEmitter {
  readonly id = nextId++;
  url = "";
  destroyed = false;
  sendThrows = false;
  readonly sent: { channel: string; payload: unknown }[] = [];
  send(channel: string, payload: unknown): void {
    if (this.destroyed || this.sendThrows) throw new Error("Object has been destroyed");
    this.sent.push({ channel, payload });
  }
  getURL(): string {
    return this.url;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getZoomFactor(): number {
    return 1;
  }
}

class FakeWindow extends FakeEmitter {
  static all: FakeWindow[] = [];
  readonly webContents = new FakeContents();
  destroyed = false;
  focused = false;
  visible = false;
  onTop = false;
  readonly loads: string[] = [];
  constructor(readonly options: Record<string, unknown>) {
    super();
    FakeWindow.all.push(this);
  }
  async loadURL(url: string): Promise<void> {
    this.loads.push(url);
    this.webContents.url = url;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isFocused(): boolean {
    return this.focused;
  }
  isMinimized(): boolean {
    return false;
  }
  isVisible(): boolean {
    return this.visible;
  }
  restore(): void {}
  show(): void {
    this.visible = true;
  }
  showInactive(): void {
    this.visible = true;
  }
  focus(): void {
    this.focused = true;
  }
  moveTop(): void {}
  setAlwaysOnTop(on: boolean): void {
    this.onTop = on;
  }
  setVisibleOnAllWorkspaces(): void {}
  setIgnoreMouseEvents(): void {}
  setContentProtection(): void {}
  setBounds(): void {}
  /** The person closes the window. */
  close(): void {
    this.focused = false;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }
  static fromWebContents(c: FakeContents): FakeWindow | null {
    return FakeWindow.all.find((w) => w.webContents === c) ?? null;
  }
}

vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
  app: { on: () => {}, focus: () => {}, getVersion: () => "0.0.0-test", dock: undefined },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  ipcMain: {
    on: () => {},
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  protocol: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
  screen: {
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({ id: 1 }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    on: () => {},
  },
  session: { defaultSession: {} },
  shell: { openExternal: async () => {} },
  systemPreferences: {},
  utilityProcess: { fork: () => null },
}));

const { AgencyApp, gazePaceFps } = await import("../src/main/app");

function makeApp(onboardingDone = true) {
  const dir = mkdtempSync(join(tmpdir(), "agency-app-test-"));
  const agency = new AgencyApp({
    paths: {
      packaged: false,
      appDir: dir,
      repoDir: null,
      resourcesDir: dir,
      preload: join(dir, "preload.cjs"),
      browserPreload: join(dir, "browser-preload.cjs"),
      hostRenderer: dir,
      shellDir: dir,
      overlayDir: { dir, entry: "overlay/index.html", builtin: true },
      gazeDir: { dir, entry: "gaze/engine.html" },
      agent: null,
      native: null,
      sidecar: null,
      bridgeHost: null,
    },
    userData: dir,
    logDir: join(dir, "logs"),
    windowed: true,
    test: true,
    skipOnboarding: false,
    shellDevUrl: null,
    coordinatorUrl: null,
    coordinatorToken: null,
  });
  agency.settings.onboarding.done = onboardingDone;
  return agency;
}

function shellOf(agency: InstanceType<typeof AgencyApp>): FakeWindow {
  return agency.shell as unknown as FakeWindow;
}

beforeEach(() => {
  FakeWindow.all = [];
  process.env.AGENCY_LOG_ECHO = "0";
});

describe("the AGENCY window comes back for Help and Home", () => {
  it("Help reopens a closed shell on the interface (not onboarding), on top, and tells it once loaded", () => {
    const agency = makeApp(false);
    agency.showShell();
    const first = shellOf(agency);
    expect(first.loads[0]).toContain("onboarding");
    first.close();
    expect(agency.shell).toBeNull();

    agency.surfaceEmergency();
    const again = shellOf(agency);
    expect(again).not.toBe(first);
    expect(again.loads).toEqual(["agency://shell/"]);
    expect(again.onTop).toBe(true);
    expect(again.visible).toBe(true);
    // The signal is repeated after the page loads, so a page that wasn't listening yet still hears it.
    again.webContents.emit("did-finish-load");
    expect(again.webContents.sent.filter((m) => m.channel === IPC.lifeline)).toHaveLength(2);
    expect(agency.surfaced).toBe(true);
  });

  it("Help over onboarding switches to the interface and repeats the signal after the load", () => {
    const agency = makeApp(false);
    const win = agency.showShell() as unknown as FakeWindow;
    agency.surfaceEmergency();
    expect(win.loads).toEqual([expect.stringContaining("onboarding"), "agency://shell/"]);
    const before = win.webContents.sent.length;
    win.webContents.emit("did-finish-load");
    expect(win.webContents.sent.slice(before)).toEqual([
      { channel: IPC.lifeline, payload: { type: "lifeline.surface" } },
    ]);
  });

  it("Home reopens a closed shell instead of doing nothing", () => {
    const agency = makeApp();
    agency.showShell();
    shellOf(agency).close();
    agency.showHome();
    const win = shellOf(agency);
    expect(win.isDestroyed()).toBe(false);
    expect(win.visible).toBe(true);
    expect(win.webContents.sent).toContainEqual({ channel: IPC.showHome, payload: null });
  });
});

describe("a closed or broken window never breaks Stop", () => {
  it("still tells the overlays and reports the result when the shell can't be reached", async () => {
    const agency = makeApp();
    agency.showShell();
    shellOf(agency).webContents.sendThrows = true;
    const overlay = new FakeWindow({});
    agency.overlays.set(7, {
      win: overlay as never,
      display: { id: 7, bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1, primary: true },
      interactive: false,
      regions: [],
    });
    const result = await agency.stopAll("test");
    expect(result).toMatchObject({ agent: "unavailable", native: "unavailable" });
    expect(overlay.webContents.sent).toEqual([{ channel: IPC.stopAll, payload: result }]);
  });

  it("routes agent events past a closed shell", () => {
    const agency = makeApp();
    agency.showShell();
    shellOf(agency).close();
    const overlay = new FakeWindow({});
    overlay.close();
    agency.overlays.set(8, {
      win: overlay as never,
      display: { id: 8, bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1, primary: true },
      interactive: false,
      regions: [],
    });
    expect(() =>
      (agency as unknown as { onAgentEvent(e: unknown): void }).onAgentEvent({
        type: "task.started",
        taskId: "t",
        goal: "g",
        dryRun: true,
      }),
    ).not.toThrow();
  });
});

describe("pacing the hidden gaze engine", () => {
  function withGaze(agency: InstanceType<typeof AgencyApp>): FakeWindow {
    const gaze = new FakeWindow({});
    agency.gazeWin = gaze as never;
    return gaze;
  }
  const paces = (w: FakeWindow) =>
    w.webContents.sent.filter((m) => m.channel === IPC.gazePace).map((m) => m.payload);

  it("slows it only while the shell is focused on the interface, never below Lifeline's floor", () => {
    expect(gazePaceFps(true)).toBeGreaterThanOrEqual(10);
    expect(gazePaceFps(false)).toBe(30);
    const agency = makeApp();
    const gaze = withGaze(agency);
    const shell = agency.showShell() as unknown as FakeWindow;
    agency.roles.set(shell.webContents.id, "shell");
    agency.paceGaze();
    shell.focused = false;
    agency.paceGaze();
    expect(paces(gaze)).toEqual([10, 30]);
  });

  it("goes back to full rate when the shell window closes, and isn't slowed for onboarding", () => {
    const agency = makeApp();
    const gaze = withGaze(agency);
    const shell = agency.showShell() as unknown as FakeWindow;
    agency.roles.set(shell.webContents.id, "onboarding");
    agency.paceGaze();
    agency.roles.set(shell.webContents.id, "shell");
    agency.paceGaze();
    shell.close();
    expect(paces(gaze)).toEqual([30, 10, 30]);
  });
});

describe("real texts and calls over IPC", () => {
  it("only the shell may use them, and Stop forgets every waiting approval", async () => {
    const agency = makeApp();
    (agency as unknown as { registerIpc(): void }).registerIpc();
    const handler = handlers.get(IPC.messaging)!;
    const overlay = new FakeContents();
    agency.roles.set(overlay.id, "overlay");
    expect(() => handler({ sender: overlay }, "status")).toThrow(/not allowed/);
    const shell = new FakeContents();
    agency.roles.set(shell.id, "shell");
    const status = (await handler({ sender: shell }, "status")) as { settings: { enabled: boolean } };
    expect(status.settings.enabled).toBe(false);
    agency.messaging.cancelAll = vi.fn(agency.messaging.cancelAll.bind(agency.messaging));
    await agency.stopAll("test");
    expect(agency.messaging.cancelAll).toHaveBeenCalled();
  });
});
