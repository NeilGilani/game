import { expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.fakes", "memory,agent,native");
    localStorage.setItem(
      "agency.preferences",
      JSON.stringify({ input_mode: "pointer", reduced_motion: true }),
    );
  });
});

test("destructive confirmation contains Tab focus, cancels with Escape and restores its trigger", async ({
  page,
}) => {
  await page.goto("/#/settings/memory");
  const trigger = page.getByRole("button", { name: /Erase everything.*Start again/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Erase everything AGENCY remembers?" });
  const back = dialog.getByRole("button", { name: "Go back" });
  const erase = dialog.getByRole("button", { name: "Yes, erase everything" });
  await expect(back).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(erase).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(back).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator(".choice:not(.choice-danger)")).not.toHaveCount(0);
});

test("Talk approval traps keyboard focus and keeps its deliberate approval delay", async ({ page }) => {
  await page.goto("/#/talk/call");
  await page.locator(".talk-tiles .tile").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const back = dialog.getByRole("button", { name: "No, don't" });
  const call = dialog.getByRole("button", { name: "Call now" });
  await expect(back).toBeFocused();
  await expect(call).toBeDisabled();
  await page.keyboard.press("Tab");
  await expect(back).toBeFocused();
  await expect(call).toBeEnabled();
  await page.keyboard.press("Shift+Tab");
  await expect(call).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(back).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
