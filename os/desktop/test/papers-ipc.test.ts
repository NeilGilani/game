/**
 * Papers over IPC: only the shell may use it, only after a helper chose a folder, and the shell can only name files
 * inside that folder. Electron is stood in for; the file checks themselves are in papers.test.ts.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IPC } from "@agency/contracts";

const home = mkdtempSync(join(tmpdir(), "agency-papers-home-"));
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
  const dir = mkdtempSync(join(tmpdir(), "agency-papers-app-"));
  const agency = new AgencyApp({
    paths: {
      packaged: false,
      appDir: dir,
      repoDir: null,
      resourcesDir: dir,
      preload: join(dir, "preload.cjs"),
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
    Promise.resolve().then(() => handlers.get(IPC.papers)!({ sender: { id: sender } }, ...args));
  return { agency, call };
}

describe("Papers IPC", () => {
  it("is for the shell only, and does nothing until a helper chooses a folder", async () => {
    const { call } = setup();
    await expect(call(2, "list")).rejects.toThrow(/not allowed from overlay/);
    await expect(call(1, "list")).rejects.toThrow(/No Papers folder/);
    expect(await call(1, "folder")).toBeNull();
  });

  it("uses only the chosen folder, and saves new copies there", async () => {
    const { agency, call } = setup();
    expect(await call(1, "chooseFolder", "papers")).toEqual({ display: "~/Documents/AGENCY Papers" });
    const folder = join(home, "Documents", "AGENCY Papers");
    expect(agency.settings.papersFolder).toBe(folder);
    const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
    writeFileSync(join(folder, "Letter.pdf"), pdf);
    writeFileSync(join(home, "Documents", "Elsewhere.pdf"), pdf);
    expect((await call(1, "list")) as { name: string }[]).toMatchObject([
      { name: "Letter.pdf", kind: "pdf" },
    ]);
    expect(await call(1, "read", "Letter.pdf")).toEqual(pdf);
    await expect(call(1, "read", "../Elsewhere.pdf")).rejects.toThrow();
    await expect(call(1, "read", join(home, "Documents", "Elsewhere.pdf"))).rejects.toThrow();
    expect(await call(1, "saveCopy", "Letter.pdf", "signed", pdf)).toEqual({ name: "Letter-signed.pdf" });
    expect(readFileSync(join(folder, "Letter-signed.pdf"))).toEqual(Buffer.from(pdf));
  });

  it("refuses the whole home folder, keeps the folder when the dialog is cancelled, and can be cleared", async () => {
    const { agency, call } = setup();
    await call(1, "chooseFolder", "downloads");
    picked.path = home;
    await expect(call(1, "chooseFolder", "pick")).rejects.toThrow(/can't use that folder/);
    picked.path = null;
    expect(await call(1, "chooseFolder", "pick")).toEqual({ display: "~/Downloads" });
    await expect(call(1, "chooseFolder", "/etc")).rejects.toThrow(/unknown folder choice/);
    await call(1, "clearFolder");
    expect(agency.settings.papersFolder).toBeNull();
  });
});
