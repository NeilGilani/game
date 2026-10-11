import { expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.fakes", "memory,agent,native");
    localStorage.setItem("agency.preferences", JSON.stringify({ reduced_motion: true }));
  });
});

test("desktop menus navigate, dismiss with Escape and keep the Dock current", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.locator(".home-titlebar")).toBeVisible();
  expect(await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    "radial-gradient",
  );
  const dock = page.locator(".dock");
  await expect(dock.getByRole("button", { name: "Home", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const view = page.getByRole("button", { name: "View", exact: true });
  await view.click();
  await expect(view).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(view).toBeFocused();
  await expect(view).toHaveAttribute("aria-expanded", "false");
  await view.click();
  await page.locator(".desktop-menu-popover").getByRole("link", { name: "Talk", exact: true }).click();
  await expect(page).toHaveURL(/#\/talk$/);
  await expect(dock.getByRole("button", { name: "Talk", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(dock.getByRole("button", { name: "Home", exact: true })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator(".desktop-menu-popover")).toHaveCount(0);
});

test("all Settings remain reachable through large, paged choices", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/settings");
  await expect(page.locator(".flow-options .choice")).toHaveCount(5);
  await expect(page.getByRole("button", { name: /Lifeline.*Contacts/ })).toBeVisible();
  await page.getByRole("button", { name: "More settings" }).click();
  await expect(page.locator(".flow-options .choice")).toHaveCount(1);
  await page.getByRole("button", { name: "Previous settings" }).click();
  await expect(page.locator(".flow-options .choice")).toHaveCount(5);
  await page.getByRole("button", { name: "More settings" }).click();
  await page.getByRole("button", { name: /For a helper.*Connection/ }).click();
  await expect(page).toHaveURL(/#\/settings\/helper$/);
});

test("a short MacBook keeps word-board paging visible and functional", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/talk");
  await expect(page.locator(".talk-words button")).toHaveCount(6);
  const next = page.getByRole("button", { name: "Next", exact: true });
  const box = await next.boundingBox();
  const main = await page.locator("#main").boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(main!.y + main!.height);
  await next.click();
  await expect(page.locator(".talk-pager-count")).toContainText("page 2");
  await expect(page.locator(".talk-words button")).toHaveCount(6);
});

for (const size of [
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test(`Home choices stay readable and reachable at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/#/");
    await expect(page.locator(".home-usuals .usual-placeholder")).toHaveCount(0);
    await expect(page.locator(".home-tile")).toHaveCount(12);
    for (const tile of await page.locator(".home-tile").all()) {
      await tile.scrollIntoViewIfNeeded();
      const box = await tile.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(120);
      expect(box!.height).toBeGreaterThanOrEqual(120);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
      await expect(tile.locator(".home-tile-label")).toBeVisible();
    }
    for (const button of await page.locator(".dock button").all()) {
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(96);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
    await page.getByRole("button", { name: "Settings: Eyes, voice, memory" }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    await page.goto("/#/apps?view=all");
    await expect(page.locator(".app-tile")).toHaveCount(8);
    const appLayout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      gap:
        document.querySelector(".apps-flow .flow-bar")!.getBoundingClientRect().top -
        Array.from(document.querySelectorAll(".app-tile")).at(-1)!.getBoundingClientRect().bottom,
    }));
    expect(appLayout.width).toBeLessThanOrEqual(size.width);
    expect(appLayout.gap).toBeGreaterThanOrEqual(23.5);
  });
}
