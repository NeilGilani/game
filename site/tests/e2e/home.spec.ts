// The home page's "Try it here" demo: look and hold, tried with a mouse, a keyboard or a tap.
import { expect, test } from "@playwright/test";
import { mockGitHub } from "./fixtures";

const said = (page: import("@playwright/test").Page) => page.locator("[data-dwell-out] .dd-said");

test("resting the pointer on a phrase fills its ring and chooses it; moving away chooses nothing", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "needs a mouse");
  await mockGitHub(page, { status: 404 });
  await page.goto("#how");
  const word = page.locator(".dd-word", { hasText: "Thank you" });
  await word.scrollIntoViewIfNeeded();

  // A short rest, then away: the ring starts, empties, and nothing is chosen.
  await word.hover();
  await expect(word).toHaveAttribute("data-dwelling", "");
  await page.waitForTimeout(500);
  await page.mouse.move(5, 5);
  await expect(word).not.toHaveAttribute("data-dwelling", "");
  await page.waitForTimeout(1000);
  await expect(said(page)).toHaveCount(0);

  // A full rest (AGENCY's 1.2 s dwell): chosen, without a click.
  await word.hover();
  await expect(said(page)).toHaveText("“Thank you.”", { timeout: 3000 });
});

test("a phrase can be chosen straight away with the keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard test runs on desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockGitHub(page, { status: 404 });
  await page.goto("#how");
  await page.locator(".dd-word", { hasText: "I love you" }).focus();
  await page.keyboard.press("Enter");
  await expect(said(page)).toHaveText("“I love you.”");
});

test("a tap chooses a phrase on a phone", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "touch only");
  await mockGitHub(page, { status: 404 });
  await page.goto("#how");
  await page.locator(".dd-word", { hasText: "Yes" }).tap();
  await expect(said(page)).toHaveText("“Yes.”");
});

test("the video never plays by itself, and a chapter button plays it from that moment", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await mockGitHub(page, { status: 404 });
  await page.goto("#demo");
  const video = page.locator("#demo-video");
  await expect(video).toHaveAttribute("preload", "none");
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused && !v.autoplay)).toBe(true);
  await page.getByRole("button", { name: /Say a sentence out loud/ }).click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 5000 })
    .toBeGreaterThanOrEqual(36);
});
