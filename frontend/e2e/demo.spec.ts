import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { CaseDetail, GoalPreview } from "../src/api/types";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());
test.beforeEach(async ({ context }) => {
  await coordinator.api("/api/demo/reset", { method: "POST" });
  await context.addInitScript(() => localStorage.setItem("agency.onboarded", "1"));
});

test("live demo starts empty and leads into a real, approval-gated workflow", async ({ page }, testInfo) => {
  await page.goto("/#/demo");
  await expect(page.getByRole("heading", { name: "Built-in plans are active" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Start with an intention." })).toBeVisible();
  await expect(page.getByRole("button", { name: /Get moving again/ })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("live-demo.png"), fullPage: true });
  await page.getByRole("button", { name: /Get moving again/ }).click();
  await expect(page.getByRole("button", { name: /Start this task/ })).toBeVisible();
  await page.getByRole("button", { name: /Start this task/ }).click();
  await expect(page.getByRole("heading", { name: /2 actions need your approval/ })).toBeVisible();
  const caseId = page.url().split("/case/")[1]!;
  const pending = await coordinator.api<CaseDetail>(`/api/cases/${caseId}`);
  expect(pending.steps.some((s) => s.tool === "repair.submit_request" && s.status === "verified")).toBe(
    false,
  );

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download evidence" }).click();
  const download = await downloadPromise;
  const receipt = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(receipt.format).toBe("agency.evidence.v1");
  expect(receipt.case.id).toBe(caseId);
  expect(receipt.case.status).toBe("waiting_approval");
  expect(receipt.metrics.approved_decisions).toBe(0);
  expect(receipt.disclosure).toContain("simulated demo services");
  expect(receipt.audit.approvals.every((a: { status: string }) => a.status === "pending")).toBe(true);

  await page.getByRole("button", { name: "Live demo", exact: true }).click();
  await expect(page.locator(".demo-stages li").first()).toHaveAttribute("data-done", "true");
  await expect(page.locator(".demo-stages li").nth(1)).toHaveAttribute("data-done", "false");
  await page.getByRole("button", { name: "Arm a taken-slot failure" }).click();
  await expect(page.getByRole("button", { name: "Taken-slot failure armed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Review pending actions" }).click();
  await page.getByRole("button", { name: /Approve all 2/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Go back" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: /Yes, do all 2/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Go back" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("a failed interpretation can actually be retried", async ({ page }) => {
  let failed = false;
  await page.route("**/api/goals/interpret", async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 503, json: { detail: "Unavailable" } });
    } else await route.continue();
  });
  await page.goto("/#/new/create?goal=equipment_repair&issue=battery");
  await expect(page.getByText("The coordinator isn't responding.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Start this task" })).toBeVisible();
});

test("late case responses never overwrite the newly selected case", async ({ page }) => {
  const preview = await coordinator.api<GoalPreview>("/api/goals/interpret", {
    method: "POST",
    body: JSON.stringify({ goal_type: "equipment_repair", selections: { issue: "battery" } }),
  });
  const older = await coordinator.api<CaseDetail>("/api/cases", {
    method: "POST",
    body: JSON.stringify({ goal: preview.goal }),
  });
  const newer = await coordinator.api<CaseDetail>("/api/cases", {
    method: "POST",
    body: JSON.stringify({ goal: preview.goal }),
  });
  let release!: () => void;
  let notifyRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    notifyRequested = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delivered!: () => void;
  const delivery = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  await page.route(`**/api/cases/${newer.id}`, async (route) => {
    notifyRequested();
    await gate;
    await route.fulfill({ json: { ...newer, title: "Late response from the previous case" } });
    delivered();
  });
  await page.route(`**/api/cases/${older.id}`, async (route) => {
    await route.fulfill({ json: { ...older, title: "The case you selected" } });
  });
  await page.goto("/#/demo");
  await requested;
  await page.getByRole("group", { name: "Choose a case to inspect" }).getByRole("button").nth(1).click();
  await expect(page.getByRole("heading", { name: "The case you selected" })).toBeVisible();
  release();
  await delivery;
  await expect(page.getByRole("heading", { name: "The case you selected" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Late response from the previous case" })).toHaveCount(0);
});

test("home and onboarding fit a phone viewport with large selection targets", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/");
  const start = page.getByRole("button", { name: /Start a task/ });
  await expect(start).toBeVisible();
  const bounds = await start.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.height).toBeGreaterThanOrEqual(76);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("home-mobile.png"), fullPage: true });
  await page.goto("/#/welcome");
  await expect(page.getByRole("heading", { name: /Your intention/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Eye gaze/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Explore the live demo" }).click();
  await expect(page).toHaveURL(/#\/demo/);
});
