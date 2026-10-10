import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GazeEvent, PermissionStatus, Target } from "@agency/contracts";
import { NATIVE_ALLOWED } from "@agency/contracts";
import { CoordinatorClient } from "../src/main/coordinator";
import { MouseGaze } from "../src/main/mouse-gaze";
import { resolvePaths } from "../src/main/paths";
import { Permissions, SETTINGS_PANES, mapMediaStatus } from "../src/main/permissions";
import { CSP, createHandler, safeJoin } from "../src/main/protocol";
import { decidePermission, isAllowedNavigation } from "../src/main/security";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../src/main/settings";
import { SHELL_OWNER, TargetMerger, overlapRatio, readBundleId, sanitizeTargets, toGlobal } from "../src/main/targets";
import { DwellTracker, hitTest } from "../src/renderer/shared/dwell";

const t = (id: string, x: number, y: number, w = 100, h = 100, extra: Partial<Target> = {}): Target => ({
  id,
  rect: { x, y, width: w, height: h },
  role: "button",
  label: id,
  source: "ax",
  ...extra,
});

describe("security", () => {
  it("grants the camera only to eye-tracking windows (shell, gaze), video only", () => {
    expect(decidePermission("media", true, ["video"])).toBe(true);
    expect(decidePermission("media", true, ["video", "audio"])).toBe(false);
    expect(decidePermission("media", true, ["audio"])).toBe(false);
    expect(decidePermission("media", true, [])).toBe(false);
    expect(decidePermission("media", false, ["video"])).toBe(false);
    expect(decidePermission("geolocation", true, undefined)).toBe(false);
    expect(decidePermission("notifications", false, undefined)).toBe(false);
  });

  it("allows navigation only within AGENCY origins", () => {
    const allowed = ["agency://shell", "agency://host"];
    expect(isAllowedNavigation("agency://shell/cases/1", allowed)).toBe(true);
    expect(isAllowedNavigation("agency://overlay/index.html", allowed)).toBe(false);
    expect(isAllowedNavigation("https://evil.example/", allowed)).toBe(false);
    expect(isAllowedNavigation("file:///etc/passwd", allowed)).toBe(false);
    expect(isAllowedNavigation("not a url", allowed)).toBe(false);
  });

  it("CSP forbids remote scripts, plugins and framing everywhere", () => {
    for (const csp of Object.values(CSP)) {
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/[^-]unsafe-eval/);
    }
    expect(CSP.host).toContain("connect-src 'none'");
  });

  it("only the overlay and shell may call a small set of native methods; nobody may capture the screen", () => {
    for (const methods of Object.values(NATIVE_ALLOWED)) expect(methods).not.toContain("screen.capture");
    expect(NATIVE_ALLOWED.gaze).toEqual([]);
    expect(NATIVE_ALLOWED.shell).not.toContain("input.type");
  });
});

describe("protocol", () => {
  it("refuses paths that escape the root", () => {
    expect(safeJoin("/app/shell", "/index.html")).toBe("/app/shell/index.html");
    expect(safeJoin("/app/shell", "/../secret")).toBeNull();
    expect(safeJoin("/app/shell", "/%2e%2e/secret")).toBeNull();
    expect(safeJoin("/app/shell", "/a/%00b")).toBeNull();
    expect(safeJoin("/app/shell", "/%E0%A4%A")).toBeNull();
  });

  it("serves files with CSP, falls back to index.html for the SPA, and proxies /api with the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-proto-"));
    writeFileSync(join(dir, "index.html"), "<p>shell</p>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "a.js"), "1");
    const seen: { url: string; token: string | null }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, token: new Headers(init?.headers).get("X-Agency-Token") });
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const client = new CoordinatorClient();
      client.set({ mode: "bundled", url: "http://127.0.0.1:5555", token: "tok" });
      const handler = createHandler(() => ({ shell: dir, overlay: dir, gaze: null, host: dir }), client);
      const res = await handler(new Request("agency://shell/"));
      expect(await res.text()).toBe("<p>shell</p>");
      expect(res.headers.get("Content-Security-Policy")).toBe(CSP.shell);
      expect((await handler(new Request("agency://shell/cases/123"))).status).toBe(200);
      expect((await handler(new Request("agency://shell/assets/missing.js"))).status).toBe(404);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect((await handler(new Request("agency://gaze/engine.html"))).status).toBe(404);
      expect((await handler(new Request("agency://other/x"))).status).toBe(404);
      const api = await handler(new Request("agency://shell/api/lifeline/status?x=1"));
      expect(api.status).toBe(200);
      expect(seen[0]).toEqual({ url: "http://127.0.0.1:5555/api/lifeline/status?x=1", token: "tok" });
      // The overlay can't reach the coordinator through the protocol.
      expect((await handler(new Request("agency://overlay/api/lifeline/help"))).status).toBe(404);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("targets", () => {
  it("prefers web targets over overlapping accessibility targets", () => {
    const m = new TargetMerger();
    m.update("ax", {
      t: 0,
      owner: "com.google.Chrome",
      truncated: false,
      targets: [t("ax1", 0, 0), t("ax2", 500, 500)],
    });
    m.update("web", {
      t: 0,
      owner: "https://shop.example",
      truncated: false,
      targets: [t("w1", 5, 5, 90, 90, { source: "web" })],
    });
    const merged = m.merged(1, false);
    expect(merged.targets.map((x) => x.id)).toEqual(["w1", "ax2"]);
    expect(merged.owner).toBe("com.google.Chrome");
  });

  it("uses only the shell's targets while the shell is frontmost", () => {
    const m = new TargetMerger();
    m.update("ax", { t: 0, owner: "x", truncated: true, targets: [t("ax1", 0, 0)] });
    m.update("shell", {
      t: 0,
      owner: "agency.shell",
      truncated: false,
      targets: [t("home", 0, 0, 200, 200, { source: "shell" })],
    });
    const merged = m.merged(1, true);
    expect(merged.targets.map((x) => x.id)).toEqual(["home"]);
    expect(merged.truncated).toBe(false);
  });

  it("never shows AGENCY's own window as an accessibility pile while the shell is in front", () => {
    // The bug: the shell published nothing, so its Electron accessibility tree ("Unlabelled row") was used.
    const m = new TargetMerger();
    m.update("ax", { t: 0, owner: "com.github.Electron", truncated: false, targets: [t("row1", 0, 0), t("row2", 0, 120)] });
    const merged = m.merged(1, true, "com.github.Electron");
    expect(merged.targets).toEqual([]);
    expect(merged.owner).toBe(SHELL_OWNER);
  });

  it("ignores accessibility snapshots of AGENCY's own windows even when the shell isn't focused", () => {
    const m = new TargetMerger();
    m.update("ax", { t: 0, owner: "com.agency.app", truncated: true, targets: [t("row1", 0, 0)] });
    const merged = m.merged(1, false, "com.agency.app");
    expect(merged.targets).toEqual([]);
    expect(merged.truncated).toBe(false);
    m.update("ax", { t: 1, owner: "com.apple.finder", truncated: false, targets: [t("open", 0, 0)] });
    expect(m.merged(2, false, "com.agency.app").targets.map((x) => x.id)).toEqual(["open"]);
  });

  it("reads the app's bundle id from its Info.plist", () => {
    const plist = "<dict><key>CFBundleIdentifier</key>\n\t<string>com.github.Electron</string></dict>";
    const read = (p: string) => {
      expect(p).toBe("/x/Electron.app/Contents/Info.plist");
      return plist;
    };
    expect(readBundleId("/x/Electron.app/Contents/MacOS/Electron", read)).toBe("com.github.Electron");
    expect(readBundleId("/usr/bin/electron", read)).toBeNull();
    expect(
      readBundleId("/x/A.app/Contents/MacOS/A", () => {
        throw new Error("missing");
      }),
    ).toBeNull();
  });

  it("converts shell client coordinates to global points", () => {
    const [g] = toGlobal([t("a", 10, 20, 100, 50)], { x: 1440, y: 25 }, 1.25);
    expect(g!.rect).toEqual({ x: 1452.5, y: 50, width: 125, height: 62.5 });
    expect(g!.source).toBe("shell");
  });

  it("sanitizes untrusted target input", () => {
    const out = sanitizeTargets([
      {
        id: "ok",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        role: "button",
        label: "OK",
        dwellScale: 99,
        protected: true,
        source: "web",
      },
      { id: "bad", rect: { x: Number.NaN, y: 0, width: 10, height: 10 } },
      { id: "zero", rect: { x: 0, y: 0, width: 0, height: 10 } },
      "nope",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "ok", source: "shell", protected: true });
    expect(out[0]).not.toHaveProperty("dwellScale");
    expect(sanitizeTargets("x")).toEqual([]);
    expect(
      overlapRatio({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }),
    ).toBeCloseTo(0.25);
  });
});

describe("dwell", () => {
  const sample = (tms: number, x: number, y: number, confidence = 1) => ({
    t: tms,
    x,
    y,
    confidence,
    fixation: true,
    source: "mouse" as const,
  });

  it("selects after the dwell time, once, and protected targets win ties", () => {
    const d = new DwellTracker({ dwellMs: 1000 });
    const targets = [t("a", 0, 0), t("help", 0, 0, 100, 100, { protected: true })];
    expect(hitTest(50, 50, targets)?.id).toBe("help");
    expect(d.update(sample(0, 50, 50), targets).selected).toBeNull();
    expect(d.update(sample(500, 50, 50), targets).progress).toBeCloseTo(0.5);
    expect(d.update(sample(1000, 50, 50), targets).selected?.id).toBe("help");
    expect(d.update(sample(3000, 50, 50), targets).selected).toBeNull();
  });

  it("never dwells below 0.5 confidence and honours dwellScale", () => {
    const d = new DwellTracker({ dwellMs: 1000 });
    const targets = [t("cancel", 0, 0, 100, 100, { dwellScale: 2 })];
    d.update(sample(0, 50, 50), targets);
    expect(d.update(sample(1500, 50, 50, 0.3), targets).selected).toBeNull();
    d.update(sample(1600, 50, 50), targets);
    expect(d.update(sample(2600, 50, 50), targets).selected).toBeNull();
    expect(d.update(sample(3600, 50, 50), targets).selected?.id).toBe("cancel");
  });
});

describe("mouse gaze", () => {
  it("emits samples in global points with source mouse", () => {
    const events: GazeEvent[] = [];
    let p = { x: 10, y: 20 };
    const m = new MouseGaze(
      () => p,
      (e) => events.push(e),
    );
    m.tick();
    p = { x: 200, y: 20 };
    m.tick();
    const samples = events.filter((e) => e.type === "sample");
    expect(samples).toHaveLength(2);
    expect(samples[1]).toMatchObject({
      sample: { x: 200, y: 20, source: "mouse", confidence: 1, fixation: false },
    });
  });
});

describe("permissions", () => {
  const granted: PermissionStatus = {
    camera: "granted",
    accessibility: "granted",
    "screen-recording": "granted",
    microphone: "granted",
    "speech-recognition": "granted",
  };

  it("maps macOS states and opens the right pane when denied", async () => {
    expect(mapMediaStatus("restricted")).toBe("denied");
    expect(mapMediaStatus("unknown")).toBe("not-determined");
    const opened: string[] = [];
    const asked: string[] = [];
    const p = new Permissions({
      platform: "darwin",
      mediaStatus: (k) => (k === "camera" ? "denied" : "not-determined"),
      askMedia: async (k) => (asked.push(k), true),
      accessibilityTrusted: () => false,
      nativeStatus: async () => ({
        ...granted,
        accessibility: "denied",
        "speech-recognition": "not-determined",
      }),
      nativeRequest: async () => null,
      openUrl: async (u) => void opened.push(u),
    });
    const status = await p.status();
    expect(status).toMatchObject({ camera: "denied", microphone: "not-determined", accessibility: "denied" });
    await p.request("camera");
    expect(opened).toEqual([SETTINGS_PANES.camera]);
    await p.request("microphone");
    expect(asked).toEqual(["microphone"]);
    await p.request("speech-recognition");
    expect(opened).toContain(SETTINGS_PANES["speech-recognition"]);
  });

  it("does not pretend outside macOS", async () => {
    const p = new Permissions({
      platform: "linux",
      mediaStatus: () => "granted",
      askMedia: async () => true,
      accessibilityTrusted: () => true,
      nativeStatus: async () => granted,
      nativeRequest: async () => granted,
      openUrl: async () => undefined,
    });
    expect(Object.values(await p.status()).every((s) => s === "not-determined")).toBe(true);
  });
});

describe("settings and paths", () => {
  it("round-trips settings and survives a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-settings-"));
    const file = join(dir, "settings.json");
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
    saveSettings(file, { ...DEFAULT_SETTINGS, onboarding: { completedSteps: ["welcome"], done: false } });
    expect(loadSettings(file).onboarding.completedSteps).toEqual(["welcome"]);
    writeFileSync(file, "{oops");
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to fakes in development and never in a packaged app", () => {
    const dev = resolvePaths({
      packaged: false,
      appDir: "/repo/os/desktop",
      resourcesDir: "/nope",
      execPath: "/electron",
    });
    expect(dev.native).toMatchObject({ fake: true, command: "/electron" });
    expect(dev.agent).toMatchObject({ fake: true });
    expect(dev.overlayDir.builtin).toBe(true);
    const packaged = resolvePaths({
      packaged: true,
      appDir: "/A.app/Contents/Resources/app.asar",
      resourcesDir: "/A.app/Contents/Resources",
      execPath: "/x",
    });
    expect(packaged.native).toBeNull();
    expect(packaged.agent).toBeNull();
    expect(packaged.sidecar).toBeNull();
  });
});
