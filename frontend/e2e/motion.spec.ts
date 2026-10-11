import { expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.fakes", "memory,agent,native");
    localStorage.setItem("agency.preferences", JSON.stringify({ input_mode: "pointer" }));
  });
});

test("dock hover animates the icon while its selection target stays fixed", async ({ page }) => {
  await page.goto("/#/");
  const home = page.locator('.dock-btn[data-dock="home"]');
  const before = await home.boundingBox();
  await home.hover();
  await expect
    .poll(() => home.locator(".ico").evaluate((el) => getComputedStyle(el).transform))
    .not.toBe("none");
  expect(await home.boundingBox()).toEqual(before);
});

test("scanning keeps hover icons and selection targets stationary", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("agency.preferences", JSON.stringify({ input_mode: "scan_key" }));
  });
  await page.goto("/#/");
  await expect(page.locator(".shell")).toHaveAttribute("data-input-mode", "scan_key");
  const home = page.locator('.dock-btn[data-dock="home"]');
  await home.hover();
  await expect(home.locator(".ico")).toHaveCSS("transform", "none");
  await expect(page.locator(".home")).toHaveCSS("transform", "none");
});

for (const setting of ["system", "app"]) {
  test(`${setting} reduced motion disables screen and hover motion`, async ({ page }) => {
    if (setting === "system") await page.emulateMedia({ reducedMotion: "reduce" });
    else
      await page.addInitScript(() => {
        localStorage.setItem("agency.preferences", JSON.stringify({ reduced_motion: true }));
      });
    await page.goto("/#/");
    const home = page.locator('.dock-btn[data-dock="home"]');
    await home.hover();
    await expect(home.locator(".ico")).toHaveCSS("transform", "none");
    await page.evaluate(() => {
      window.location.hash = "/talk";
    });
    await expect(page.locator(".talk-board")).toBeVisible();
    expect(await page.locator(".talk-page").evaluate((el) => el.getAnimations().length)).toBe(0);
  });
}

test("query navigation preserves the Talk draft and cancels interrupted screen animations", async ({
  page,
}) => {
  await page.goto("/#/talk");
  await page.locator(".talk-words").getByRole("button", { name: "I", exact: true }).click();
  const message = page.getByLabel("Your message", { exact: true });
  await expect(message).toHaveText("I");
  await page.evaluate(async () => {
    window.location.hash = "/talk?view=first";
    await new Promise((resolve) => setTimeout(resolve, 40));
    window.location.hash = "/talk?view=second";
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  await expect(message).toHaveText("I");
  const screen = page.locator(".talk-page");
  expect(await screen.evaluate((el) => el.getAnimations().length)).toBe(1);
  await expect.poll(() => screen.evaluate((el) => el.getAnimations().length)).toBe(0);
});
