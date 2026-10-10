/**
 * Smoke tests for AGENCY.app with Playwright's Electron support. The real coordinator runs as the sidecar (from
 * backend/.venv); agency-native and the agent are the fakes in os/desktop/fakes, which log what they receive.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const desktop = resolve(__dirname, "..");
const repo = resolve(desktop, "..", "..");

interface Ctx {
  app: ElectronApplication;
  dir: string;
  nativeLog: string;
  agentLog: string;
}

async function launch(extraEnv: Record<string, string> = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), "agency-e2e-"));
  const nativeLog = join(dir, "native.jsonl");
  const agentLog = join(dir, "agent.jsonl");
  const app = await electron.launch({
    args: [desktop],
    cwd: desktop,
    env: {
      ...process.env,
      AGENCY_TEST: "1",
      AGENCY_USER_DATA: join(dir, "userdata"),
      AGENCY_SKIP_ONBOARDING: "1",
      AGENCY_NATIVE_PATH: join(desktop, "fakes", "fake-native.cjs"),
      AGENCY_AGENT_ENTRY: join(desktop, "fakes", "fake-agent.cjs"),
      AGENCY_FAKE_NATIVE_LOG: nativeLog,
      AGENCY_FAKE_AGENT_LOG: agentLog,
      AGENCY_LOG_ECHO: "0",
      AGENCY_GAZE: "mouse",
      // These tests cover the host and its built-in overlay; packages.spec.ts covers os/overlay.
      AGENCY_OVERLAY_BUILTIN: "1",
      ...extraEnv,
    },
  });
  return { app, dir, nativeLog, agentLog };
}

function jsonl(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => w.url().includes(part)), { timeout: 30_000 }).toBe(true);
  return app.windows().find((w) => w.url().includes(part))!;
}

async function processesReady(app: ElectronApplication): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(() => {
          const a = (globalThis as unknown as { __agency: { states: Record<string, string> } }).__agency;
          return `${a.states.coordinator}/${a.states.native}/${a.states.agent}`;
        }),
      { timeout: 60_000 },
    )
    .toBe("running/fake/fake");
}

test.describe("AGENCY.app", () => {
  let ctx: Ctx;

  test.beforeAll(async () => {
    test.skip(
      !existsSync(join(repo, "backend", ".venv", "bin", "python")),
      "needs backend/.venv (make setup-backend)",
    );
    ctx = await launch();
    await processesReady(ctx.app);
  });

  test.afterAll(async () => {
    await ctx?.app.close();
  });

  test("starts, renders the shell and supervises every process", async () => {
    const shell = await windowByUrl(ctx.app, "agency://shell/");
    await expect(shell.locator("#root")).not.toBeEmpty();
    expect(await shell.title()).not.toBe("");
    const status = await shell.evaluate(() => window.agency.host.status());
    expect(status.processes).toMatchObject({ coordinator: "running", native: "fake", agent: "fake" });
    expect(status.coordinator.mode).toBe("bundled");
    expect(status.coordinator.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // The shell reaches the coordinator through agency://shell/api with the token added by main.
    const health = await shell.evaluate(async () => (await fetch("/api/lifeline/status")).status);
    expect(health).toBe(200);
  });

  test("renderers get window.agency and nothing from Node", async () => {
    const shell = await windowByUrl(ctx.app, "agency://shell/");
    const globals = await shell.evaluate(() => ({
      agency: typeof window.agency,
      role: window.agency.role,
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      contracts: window.agency.contractsVersion,
    }));
    expect(globals).toEqual({
      agency: "object",
      role: "shell",
      require: "undefined",
      process: "undefined",
      contracts: 0,
    });
    const opened = await shell.evaluate(() => window.open("https://example.com") === null);
    expect(opened).toBe(true);
    // The camera is refused outside the gaze window.
    const camera = await shell.evaluate(async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
        return "granted";
      } catch (e) {
        return (e as Error).name;
      }
    });
    expect(camera).not.toBe("granted");
  });

  test("an overlay window per display: transparent, on top and click-through", async () => {
    const overlay = await windowByUrl(ctx.app, "agency://overlay/");
    await expect(overlay.getByTestId("overlay-help")).toBeVisible();
    await expect(overlay.getByTestId("overlay-stop")).toBeVisible();
    const info = await ctx.app.evaluate(({ screen }) => {
      const a = (
        globalThis as unknown as {
          __agency: { overlays: Map<number, { win: Electron.BrowserWindow; interactive: boolean }> };
        }
      ).__agency;
      return {
        displays: screen.getAllDisplays().length,
        overlays: [...a.overlays.values()].map((o) => ({
          onTop: o.win.isAlwaysOnTop(),
          focusable: o.win.isFocusable(),
          allSpaces: o.win.isVisibleOnAllWorkspaces(),
          interactive: o.interactive,
        })),
      };
    });
    expect(info.overlays).toHaveLength(info.displays);
    for (const o of info.overlays) {
      expect(o.onTop).toBe(true);
      expect(o.focusable).toBe(false);
      expect(o.interactive).toBe(false); // click-through by default
      if (process.platform === "darwin") expect(o.allSpaces).toBe(true);
    }
    // Transparent: a captured pixel away from Help and Stop has zero alpha.
    const alpha = await ctx.app.evaluate(async () => {
      const a = (globalThis as any).__agency;
      const win = [...a.overlays.values()][0].win as Electron.BrowserWindow;
      const img = await win.webContents.capturePage({ x: 10, y: 10, width: 4, height: 4 });
      const bmp = img.toBitmap();
      return bmp.length ? bmp[3] : -1;
    });
    expect(alpha).toBe(0);
    // Hovering its own button makes it clickable; leaving makes it click-through again.
    await overlay.evaluate(() => window.agency.overlay.setInteractive(true));
    await expect
      .poll(() =>
        ctx.app.evaluate(() =>
          [...(globalThis as any).__agency.overlays.values()].some(
            (o: { interactive: boolean }) => o.interactive,
          ),
        ),
      )
      .toBe(true);
    await overlay.evaluate(() => window.agency.overlay.setInteractive(false));
    await expect
      .poll(() =>
        ctx.app.evaluate(() =>
          [...(globalThis as any).__agency.overlays.values()].some(
            (o: { interactive: boolean }) => o.interactive,
          ),
        ),
      )
      .toBe(false);
  });

  test("the preload API round-trips to the fake native helper, within each role's allowance", async () => {
    const overlay = await windowByUrl(ctx.app, "agency://overlay/");
    const pressed = await overlay.evaluate(() =>
      window.agency.native.call("ax.press", { targetId: "fake.ok" }),
    );
    expect(pressed).toEqual({ ok: true });
    const shell = await windowByUrl(ctx.app, "agency://shell/");
    const apps = await shell.evaluate(() => window.agency.native.call("apps.list", {}));
    expect(apps.apps[0]?.bundleId).toBe("com.example.fake");
    // Not allowed: the shell typing into other apps, anyone capturing the screen.
    const denied = await shell.evaluate(async () => {
      const out: string[] = [];
      for (const m of ["input.type", "screen.capture"] as const) {
        try {
          await window.agency.native.call(m as "input.type", { text: "x" });
          out.push(`${m}:allowed`);
        } catch {
          out.push(`${m}:denied`);
        }
      }
      return out;
    });
    expect(denied).toEqual(["input.type:denied", "screen.capture:denied"]);
    expect(jsonl(ctx.nativeLog).some((e) => e.method === "ax.press")).toBe(true);
    expect(jsonl(ctx.nativeLog).some((e) => e.method === "screen.capture")).toBe(false);
  });

  test("agent commands and events flow through main", async () => {
    const shell = await windowByUrl(ctx.app, "agency://shell/");
    const events = await shell.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const seen: string[] = [];
          const off = window.agency.agent.onEvent((e) => {
            seen.push(e.type);
            if (e.type === "approval.required") {
              off();
              resolve(seen);
            }
          });
          window.agency.agent.send({
            type: "task.start",
            request: { id: "t1", goal: "Order my usual", origin: "home", dryRun: true },
          });
        }),
    );
    expect(events).toEqual(["task.started", "task.plan", "task.step", "approval.required"]);
  });

  test("Stop from the overlay reaches the agent and agency-native at once", async () => {
    const overlay = await windowByUrl(ctx.app, "agency://overlay/");
    const before = Date.now();
    await overlay.getByTestId("overlay-stop").click();
    await expect
      .poll(
        () =>
          jsonl(ctx.nativeLog).filter((e) => e.method === "input.stopAll" && Number(e.at) >= before).length,
      )
      // Main's own call, plus the agent's (it also asks main to stop input; Stop doesn't depend on it).
      .toBe(2);
    await expect
      .poll(
        () =>
          jsonl(ctx.agentLog).filter(
            (e) => (e.command as { type?: string })?.type === "stop.all" && Number(e.at) >= before,
          ).length,
      )
      .toBe(1);
    const nativeAt = Number(
      jsonl(ctx.nativeLog).find((e) => e.method === "input.stopAll" && Number(e.at) >= before)!.at,
    );
    const agentAt = Number(
      jsonl(ctx.agentLog).find(
        (e) => (e.command as { type?: string })?.type === "stop.all" && Number(e.at) >= before,
      )!.at,
    );
    expect(Math.abs(nativeAt - agentAt)).toBeLessThan(500);
    // The agent's allowlisted native request went through main and was answered.
    await expect
      .poll(() =>
        jsonl(ctx.agentLog).some((e) => (e.rpcResult as { result?: { ok?: boolean } })?.result?.ok === true),
      )
      .toBe(true);
    const last = await ctx.app.evaluate(() => (globalThis as any).__agency.lastStop);
    expect(last).toMatchObject({ agent: "sent", native: "ok" });
  });

  test("Help on the overlay reaches the coordinator and surfaces the shell", async () => {
    const overlay = await windowByUrl(ctx.app, "agency://overlay/");
    await overlay.getByTestId("overlay-help").click();
    const shell = await windowByUrl(ctx.app, "agency://shell/");
    await expect
      .poll(async () =>
        shell.evaluate(
          async () =>
            ((await (await fetch("/api/lifeline/status")).json()) as { open_alert: unknown }).open_alert !==
            null,
        ),
      )
      .toBe(true);
    const state = await ctx.app.evaluate(() => {
      const a = (globalThis as any).__agency;
      return { surfaced: a.surfaced, onTop: a.shell.isAlwaysOnTop(), visible: a.shell.isVisible() };
    });
    expect(state).toEqual({ surfaced: true, onTop: true, visible: true });
    // Cancel it so the coordinator is clean (the test alert is real in this throwaway database).
    await shell.evaluate(async () => {
      const s = (await (await fetch("/api/lifeline/status")).json()) as {
        open_alert: { alert?: { id: string }; id?: string };
      };
      const id = s.open_alert.alert?.id ?? s.open_alert.id;
      await fetch(`/api/lifeline/alerts/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    });
  });

  test("Home from the overlay brings the shell forward and tells it", async () => {
    const shell = await windowByUrl(ctx.app, "agency://shell/");
    await shell.evaluate(() => {
      (window as unknown as { __home: number }).__home = 0;
      window.agency.onShowHome(() => ((window as unknown as { __home: number }).__home += 1));
    });
    const overlay = await windowByUrl(ctx.app, "agency://overlay/");
    await overlay.evaluate(() => window.agency.showHome());
    await expect.poll(() => shell.evaluate(() => (window as unknown as { __home: number }).__home)).toBe(1);
    expect(await ctx.app.evaluate(() => (globalThis as any).__agency.shell.isVisible())).toBe(true);
  });

  test("the main process sends Lifeline heartbeats", async () => {
    await expect
      .poll(
        () => ctx.app.evaluate(() => (globalThis as any).__agency.lifeline.heartbeatStatus.lastHeartbeatOk),
        { timeout: 15_000 },
      )
      .toBe(true);
  });
});

test.describe("Lifeline without a coordinator", () => {
  test("Help still surfaces the shell and keeps retrying", async () => {
    const c = await launch({ AGENCY_COORDINATOR_URL: "http://127.0.0.1:9", AGENCY_COORDINATOR_TOKEN: "x" });
    try {
      const overlay = await windowByUrl(c.app, "agency://overlay/");
      await overlay.getByTestId("overlay-help").click();
      await expect.poll(() => c.app.evaluate(() => (globalThis as any).__agency.surfaced)).toBe(true);
      expect(await c.app.evaluate(() => (globalThis as any).__agency.lifeline.helpPending)).toBe(true);
    } finally {
      await c.app.close();
    }
  });
});

test.describe("Global Stop hotkey", () => {
  test("is registered", async () => {
    const c = await launch({ AGENCY_COORDINATOR_URL: "http://127.0.0.1:9" });
    try {
      await windowByUrl(c.app, "agency://overlay/");
      const registered = await c.app.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered("Command+Shift+Escape"),
      );
      expect(registered).toBe(true);
    } finally {
      await c.app.close();
    }
  });
});

test.describe("Onboarding", () => {
  test("a helper can complete it with the mouse, and it resumes where it stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-onb-"));
    const env = {
      AGENCY_SKIP_ONBOARDING: "",
      AGENCY_USER_DATA: join(dir, "ud"),
      AGENCY_COORDINATOR_URL: "http://127.0.0.1:9",
    };
    let c = await launch(env);
    let page = await windowByUrl(c.app, "agency://host/onboarding/");
    await page.getByTestId("onboarding-start").click();
    await expect(page.locator("h1")).toHaveText("Camera");
    await page.getByTestId("onboarding-next").click();
    await expect(page.locator("h1")).toHaveText("Accessibility");
    await c.app.close();

    c = await launch(env);
    page = await windowByUrl(c.app, "agency://host/onboarding/");
    await expect(page.locator("h1")).toHaveText("Accessibility");
    for (const title of ["Screen Recording", "Microphone", "Speech Recognition", "All set"]) {
      await page.getByTestId("onboarding-next").click();
      await expect(page.locator("h1")).toHaveText(title);
    }
    const sizes = await page
      .locator("button")
      .evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).map((r) => Math.min(r.width, r.height)));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(96);
    await page.getByTestId("onboarding-finish").click();
    await windowByUrl(c.app, "agency://shell/");
    await c.app.close();
  });
});
