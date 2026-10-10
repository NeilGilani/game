/** Screenshots of every Talk screen at 1440x900 and 1280x800, plus the target-size rule. */
import { expect, smallTargets, test } from "./fixtures";

const SCREENS = [
  "talk",
  "talk/phrases",
  "talk/phrases/needs",
  "talk/listen",
  "talk/history",
  "talk/voice",
  "talk/emergency",
  "talk/call",
  "talk/papers",
  "talk/shop",
];

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  test(`screens at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    for (const s of SCREENS) {
      await page.goto(`/#/${s}`);
      await expect(page.locator("main .page")).toBeVisible();
      await page.screenshot({
        path: `../test-results/screens/${size.width}/${s.replace(/\//g, "_")}.png`,
        fullPage: false,
      });
      expect(await smallTargets(page), s).toEqual([]);
      // Nothing scrolls: the page fits the viewport.
      const overflow = await page.evaluate(() => {
        const m = document.getElementById("main")!;
        return m.scrollHeight - m.clientHeight;
      });
      expect(overflow, `${s} scrolls by ${overflow}px`).toBeLessThanOrEqual(4);
    }
  });
}
