/**
 * The home over IPC: only the shell may use it, it starts switched off, and Stop aborts a running shortcut.
 * Electron is stood in for; the rules themselves are in home.test.ts.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IPC } from "@agency/contracts";

const home = mkdtempSync(join(tmpdir(), "agency-home-ipc-"));
mkdirSync(join(home, "Documents"));
mkdirSync(join(home, "Downloads"));
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
const picked: { path: string | null } = { path: null };

vi.mock("electron", () => ({
  BrowserWindow: class {},
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
  app: {
    on: () => {},
    focus: () => {},
    getVersion: () => "0.0.0-test",
    dock: undefined,
    getPath: (name: string) =>
      name === "home" ? home : name === "documents" ? join(home, "Documents") : join(home, "Downloads"),
  },
  dialog: {
    showOpenDialog: async () =>
      picked.path ? { canceled: false, filePaths: [picked.path] } : { canceled: true, filePaths: [] },
  },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  ipcMain: {
    on: () => {},
    handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  protocol: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }), on: () => {} },
  session: { defaultSession: {} },
  shell: { openExternal: async () => {} },
  systemPreferences: {},
  utilityProcess: { fork: () => null },
}));

const { AgencyApp } = await import("../src/main/app");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agency-home-app-"));
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
    skipOnboarding: true,
    shellDevUrl: null,
    coordinatorUrl: null,
    coordinatorToken: null,
  });
  (agency as unknown as { registerIpc(): void }).registerIpc();
  agency.roles.set(1, "shell");
  agency.roles.set(2, "overlay");
  const call = (sender: number, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(IPC.home)!({ sender: { id: sender } }, ...args));
  return { agency, call };
}

describe("Home IPC", () => {
  it("is for the shell only, and starts switched off with no devices", async () => {
    const { call } = setup();
    await expect(call(2, "status")).rejects.toThrow(/not allowed from overlay/);
    const status = (await call(1, "status")) as { setup: { enabled: boolean; devices: unknown[] } };
    expect(status.setup).toEqual({ enabled: false, devices: [] });
    expect(await call(1, "run", "lamp", "on", false)).toMatchObject({ ok: false });
    await expect(call(1, "spawn", "sh")).rejects.toThrow(/unknown home operation/);
  });

  it("Stop aborts a shortcut that is still running", async () => {
    const { agency } = setup();
    let aborted = false;
    (agency.home as unknown as { running: AbortController | null }).running = {
      abort: () => (aborted = true),
    } as unknown as AbortController;
    await agency.stopAll("test");
    expect(aborted).toBe(true);
  });
});
