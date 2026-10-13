/**
 * Today's Calendar events through agency-native's read-only `calendar.today`, as the Mac app's shell reaches it (the
 * fake helper stands in for EventKit here). Only the shell may ask; the overlay may not.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const desktop = resolve(__dirname, "..");
const repo = resolve(desktop, "..", "..");

let app: ElectronApplication;

async function windowByUrl(part: string): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => w.url().includes(part)), { timeout: 30_000 }).toBe(true);
  return app.windows().find((w) => w.url().includes(part))!;
}

test.beforeAll(async () => {
  test.skip(
    !existsSync(join(repo, "backend", ".venv", "bin", "python")),
    "needs backend/.venv (make setup-backend)",
  );
  const dir = mkdtempSync(join(tmpdir(), "agency-calendar-e2e-"));
  app = await electron.launch({
    args: [desktop],
    cwd: desktop,
    env: {
      ...process.env,
      AGENCY_TEST: "1",
      AGENCY_USER_DATA: join(dir, "userdata"),
      AGENCY_SKIP_ONBOARDING: "1",
      AGENCY_NATIVE_PATH: join(desktop, "fakes", "fake-native.cjs"),
      AGENCY_AGENT_ENTRY: join(desktop, "fakes", "fake-agent.cjs"),
      AGENCY_FAKE_NATIVE_LOG: join(dir, "native.jsonl"),
      AGENCY_FAKE_AGENT_LOG: join(dir, "agent.jsonl"),
      AGENCY_LOG_ECHO: "0",
      AGENCY_GAZE: "mouse",
      AGENCY_OVERLAY_BUILTIN: "1",
    },
  });
});

test.afterAll(async () => {
  await app?.close();
});

test("the shell can read today's events; the overlay can't", async () => {
  const shell = await windowByUrl("agency://shell/");
  const r = await shell.evaluate(() => window.agency.native.call("calendar.today", {}));
  expect(r).toEqual({
    ok: true,
    events: [{ title: "Fake calendar event", start: "23:55", allDay: false, location: "", calendar: "Fake" }],
  });
  const overlay = await windowByUrl("agency://overlay/");
  const refused = await overlay.evaluate(() =>
    window.agency.native.call("calendar.today", {}).then(
      () => "allowed",
      (e: unknown) => String(e),
    ),
  );
  expect(refused).toContain("may not call");
});
