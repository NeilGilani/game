/**
 * My day in AGENCY.app: the home through the real main process (os/desktop/src/main/home) with its real IPC and
 * rules, and today's Calendar through the (fake) native helper. Nothing runs a real shortcut here: the tests stop
 * at the ticket, and the shell shows the practice home until a helper turns the home on.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const desktop = resolve(__dirname, "..");
const repo = resolve(desktop, "..", "..");

let app: ElectronApplication;

async function shellWindow(): Promise<Page> {
  await expect
    .poll(() => app.windows().some((w) => w.url().includes("agency://shell/")), { timeout: 30_000 })
    .toBe(true);
  return app.windows().find((w) => w.url().includes("agency://shell/"))!;
}

test.beforeAll(async () => {
  test.skip(
    !existsSync(join(repo, "backend", ".venv", "bin", "python")),
    "needs backend/.venv (make setup-backend)",
  );
  const dir = mkdtempSync(join(tmpdir(), "agency-home-e2e-"));
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

const LAMP = {
  id: "lamp",
  name: "Bedroom lamp",
  kind: "light",
  actions: [{ id: "on", label: "Turn on", shortcut: "Bedroom lamp on", confirm: false }],
};

test("home control is off by default; the shell shows the practice home", async () => {
  const shell = await shellWindow();
  await shell.evaluate(() => localStorage.setItem("agency.onboarded", "1"));
  const status = await shell.evaluate(() => window.agency.home!.status());
  expect(status).toMatchObject({ available: process.platform === "darwin", enabled: false, devices: [] });
  const refused = await shell.evaluate(() => window.agency.home!.prepare("lamp", "on"));
  expect(refused.ok).toBe(false);
  await shell.evaluate(() => (location.hash = "/day/home"));
  await expect(shell.getByText("Practice home").first()).toBeVisible();
});

test("main refuses doors and locks, and binds a run to its ticket", async () => {
  test.skip(process.platform !== "darwin", "Shortcuts are macOS only");
  const shell = await shellWindow();
  const door = await shell.evaluate(
    (lamp) =>
      window.agency.home!.setSettings({ enabled: true, devices: [{ ...lamp, name: "Front door" }] } as never),
    LAMP,
  );
  expect(door).toMatchObject({ ok: false, error: expect.stringContaining("never controls doors") });
  const saved = await shell.evaluate(
    (lamp) => window.agency.home!.setSettings({ enabled: true, devices: [lamp] } as never),
    LAMP,
  );
  expect(saved.ok).toBe(true);
  const p = await shell.evaluate(() => window.agency.home!.prepare("lamp", "on"));
  expect(p).toMatchObject({ ok: true, confirm: false, summary: "Turn on: Bedroom lamp" });
  if (!p.ok) return;
  const wrong = await shell.evaluate((t) => window.agency.home!.run(t, "not-the-fingerprint"), p.ticket);
  expect(wrong).toMatchObject({ ok: false, error: expect.stringContaining("doesn't match") });
  // The ticket was used up by the wrong try: the right fingerprint no longer runs anything.
  const late = await shell.evaluate(([t, f]) => window.agency.home!.run(t, f), [
    p.ticket,
    p.fingerprint,
  ] as const);
  expect(late.ok).toBe(false);
  // Stop forgets prepared changes.
  const again = await shell.evaluate(() => window.agency.home!.prepare("lamp", "on"));
  await shell.evaluate(() => window.agency.stopAll());
  if (again.ok) {
    const after = await shell.evaluate(([t, f]) => window.agency.home!.run(t, f), [
      again.ticket,
      again.fingerprint,
    ] as const);
    expect(after.ok).toBe(false);
  }
  // With a device set up, the shell shows the real home: no practice label.
  await shell.evaluate(() => (location.hash = "/"));
  await shell.evaluate(() => (location.hash = "/day/home"));
  await expect(shell.getByTestId("day-device-lamp")).toBeVisible();
  await expect(shell.getByText("Practice home")).toHaveCount(0);
  await shell.evaluate(() => window.agency.home!.setSettings({ enabled: false, devices: [] }));
});

test("today's Calendar events come through the native helper only when turned on", async () => {
  const shell = await shellWindow();
  await shell.evaluate(() => {
    localStorage.setItem("agency.fakes", "daily");
    localStorage.removeItem("agency.daily.calendar");
    location.hash = "/";
  });
  await shell.reload();
  await shell.evaluate(() => (location.hash = "/day/today"));
  await expect(shell.getByTestId("day-today")).toBeVisible();
  await expect(shell.getByText("Fake calendar event")).toHaveCount(0);
  const r = await shell.evaluate(() => window.agency.native.call("calendar.today", {}));
  expect(r).toMatchObject({ ok: true });
  await shell.evaluate(() => localStorage.setItem("agency.daily.calendar", "on"));
  await shell.evaluate(() => (location.hash = "/day"));
  await shell.evaluate(() => (location.hash = "/day/today"));
  // The event is at 11:55 pm: the last page of the day.
  await expect
    .poll(async () => {
      const later = shell.getByRole("button", { name: /^Later$/ }).last();
      if (await later.isEnabled().catch(() => false)) await later.click();
      return shell.getByText("Fake calendar event").count();
    })
    .toBeGreaterThan(0);
  await expect(shell.getByText("From your Mac's Calendar").first()).toBeVisible();
});
