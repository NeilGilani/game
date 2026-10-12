/**
 * The real camera pipeline (MediaPipe Face Landmarker in the browser) fed with a FAKE
 * webcam: a still sample portrait played by Chromium. This proves camera start-up, model
 * loading, landmark/iris extraction and calibration quality reporting run end to end.
 * It does not (and cannot) prove gaze accuracy for a real person; that needs live testing.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const video = resolve(import.meta.dirname, "fixtures", ".cache", "face.y4m");
const coordinator = new Coordinator();

test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

test.use({
  launchOptions: {
    executablePath: existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${video}`,
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  },
});

test.describe("with a fake webcam", () => {
  test.skip(
    !existsSync(video),
    "Fake webcam fixture missing: run `make e2e-fixtures` (needs network + Pillow).",
  );

  test("finds the face and irises, then reports honest calibration quality", async ({ page, context }) => {
    await context.addInitScript(() => {
      localStorage.removeItem("agency.onboarded");
      localStorage.setItem("agency.testHooks", "1");
    });
    await page.goto("/#/");
    await expect(page).toHaveURL(/#\/welcome/);
    await page.getByRole("radio", { name: /Eye gaze/ }).click();
    await expect(page).toHaveURL(/#\/camera/);
    await page.getByRole("button", { name: /Start camera/ }).click();
    const checks = page.locator(".checklist");
    await expect(checks.locator("li", { hasText: "Face in view" })).toContainText("OK", { timeout: 90_000 });
    await expect(checks.locator("li", { hasText: "Both eyes and irises found" })).toContainText("OK");
    // RealEye's eye-image features are read from the same frames (os/gaze/src/eyeImage.ts).
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __agency: { eyeFeatures(): number } }).__agency.eyeFeatures(),
        ),
      )
      .toBe(1630);
    await expect(page.getByText(/Tracking confidence \d+%/)).toBeVisible();
    await expect(page.getByText(/Eye gaze \(calibrated\) · needs calibration/)).toBeVisible();

    // The 5-second eye scan starts by itself after a countdown (no click needed for eye-only users).
    await page.getByRole("button", { name: /Calibrate now/ }).click();
    await expect(page.getByText(/Starting in \d/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Follow the light/).first()).toBeVisible({ timeout: 20_000 });
    // A still photo can't follow the light, so the result is honest: a poor scan or a request to try again.
    await expect(
      page
        .getByText(/The eye scan didn't work/)
        .or(page.getByRole("heading", { name: /Tracking is rough/ }))
        .or(page.getByRole("navigation", { name: /Everything you can do/ })),
    ).toBeVisible({ timeout: 60_000 });
  });
});
