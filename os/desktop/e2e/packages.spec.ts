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
        .poll(() => app.evaluate(() => (globalThis as any).__agency.agent?.status ?? null), { timeout: 30_000 })
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
