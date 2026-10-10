/** Coordinator loss and restart, global stop, and key-switch scanning. */
import { expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("agency.onboarded", "1"));
});

test("losing the coordinator shows a clear state, and the case survives a restart", async ({ page }) => {
  await page.goto("/#/new/create?goal=message_followup&contact_id=c_jordan&template=please_call");
  await page.getByRole("button", { name: /Start this task/ }).click();
  await expect(page.getByRole("heading", { name: /One action needs your approval/ })).toBeVisible({
    timeout: 30_000,
  });
  const caseUrl = page.url();

  await coordinator.stop();
  await expect(page.getByText(/Can't reach the coordinator/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Coordinator offline")).toBeVisible();

  await coordinator.start();
  await expect(page.getByText(/Can't reach the coordinator/)).toBeHidden({ timeout: 20_000 });
  await page.goto(caseUrl);
  await expect(page.getByRole("heading", { name: /One action needs your approval/ })).toBeVisible();
  await page.getByRole("button", { name: /Review and decide/ }).click();
  await page.getByRole("button", { name: /^Approve$/ }).click();
  await page.getByRole("button", { name: /Yes, do it/ }).click();
  await page.goto(caseUrl);
  await expect(page.getByRole("heading", { name: "Everything I did has been checked." })).toBeVisible({
    timeout: 30_000,
  });
});

test("Stop agent halts automation until resumed", async ({ page }) => {
  await page.goto("/#/");
  await page.getByRole("button", { name: /Stop agent/ }).click();
  await expect(page.getByText(/Automation is stopped/)).toBeVisible();
  await page.goto("/#/new/create?goal=message_followup&contact_id=c_clinic&template=supplies_low");
  await page.getByRole("button", { name: /Start this task/ }).click();
  await expect(page.getByText(/All automation is stopped/)).toBeVisible({ timeout: 20_000 });
  const outbox = await coordinator.api<{ messages: unknown[] }>("/api/demo-services/messaging/outbox");
  const before = outbox.messages.length;
  await page.getByRole("button", { name: /Resume agent/ }).click();
  await expect(page.getByRole("heading", { name: /One action needs your approval/ })).toBeVisible({
    timeout: 30_000,
  });
  const after = await coordinator.api<{ messages: unknown[] }>("/api/demo-services/messaging/outbox");
  expect(after.messages.length).toBe(before + 1); // only a draft was created after resuming
});

test("key-switch scanning selects without a mouse (keyboard switch, not computer vision)", async ({
  page,
}) => {
  await page.goto("/#/preferences");
  await page.getByRole("radio", { name: /Key switch/ }).click();
  await page.goto("/#/errands");
  const start = page.getByRole("button", { name: /Start a task/ });
  // Wait for the scan highlight to reach "Start a task", then press the switch.
  await expect(start).toHaveAttribute("data-scan-active", "", { timeout: 60_000 });
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/#\/new$/);
  await page.goto("/#/preferences");
  await page.getByRole("radio", { name: /Mouse & keys/ }).click();
});
