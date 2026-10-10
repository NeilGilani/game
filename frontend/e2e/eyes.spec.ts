/**
 * Eye control end to end and hands-free: calibration, then choosing things by looking, through the
 * real gaze engine (os/gaze) in the browser. The person is SIMULATED (src/vision/synthetic.ts): a
 * geometric face rendering MediaPipe-shaped landmarks with webcam-like noise, looking where the test
 * says. This proves the app's wiring and the engine. It is not a measurement of a real person's
 * accuracy: real faces, cameras and light add error the model doesn't have.
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
      JSON.stringify({ input_mode: "gaze", show_gaze_cursor: true }),
    );
  });
});

type Point = { x: number; y: number };
interface Hook {
  eyes: (options?: { seed?: number; head?: "still" | "natural" }) => Promise<void>;
  lookAt: (target: string | Point) => void;
  pointer: () => Point | null;
}

const lookAt = (page: Page, target: string | Point) =>
  page.evaluate((t) => (window as unknown as { __agency: Hook }).__agency.lookAt(t), target);

/** Mean distance (px) between the pointer and points the simulated person looks at. */
async function pointerError(page: Page, points: Point[]): Promise<number> {
  const errors: number[] = [];
  for (const p of points) {
    await lookAt(page, p);
    await page.waitForTimeout(700); // the eyes land and the fixation settles
    const seen = await page.evaluate(async () => {
      const hook = (window as unknown as { __agency: Hook }).__agency;
      const out: Point[] = [];
      for (let i = 0; i < 15; i++) {
        const q = hook.pointer();
        if (q) out.push(q);
        await new Promise((r) => setTimeout(r, 33));
      }
      return out;
    });
    for (const q of seen) errors.push(Math.hypot(q.x - p.x, q.y - p.y));
  }
  expect(errors.length).toBeGreaterThan(points.length * 10);
  return errors.reduce((a, b) => a + b, 0) / errors.length;
}

test("calibrate, then choose with the eyes alone (simulated person, real engine)", async ({ page }) => {
  await page.goto("/#/calibrate");
  await page.evaluate(() =>
    (window as unknown as { __agency: Hook }).__agency.eyes({ seed: 3, head: "still" }),
  );

  // The simulated person follows each calibration dot. Nothing is clicked.
  await lookAt(page, ".cal-target");
  await expect(page.getByText(/Starting in \d/)).toBeVisible();
  await expect(page.getByText(/Dot 1 of \d+/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: /Accuracy: (good|fair)/ })).toBeVisible({
    timeout: 120_000,
  });

  const size = page.viewportSize()!;
  const error = await pointerError(page, [
    { x: size.width * 0.25, y: size.height * 0.3 },
    { x: size.width * 0.75, y: size.height * 0.3 },
    { x: size.width * 0.5, y: size.height * 0.55 },
    { x: size.width * 0.3, y: size.height * 0.75 },
    { x: size.width * 0.7, y: size.height * 0.75 },
  ]);
  console.log(`Simulated person, pointer error after calibration: ${Math.round(error)} px mean`);
  expect(error).toBeLessThan(130);

  // Hands-free from here: look at "Use this calibration" until the dwell selects it.
  const use = (await page.getByRole("button", { name: /Use this calibration/ }).boundingBox())!;
  await lookAt(page, { x: use.x + use.width / 2, y: use.y + use.height / 2 });
  await expect(page).toHaveURL(/#\/$/, { timeout: 30_000 });

  // Choose a Home tile by looking at it, then another.
  await lookAt(page, '[data-tile="talk"]');
  await expect(page).toHaveURL(/#\/talk/, { timeout: 15_000 });
});

test("the head pointer works without any calibration (simulated person)", async ({ page, context }) => {
  await context.addInitScript(() =>
    localStorage.setItem(
      "agency.preferences",
      JSON.stringify({ input_mode: "head", show_gaze_cursor: true }),
    ),
  );
  await page.goto("/#/");
  await page.evaluate(() =>
    (window as unknown as { __agency: Hook }).__agency.eyes({ seed: 5, head: "still" }),
  );
  await expect(page.getByText(/needs calibration/)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __agency: Hook }).__agency.pointer()), {
      timeout: 10_000,
    })
    .not.toBeNull();
});
