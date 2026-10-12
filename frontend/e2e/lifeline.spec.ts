/**
 * Lifeline end to end: a real browser, a real coordinator with its real supervisor loop, real
 * timers. Contacts use the simulated-phone channel; the response pages are the real ones.
 * The eye signal is driven by SYNTHETIC blink frames injected through the test hook (the
 * camera pipeline itself is covered by camera.spec.ts).
 */
import { type Page, expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

test.beforeEach(async ({ context }) => {
  await coordinator.api("/api/demo/reset", { method: "POST" });
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.testHooks", "1");
  });
});

interface Notification {
  contact_id: string;
  purpose: string;
  status: string;
}
interface Alert {
  id: string;
  kind: string;
  source: string;
  status: string;
  resolved_by: string | null;
  acknowledged_by: string | null;
  notifications: Notification[];
}
interface Status {
  open_alert: Alert | null;
  recent: Alert[];
  monitor: { armed: boolean; checkin_pending_since: string | null };
  settings: Record<string, unknown>;
}

const status = () => coordinator.api<Status>("/api/lifeline/status");
const overlay = (page: Page) => page.getByRole("alertdialog");

async function settings(changes: Record<string, unknown>): Promise<void> {
  const current = await coordinator.api<Record<string, unknown>>("/api/lifeline/settings");
  await coordinator.api("/api/lifeline/settings", {
    method: "PUT",
    body: JSON.stringify({ ...current, ...changes }),
  });
}

/** Synthetic eye frames at ~30 fps: [ms, blink score] segments, in real time. */
async function eyes(page: Page, segments: [number, number][]): Promise<void> {
  await page.evaluate(async (segs) => {
    const hook = (window as unknown as { __agency: { inject: (f: object) => void } }).__agency;
    for (const [ms, blink] of segs) {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        hook.inject({ face: true, blink, confidence: 1 });
        await new Promise((r) => setTimeout(r, 33));
      }
    }
  }, segments);
}

test("Help starts a countdown that can be cancelled before anyone is contacted", async ({ page }) => {
  await page.goto("/#/");
  // Help is the first control in the top bar, so it's the first choice when scanning.
  const firstControl = page.locator("header.topbar [data-dwell]").first();
  await expect(firstControl).toHaveAccessibleName(/Help/);

  await page.getByRole("button", { name: /Help: call for help/ }).click();
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page).getByRole("heading", { name: "Calling for help" })).toBeVisible();
  await expect(overlay(page).getByText(/will alert Jordan in \d seconds/)).toBeVisible();
  const cancel = overlay(page).getByRole("button", { name: /Cancel, I'm OK/ });
  await expect(cancel).toHaveAttribute("data-dwell-scale", "2");
  await cancel.click();
  await expect(overlay(page)).toBeHidden();

  await page.waitForTimeout(9000); // past the countdown: still nothing sent
  const s = await status();
  expect(s.open_alert).toBeNull();
  expect(s.recent[0]!.status).toBe("cancelled");
  const outbox = await coordinator.api<{ messages: unknown[] }>("/api/lifeline/outbox");
  expect(outbox.messages).toHaveLength(0);
});

test("unreachable caregiver: fails over, neighbour answers on the response page, person ends the alert", async ({
  page,
  context,
}) => {
  await coordinator.api("/api/demo/faults", {
    method: "PUT",
    body: JSON.stringify({ lifeline_primary_unreachable: true }),
  });
  await page.goto("/#/");
  await page.getByRole("button", { name: /Help: call for help/ }).click();
  await overlay(page).getByRole("button", { name: "Call now" }).click();

  await expect(overlay(page).getByRole("heading", { name: "Help is being called" })).toBeVisible();
  const people = overlay(page).getByRole("list", { name: "People contacted" });
  await expect(people.getByText(/Couldn't reach/)).toBeVisible();
  await expect(people.getByText("Morgan")).toBeVisible();
  await expect(overlay(page).getByText("Waiting for Morgan to answer.")).toBeVisible();

  // Morgan's (simulated) phone, in its own window, like a separate device.
  const phones = await context.newPage();
  await phones.goto("/#/phones");
  await expect(phones.getByRole("region", { name: "Morgan's simulated phone" })).toContainText(
    "AGENCY ALERT",
  );
  await expect(phones.getByRole("region", { name: "Jordan's simulated phone" })).toContainText("No messages");
  const [responder] = await Promise.all([
    context.waitForEvent("page"),
    phones.getByRole("link", { name: "Open as Morgan" }).click(),
  ]);
  await expect(responder.getByRole("heading", { name: "Riley needs help" })).toBeVisible();
  const aboutRiley = responder.locator("section").filter({ hasText: "About Riley" });
  await expect(aboutRiley.getByText("Uses a home ventilator")).toBeVisible();
  await responder.getByRole("button", { name: "I'm on my way" }).click();
  await expect(responder.getByRole("heading", { name: "You're on the way" })).toBeVisible();

  await expect(overlay(page).getByRole("heading", { name: "Morgan is on the way" })).toBeVisible();
  // Minimized, the alert is a bar above the dock: Help and Stop are never covered.
  await overlay(page).getByRole("button", { name: "Minimize" }).click();
  const bar = page.getByRole("status").filter({ hasText: "Morgan is on the way" });
  await expect(bar).toBeVisible();
  for (const name of [/^Help/, /Stop agent/]) {
    const box = (await page.getByRole("button", { name }).first().boundingBox())!;
    const onTop = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".dock"), {
      x: box.x + box.width / 2,
      y: box.y + box.height - 6,
    });
    expect(onTop, `${name} is uncovered`).toBe(true);
  }
  await bar.getByRole("button", { name: "Show alert" }).click();
  await overlay(page).getByRole("button", { name: "I'm OK now" }).click();
  await expect(overlay(page).getByText("End the alert and tell everyone you're OK?")).toBeVisible();
  await overlay(page).getByRole("button", { name: "Yes, I'm OK" }).click();
  await expect(overlay(page)).toBeHidden();

  const s = await status();
  const alert = await coordinator.api<Alert>(`/api/lifeline/alerts/${s.recent[0]!.id}`);
  expect(alert.status).toBe("resolved");
  expect(alert.resolved_by).toBe("Riley");
  expect(alert.acknowledged_by).toBe("Morgan");
  const sent = alert.notifications.map((n) => `${n.purpose}:${n.contact_id}:${n.status}`);
  expect(sent).toEqual(["alert:jordan:failed", "alert:morgan:delivered", "all_clear:morgan:delivered"]);

  // The responder page no longer shows medical details once the alert has ended.
  await responder.reload();
  await expect(responder.getByRole("heading", { name: "This alert has ended" })).toBeVisible();
  await expect(responder.getByText("Uses a home ventilator")).toHaveCount(0);

  // The full record.
  await page.goto(`/#/lifeline/alert/${alert.id}`);
  await expect(page.getByText(/Couldn't reach Jordan/)).toBeVisible();
  await expect(page.getByText(/Morgan answered: on the way/)).toBeVisible();
});

test("three long blinks call for help; ordinary blinks don't", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByRole("button", { name: /Help: call for help/ })).toBeVisible();

  const blinks: [number, number][] = [];
  for (let i = 0; i < 8; i++) blinks.push([180, 0.9], [400, 0.05]);
  await eyes(page, blinks);
  await expect(page.getByText(/Help signal/)).toBeHidden();
  expect((await status()).open_alert).toBeNull();

  await eyes(page, [
    [300, 0.05],
    [1000, 0.9],
    [600, 0.05],
  ]);
  await expect(page.getByRole("status").filter({ hasText: "Help signal: 1 of 3 long blinks" })).toBeVisible();
  await eyes(page, [
    [1000, 0.9],
    [600, 0.05],
    [1000, 0.9],
    [400, 0.05],
  ]);
  await expect(overlay(page).getByRole("heading", { name: "Calling for help" })).toBeVisible();
  const open = (await status()).open_alert!;
  expect(open.source).toBe("eye_signal");
  await overlay(page)
    .getByRole("button", { name: /Cancel, I'm OK/ })
    .click();
  await expect(overlay(page)).toBeHidden();
});

test("an unanswered check-in and a silent screen both raise alerts on their own", async ({ page }) => {
  test.setTimeout(90_000);
  await settings({ watchdog_timeout_s: 15 });
  await page.goto("/#/lifeline");
  await page.getByRole("button", { name: /^Off/ }).click();
  await expect(page.getByRole("button", { name: /On: AGENCY is watching/ })).toBeVisible();

  // Check-in: answered.
  await page.getByRole("button", { name: /Ask for a check-in now/ }).click();
  await expect(overlay(page).getByRole("heading", { name: "Check-in: are you OK?" })).toBeVisible();
  await overlay(page).getByRole("button", { name: "I'm OK", exact: true }).click();
  await expect(overlay(page)).toBeHidden();
  expect((await status()).monitor.checkin_pending_since).toBeNull();

  // Watchdog: the presenter stops this screen's heartbeats, as if it had frozen.
  await page.getByRole("button", { name: /Freeze this computer/ }).click();
  await expect(overlay(page).locator(".ll-why")).toBeVisible({ timeout: 30_000 });
  await expect(overlay(page).getByRole("heading", { name: "Help is being called" })).toBeVisible();
  await expect(overlay(page).locator(".ll-why")).toContainText("stopped responding");
  const open = (await status()).open_alert!;
  expect(open.kind).toBe("watchdog");
  expect(open.status).toBe("active");
});

test("if the coordinator can't be reached, the alarm sounds here and the request is retried until it gets through", async ({
  page,
}) => {
  await page.route("**/api/lifeline/help", (route) => route.abort());
  await page.goto("/#/");
  await page.getByRole("button", { name: /Help: call for help/ }).click();
  await expect(overlay(page).getByRole("heading", { name: "Can't reach the coordinator yet" })).toBeVisible();
  await expect(overlay(page).getByText(/The alarm is sounding here/)).toBeVisible();

  // Survives a reload: the request is kept on this device until it's delivered.
  await page.reload();
  await expect(overlay(page).getByRole("heading", { name: "Can't reach the coordinator yet" })).toBeVisible();
  expect((await status()).open_alert).toBeNull();

  await page.unroute("**/api/lifeline/help");
  await expect(overlay(page).getByRole("heading", { name: "Calling for help" })).toBeVisible({
    timeout: 10_000,
  });
  expect((await status()).open_alert?.status).toBe("pending_cancel");
  await overlay(page)
    .getByRole("button", { name: /Cancel, I'm OK/ })
    .click();
  await expect(overlay(page)).toBeHidden();
});
