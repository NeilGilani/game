/**
 * Integration with the other instances' real packages, when they are built. Each test is skipped (and says so) if
 * that package's build isn't present, so this file grows as packages land on main.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const desktop = resolve(__dirname, "..");
const repo = resolve(desktop, "..", "..");
const agentEntry = join(repo, "os", "agent", "dist", "agent-utility.mjs");
const overlayIndex = join(repo, "os", "overlay", "dist", "index.html");
const nativeBin = join(repo, "os", "native-macos", ".build", "release", "agency-native");

async function launch(env: Record<string, string>): Promise<ElectronApplication> {
  const dir = mkdtempSync(join(tmpdir(), "agency-pkg-"));
  return electron.launch({
    args: [desktop],
    cwd: desktop,
    env: {
      ...process.env,
      AGENCY_TEST: "1",
      AGENCY_USER_DATA: join(dir, "userdata"),
      AGENCY_SKIP_ONBOARDING: "1",
      AGENCY_NATIVE_PATH: join(desktop, "fakes", "fake-native.cjs"),
      AGENCY_LOG_ECHO: "0",
      AGENCY_GAZE: "mouse",
      ...env,
    },
  });
}

test.describe("os/agent (Instance 4) in its utility process", () => {
  test.skip(!existsSync(agentEntry), "os/agent is not built (npm run build -w @agency/agent)");

  test("starts, reports status, runs its scripted task and stops on Stop", async () => {
    const app = await launch({ AGENCY_AGENT_ENTRY: agentEntry, AGENCY_AGENT_FAKE: "1" });
    try {
      await expect
        .poll(() => app.evaluate(() => (globalThis as any).__agency.agent?.status ?? null), {
          timeout: 30_000,
        })
        .toMatchObject({ fake: true });
      await expect.poll(() => app.windows().some((w) => w.url().startsWith("agency://shell/"))).toBe(true);
      const shell = app.windows().find((w) => w.url().startsWith("agency://shell/"))!;
      const seen = await shell.evaluate(
        () =>
          new Promise<string[]>((resolve) => {
            const types: string[] = [];
            const off = window.agency.agent.onEvent((e) => {
              types.push(e.type);
              if (types.length === 1) void window.agency.stopAll();
              if (e.type === "task.stopped" || e.type === "task.done" || e.type === "task.failed") {
                off();
                resolve(types);
              }
            });
            window.agency.agent.send({
              type: "task.start",
              request: { id: "t-real", goal: "Order my usual Friday dinner", origin: "home", dryRun: true },
            });
          }),
      );
      expect(seen[0]).toBe("task.started");
      expect(seen.at(-1)).toBe("task.stopped");
      const last = await app.evaluate(() => (globalThis as any).__agency.lastStop);
      expect(last).toMatchObject({ agent: "sent", native: "ok" });
    } finally {
      await app.close();
    }
  });
});

test.describe("os/overlay (Instance 3) in the overlay windows", () => {
  test.skip(!existsSync(overlayIndex), "os/overlay is not built (npm run build -w @agency/overlay)");

  test("loads over every display and talks to the host", async () => {
    const app = await launch({});
    try {
      await expect
        .poll(() => app.windows().some((w) => w.url().startsWith("agency://overlay/index.html")))
        .toBe(true);
      const overlay = app.windows().find((w) => w.url().startsWith("agency://overlay/index.html"))!;
      // While AGENCY's own window is in front the overlay stands down (the shell has its own Help and Stop); the rail
      // is for every other app. Put another app in front, as far as AGENCY can tell (once the shell has shown itself).
      await expect
        .poll(() =>
          app.evaluate(() =>
            (
              globalThis as unknown as { __agency: { shell: { isVisible(): boolean } } }
            ).__agency.shell.isVisible(),
          ),
        )
        .toBe(true);
      await app.evaluate(() => {
        const shell = (globalThis as unknown as { __agency: { shell: { blur(): void; hide(): void } } })
          .__agency.shell;
        shell.blur();
        shell.hide();
      });
      await expect(overlay.getByRole("button", { name: /help/i }).first()).toBeVisible();
      await expect(overlay.getByRole("button", { name: /stop/i }).first()).toBeVisible();
      const errors: string[] = [];
      overlay.on("pageerror", (e) => errors.push(e.message));
      await overlay.waitForTimeout(500);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

test.describe("agency-native (Instance 3) under supervision", () => {
  test.skip(
    process.platform !== "darwin" || !existsSync(nativeBin),
    "agency-native is not built (swift build -c release)",
  );

  test("starts, answers the health check and takes input.stopAll", async () => {
    const app = await launch({ AGENCY_NATIVE_PATH: nativeBin });
    try {
      await expect
        .poll(() => app.evaluate(() => (globalThis as any).__agency.states.native), { timeout: 30_000 })
        .toBe("running");
      const r = await app.evaluate(() => (globalThis as any).__agency.native.call("input.stopAll", {}));
      expect(r).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});
