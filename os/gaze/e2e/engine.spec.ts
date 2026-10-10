/**
 * The gaze engine end to end in Chromium: real camera API (fed by a FAKE video of a still sample
 * portrait), real MediaPipe Face Landmarker, real WebcamProvider and GazeEngine. Proves the
 * pipeline runs in a browser window (as in AGENCY OS's hidden engine window) and measures speed
 * on the machine running the test. It cannot measure gaze accuracy: the video is a photo.
 * Results are written to bench/results/browser-<delegate>.json.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FAKE_VIDEO } from "../playwright.config";

test.skip(
  !existsSync(FAKE_VIDEO),
  "Fake webcam fixture missing: run `make e2e-fixtures` (needs network + Pillow).",
);

test("keeps processing frames with the timer scheduler (what a hidden engine window uses)", async ({
  page,
}) => {
  await page.goto(`/?delegate=GPU&seconds=6&fps=30&scheduler=timer`);
  const handle = await page.waitForFunction(() => window.__bench, null, { timeout: 120_000 });
  const result = (await handle.jsonValue()) as Record<string, unknown>;
  writeFileSync(
    join(import.meta.dirname, "..", "bench", "results", "browser-timer.json"),
    JSON.stringify({ ...result, ranAt: new Date().toISOString() }, null, 2),
  );
  console.log("timer", JSON.stringify(result));
  expect(result.error).toBeUndefined();
  expect(result.faceFraction as number).toBeGreaterThan(0.9);
  expect(result.fps as number).toBeGreaterThan(15);
});

test("keeps getting fresh frames after the camera preview is removed from the page", async ({ page }) => {
  // Browsers pause a video element removed from the document; the engine must resume it, or gaze
  // and Lifeline's blink detection would stop when the person leaves the camera screen.
  await page.goto(`/?delegate=CPU&seconds=5&fps=30&detach=1`);
  const handle = await page.waitForFunction(() => window.__bench, null, { timeout: 120_000 });
  const result = (await handle.jsonValue()) as Record<string, unknown>;
  console.log("detach", JSON.stringify(result));
  expect(result.error).toBeUndefined();
  expect(result.videoPausedAtEnd).toBe(false);
  expect(result.fps as number).toBeGreaterThan(15);
  expect(result.faceFraction as number).toBeGreaterThan(0.9);
});

for (const delegate of ["GPU", "CPU"] as const) {
  test(`runs the engine on the fake camera with the ${delegate} delegate`, async ({ page }) => {
    const seconds = Number(process.env.BENCH_SECONDS ?? 10);
    await page.goto(`/?delegate=${delegate}&seconds=${seconds}&fps=30`);
    const handle = await page.waitForFunction(() => window.__bench, null, { timeout: 120_000 });
    const result = (await handle.jsonValue()) as Record<string, unknown>;
    const dir = join(import.meta.dirname, "..", "bench", "results");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `browser-${delegate}.json`),
      JSON.stringify(
        { ...result, ranAt: new Date().toISOString(), host: process.platform + " " + process.arch },
        null,
        2,
      ),
    );
    console.log(delegate, JSON.stringify(result));
    if (delegate === "GPU" && result.error)
      test.skip(true, `GPU delegate unavailable here: ${String(result.error)}`);
    expect(result.error).toBeUndefined();
    expect(result.delegate).toBe(delegate);
    // The portrait is found in nearly every frame.
    expect(result.faceFraction as number).toBeGreaterThan(0.9);
    expect(result.blinkEvents as number).toBeGreaterThan(0);
    expect(result.fps as number).toBeGreaterThan(5);
  });
}
