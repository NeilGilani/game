/**
 * Eye control end to end and hands-free: calibration, then choosing things by looking, through the
 * real gaze engine (os/gaze) in the browser. The person is SIMULATED (src/vision/synthetic.ts): a
 * geometric face rendering MediaPipe-shaped landmarks with webcam-like noise, looking where the test
 * says. This proves the app's wiring and the engine. It is not a measurement of a real person's
 * accuracy: real faces, cameras and light add error the model doesn't have.
 */
import { type Page, expect, test } from "@playwright/test";
import {
  type CursorSample,
  type Interval,
  type LookedAt,
  cursorMetrics,
} from "../../os/gaze/bench/cursorMetrics";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.testHooks", "1");
    // Calibrated eye gaze, chosen by the person: the one-time move to the eye cursor (now the default) is done.
    localStorage.setItem("agency.eyeCursorDefault.v1", "1");
    localStorage.setItem("agency.gazeChosen", "1");
    localStorage.setItem(
      "agency.preferences",
      JSON.stringify({ input_mode: "gaze", show_gaze_cursor: true }),
    );
  });
});

type Point = { x: number; y: number };
interface Hook {
  eyes: (options?: { seed?: number; head?: "still" | "natural"; lagMs?: number }) => Promise<void>;
  lookAt: (target: string | Point) => void;
  closeEyes: (ms: number) => void;
  pointer: () => Point | null;
}

const lookAt = (page: Page, target: string | Point) =>
  page.evaluate((t) => (window as unknown as { __agency: Hook }).__agency.lookAt(t), target);

/** Mean distance (px) between the pointer and points the simulated person looks at. */
async function pointerError(page: Page, points: Point[]): Promise<number> {
  const errors: number[] = [];
  for (const p of points) {
    await lookAt(page, p);
    await page.waitForTimeout(400); // the eyes land and the fixation settles
    const seen = await page.evaluate(async () => {
      const hook = (window as unknown as { __agency: Hook }).__agency;
      const out: Point[] = [];
      for (let i = 0; i < 10; i++) {
        const q = hook.pointer();
        if (q) out.push(q);
        await new Promise((r) => setTimeout(r, 33));
      }
      return out;
    });
    for (const q of seen) errors.push(Math.hypot(q.x - p.x, q.y - p.y));
  }
  expect(errors.length).toBeGreaterThan(points.length * 6);
  return errors.reduce((a, b) => a + b, 0) / errors.length;
}

test("5-second eye scan, then choose with the eyes alone (simulated person, real engine)", async ({
  page,
}) => {
  await page.goto("/#/calibrate");
  await page.evaluate(() =>
    (window as unknown as { __agency: Hook }).__agency.eyes({ seed: 3, head: "still" }),
  );

  // The simulated person follows the eye scan's light, then the check dots. Nothing is clicked; it
  // ends on Home by itself.
  await lookAt(page, ".cal-target");
  await expect(page.getByText(/Starting in \d/)).toBeVisible();
  await expect(page.getByText(/Follow the light/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/#\/$/, { timeout: 30_000 });
  // Home says which eye model the pointer uses (the simulated person has landmarks, no eye images).
  await expect(
    page.getByRole("status").filter({ hasText: "Eye scan done. Eye model: Face points only" }),
  ).toBeVisible();
  // ...and the error the three check dots after the glide measured, not just the scan's estimate.
  await expect(page.getByRole("status").filter({ hasText: "Eye scan done" })).toContainText(
    /Measured error about \d+ px.* on 3 check dots/,
  );

  const size = page.viewportSize()!;
  const error = await pointerError(page, [
    { x: size.width * 0.25, y: size.height * 0.3 },
    { x: size.width * 0.75, y: size.height * 0.3 },
    { x: size.width * 0.5, y: size.height * 0.55 },
    { x: size.width * 0.3, y: size.height * 0.75 },
    { x: size.width * 0.7, y: size.height * 0.75 },
  ]);
  console.log(`Simulated person, pointer error after the 5-second eye scan: ${Math.round(error)} px mean`);
  expect(error).toBeLessThan(130);

  // Choose a Home tile by looking at it, then another.
  await lookAt(page, '[data-tile="talk"]');
  await expect(page).toHaveURL(/#\/talk/, { timeout: 15_000 });
});

/**
 * The cursor as drawn: every animation frame, read the cursor element's computed position (what the
 * screen shows, CSS transitions included) while the simulated person looks at a series of points
 * and blinks once. Definitions: os/gaze/bench/cursorMetrics.ts. SIMULATED person, real browser.
 */
async function measureDrawnCursor(page: Page, points: Point[], dwellMs: number, blinkAt: number) {
  return page.evaluate(
    async ({ points, dwellMs, blinkAt }) => {
      const hook = (window as unknown as { __agency: Hook }).__agency;
      const el = document.querySelector<HTMLElement>(".gaze-cursor")!;
      const drawn: CursorSample[] = [];
      let on = true;
      const sample = (t: number) => {
        const style = getComputedStyle(el);
        if (Number(style.opacity) > 0) {
          const m = new DOMMatrixReadOnly(style.transform);
          drawn.push({ t, x: m.m41, y: m.m42 });
        }
        if (on) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const looks: LookedAt[] = [];
      const blinks: Interval[] = [];
      for (let i = 0; i < points.length; i++) {
        const p = points[i]!;
        hook.lookAt(p);
        const start = performance.now();
        if (i === blinkAt) {
          await sleep(dwellMs / 2);
          hook.closeEyes(200);
          blinks.push({ start: performance.now(), end: performance.now() + 200 });
          await sleep(dwellMs / 2);
        } else {
          await sleep(dwellMs);
        }
        looks.push({ x: p.x, y: p.y, start, end: performance.now() });
      }
      on = false;
      return { drawn, looks, blinks };
    },
    { points, dwellMs, blinkAt },
  );
}

test("the drawn cursor: jitter, lag and accuracy (simulated person, real browser)", async ({
  page,
  context,
}) => {
  // A dwell long enough that looking around Home never selects anything mid-measurement.
  await context.addInitScript(() =>
    localStorage.setItem(
      "agency.preferences",
      JSON.stringify({ input_mode: "gaze", show_gaze_cursor: true, dwell_ms: 60_000 }),
    ),
  );
  await page.goto("/#/calibrate");
  // No pursuit lag: the eyes jump the moment lookAt is called, so lag is measured from then.
  await page.evaluate(() =>
    (window as unknown as { __agency: Hook }).__agency.eyes({ seed: 3, head: "still", lagMs: 0 }),
  );
  await lookAt(page, ".cal-target");
  await expect(page).toHaveURL(/#\/$/, { timeout: 45_000 });
  await page.waitForTimeout(1500); // the pause after the scan ends
  // Measure the pointer itself: with no targets to lock onto, the cursor is never pinned to a
  // target's centre (selection lock), so what's drawn is the gaze cursor alone.
  await page.evaluate(() =>
    document.querySelectorAll("[data-dwell]").forEach((el) => el.setAttribute("inert", "")),
  );
  await page.waitForTimeout(500);

  const { width: w, height: h } = page.viewportSize()!;
  const points = [
    { x: w * 0.2, y: h * 0.25 },
    { x: w * 0.8, y: h * 0.3 },
    { x: w * 0.35, y: h * 0.7 },
    { x: w * 0.7, y: h * 0.75 },
    { x: w * 0.5, y: h * 0.45 },
    { x: w * 0.15, y: h * 0.6 },
    { x: w * 0.85, y: h * 0.55 },
    { x: w * 0.45, y: h * 0.2 },
    { x: w * 0.8, y: h * 0.8 },
    { x: w * 0.25, y: h * 0.45 },
    { x: w * 0.6, y: h * 0.25 },
    { x: w * 0.2, y: h * 0.8 },
    { x: w * 0.75, y: h * 0.5 },
    { x: w * 0.4, y: h * 0.6 },
  ];
  const run = await measureDrawnCursor(page, points, 1500, 4);
  const m = cursorMetrics(run.drawn, run.looks, run.blinks);
  console.log(
    `Simulated person, drawn cursor: jitter ${m.jitterPx.toFixed(1)} px RMS, step ${m.stepPx.toFixed(1)} px/frame, ` +
      `lag ${Math.round(m.lagMs)} ms (median of ${m.saccades}), accuracy ${Math.round(m.accuracyPx)} px, ` +
      `blink move ${Math.round(m.blinkMovePx)} px (${Math.round(m.closedMovePx)} px while closed), drawn at ${Math.round(m.drawnFps)} fps`,
  );
  console.log(`Lag per saccade (ms): ${m.lags.join(" ")}`);
  expect(m.fixations).toBeGreaterThanOrEqual(6);
  expect(m.saccades).toBeGreaterThanOrEqual(6);
  expect(m.accuracyPx).toBeLessThan(130);
  // The cursor glides every display frame (the old camera-frame drawing measured 9.6 to 13 px a
  // frame here), never moves on blink frames, and lands after a saccade.
  expect(m.drawnFps).toBeGreaterThan(45);
  expect(m.stepPx).toBeLessThan(8);
  expect(m.closedMovePx).toBeLessThan(15);
  expect(m.lagMs).toBeLessThan(600);
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

test("eye gaze without a calibration starts the eye scan by itself (simulated person)", async ({ page }) => {
  await page.goto("/#/");
  await page.evaluate(() =>
    (window as unknown as { __agency: Hook }).__agency.eyes({ seed: 3, head: "still" }),
  );
  await expect(page).toHaveURL(/#\/calibrate/, { timeout: 10_000 });
  await expect(page.getByText(/Starting in \d/)).toBeVisible();
});
