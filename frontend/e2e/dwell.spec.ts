/**
 * Dwell selection through the real interface wiring (target lookup, dwell engine,
 * feedback, click). Pointer positions are SYNTHETIC frames injected through a test hook,
 * standing in for calibrated gaze; the camera itself is covered by camera.spec.ts.
 */
import { type Page, expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.testHooks", "1");
    localStorage.setItem(
      "agency.preferences",
      JSON.stringify({ input_mode: "gaze", dwell_ms: 1000, show_gaze_cursor: true }),
    );
  });
});

/** Hold a synthetic gaze point on an element's centre for `ms`, at ~30 frames per second. */
async function gazeAt(page: Page, selector: ReturnType<Page["locator"]>, ms: number) {
  const box = (await selector.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(
    async ({ x, y, ms }) => {
      const hook = (window as unknown as { __agency: { inject: (f: object) => void } }).__agency;
      const end = performance.now() + ms;
      while (performance.now() < end) {
        hook.inject({ pointer: { x, y }, confidence: 1 });
        await new Promise((r) => setTimeout(r, 33));
      }
    },
    { x, y, ms },
  );
}

test("holding gaze on a button selects it once; a brief glance does not", async ({ page }) => {
  await page.goto("/#/");
  const start = page.getByRole("button", { name: /Start a task/ });
  await expect(start).toBeVisible();
  await page.waitForTimeout(1500); // initial refractory after navigation

  await gazeAt(page, start, 400);
  await expect(page).toHaveURL(/#\/$/);

  await gazeAt(page, start, 1600);
  await expect(page).toHaveURL(/#\/new$/);
});

test("low tracking confidence pauses dwell instead of selecting", async ({ page }) => {
  await page.goto("/#/");
  const start = page.getByRole("button", { name: /Start a task/ });
  await page.waitForTimeout(1500);
  const box = (await start.boundingBox())!;
  await page.evaluate(
    async ({ x, y }) => {
      const hook = (window as unknown as { __agency: { inject: (f: object) => void } }).__agency;
      const end = performance.now() + 2500;
      while (performance.now() < end) {
        hook.inject({ pointer: { x, y }, confidence: 0.2 });
        await new Promise((r) => setTimeout(r, 33));
      }
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  await expect(page).toHaveURL(/#\/$/);
  await expect(start).not.toHaveAttribute("data-dwell-active", "");
});
