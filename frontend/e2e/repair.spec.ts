/**
 * The flagship scenario, end to end in a real browser against a real coordinator:
 * goal -> plan -> tools -> approvals -> injected failure -> recovery -> refresh -> verified result.
 * Input here is the mouse (the always-available fallback), not computer vision.
 */
import { type Page, expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

/** The plan row whose title is exactly `title`. */
const stepRow = (page: Page, title: string) =>
  page.locator(".step").filter({ has: page.locator(".step-title").getByText(title, { exact: true }) });

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("agency.onboarded", "1"));
});

interface RepairRequest {
  status: string;
  slot_id: string;
}

test("wheelchair repair: plan, approve, recover from a taken slot, survive refresh, verify", async ({
  page,
}) => {
  await page.goto("/#/errands");
  // The menu bar names the coordinator (the new menu bar hides the "Coordinator:" label).
  await expect(page.getByRole("link", { name: "This MacBook" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Demo mode: built-in plans" })).toBeVisible();

  // 1. Express the intention with a few large selections.
  await page.getByRole("button", { name: /Start a task/ }).click();
  await page
    .getByRole("button", { name: /Get my wheelchair repaired/ })
    .last()
    .click();
  await expect(page.getByRole("heading", { name: /What's wrong with the wheelchair/ })).toBeVisible();
  await page.getByRole("button", { name: /Won't charge/ }).click();
  await expect(page.getByText("I'll ask before")).toBeVisible();
  await page.getByRole("button", { name: /Start this task/ }).click();

  // 2. The agent plans and runs the preparatory tools, then stops for approval.
  await expect(page).toHaveURL(/#\/case\/case_/);
  await expect(page.getByRole("heading", { name: /2 actions need your approval/ })).toBeVisible({
    timeout: 30_000,
  });
  for (const title of [
    "Collect device and repair details",
    "Check the repair provider's available times",
    "Prepare a repair request",
    "Identify missing documents",
    "Prepare a funding inquiry",
    "Book the repair appointment",
    "Send the message to your caregiver",
    "Double-check every result",
  ]) {
    await expect(page.locator(".step-title", { hasText: title })).toBeVisible();
  }
  await expect(page.getByText(/Still needed: Letter of medical necessity/)).toBeVisible();
  const caseId = page.url().split("/case/")[1]!.split("/")[0]!;

  // Nothing consequential has happened yet.
  let requests = await coordinator.api<{ requests: RepairRequest[] }>("/api/demo-services/repair/requests");
  expect(requests.requests.map((r) => r.status)).toEqual(["draft"]);

  // 3. Presenter arms the failure: the chosen slot will be taken by someone else.
  await page.goto("/#/status");
  await page.getByRole("button", { name: /Repair slot gets taken/ }).click();
  await expect(page.getByRole("button", { name: /Repair slot gets taken/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // 4. Approve both actions with a confirmation step.
  await page.goto(`/#/case/${caseId}/approve`);
  await expect(page.getByRole("heading", { name: "2 actions are ready" })).toBeVisible();
  await page.getByRole("button", { name: /Approve all 2/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Do all 2 now?");
  await page.getByRole("button", { name: /Yes, do all 2/ }).click();

  // 5. The booking fails; the agent explains, verifies nothing was booked, and proposes a fix.
  await page.goto(`/#/case/${caseId}`);
  await expect(stepRow(page, "Book the repair appointment")).toContainText("Failed", { timeout: 30_000 });
  await expect(page.getByText(/That appointment time is no longer available/)).toBeVisible();
  await expect(stepRow(page, "Send the funding inquiry")).toContainText("Verified");
  await page.getByRole("button", { name: /What went wrong/ }).click();
  await expect(page.getByText(/nothing was booked and nothing was charged/)).toBeVisible();
  await page.getByRole("button", { name: /Review the fix/ }).click();
  await expect(page.getByText("Something went wrong, so I'm proposing a fix")).toBeVisible();
  await expect(page.getByText(/taken by someone else/)).toBeVisible();
  await page.getByRole("button", { name: /^Approve$/ }).click();
  await page.getByRole("button", { name: /Yes, do it/ }).click();

  // 6. Refresh the browser mid-case: state comes back from the coordinator.
  await page.goto(`/#/case/${caseId}`);
  await expect(page.getByRole("heading", { name: /One action needs your approval/ })).toBeVisible({
    timeout: 30_000,
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: /One action needs your approval/ })).toBeVisible();
  await expect(stepRow(page, "Book a different repair time")).toContainText("Verified");

  // 7. Approve the caregiver message (simulated delivery).
  await page.getByRole("button", { name: /Review and decide/ }).click();
  await expect(page.getByRole("heading", { name: /Send this message to Jordan/ })).toBeVisible();
  await expect(page.getByText(/simulated, nobody is actually contacted/)).toBeVisible();
  await page.getByRole("button", { name: /^Approve$/ }).click();
  await page.getByRole("button", { name: /Yes, do it/ }).click();

  // 8. Verified outcome, with evidence from the services' own records.
  await page.goto(`/#/case/${caseId}`);
  await expect(page.getByRole("heading", { name: "Everything I did has been checked." })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Repair booked for .* \(ref DRP-\d+\)/)).toBeVisible();
  await expect(page.getByText(/No decision has been made yet/)).toBeVisible();
  await expect(page.getByText(/No real company, office or person was contacted/)).toBeVisible();

  requests = await coordinator.api<{ requests: RepairRequest[] }>("/api/demo-services/repair/requests");
  expect(requests.requests.filter((r) => r.status === "confirmed")).toHaveLength(1);
  const outbox = await coordinator.api<{ real_world_delivery: boolean; messages: { status: string }[] }>(
    "/api/demo-services/messaging/outbox",
  );
  expect(outbox.real_world_delivery).toBe(false);
  expect(outbox.messages.map((m) => m.status)).toEqual(["delivered_simulated"]);

  // 9. The timeline reflects what actually happened, in order.
  await page.getByRole("button", { name: /See what happened/ }).click();
  await page.getByRole("tab", { name: /Tool calls/ }).click();
  await expect(page.locator("table.data")).toContainText("repair.submit_request");
  await page.getByRole("tab", { name: /Events/ }).click();
  await expect(page.locator(".timeline")).toContainText("Case finished");
});

test("approval can be changed, and a declined action blocks what depends on it", async ({ page }) => {
  await page.goto(
    "/#/new/create?goal=equipment_repair&issue=wheel&check_funding=false&notify_caregiver=false",
  );
  await page.getByRole("button", { name: /Start this task/ }).click();
  await expect(page.getByRole("heading", { name: /One action needs your approval/ })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: /Review and decide/ }).click();
  const original = await page.getByRole("heading", { level: 1 }).last().innerText();
  await page.getByRole("button", { name: /^Change$/ }).click();
  await page.locator(".option").nth(1).click();
  await expect(page.getByRole("heading", { level: 1 }).last()).not.toHaveText(original);
  await page.getByRole("button", { name: /Say no/ }).click();
  await page.getByRole("button", { name: /Yes, don't do it/ }).click();
  await page.getByRole("button", { name: /Back to the case/ }).click();
  await expect(page.getByText("Some parts weren't done.")).toBeVisible({ timeout: 30_000 });
  await expect(stepRow(page, "Add the repair to your calendar")).toContainText("Not done");
});
