/** Camera unavailable or denied: explain the actual failure and offer a working alternative. */
import { expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

test("camera access failure leads to guidance and a working alternative", async ({ browser }) => {
  const context = await browser.newContext({ permissions: [] });
  await context.addInitScript(() => localStorage.setItem("agency.onboarded", "1"));
  const page = await context.newPage();
  await page.goto("/#/preferences");
  await page.getByRole("radio", { name: /Eye gaze/ }).click();
  await page.goto("/#/camera");
  await page.getByRole("button", { name: /Start camera/ }).click();
  await expect(
    page.getByRole("heading", {
      name: /Camera permission was not given|No camera found|This browser can't use the camera/,
    }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /Use key-switch scanning instead/ }).click();
  await expect(page.getByText(/Key switch/).first()).toBeVisible();
  await context.close();
});
