/**
 * Eye control that uses the task context (input/context.ts, os/gaze/src/input/intent.ts) and the Gaze lab,
 * through the real interface wiring in Chromium.
 *
 * Pointer positions are SYNTHETIC: injected frames (the context and layout tests) or a simulated person
 * driving the real gaze engine (the lab test, src/vision/synthetic.ts). This proves the wiring. It is not a
 * measurement of a real person: that is what the Gaze lab is for, on a real camera.
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
    localStorage.setItem("agency.fakes", "memory,agent,native");
    localStorage.setItem(
      "agency.preferences",
      JSON.stringify({ input_mode: "gaze", dwell_ms: 1000, show_gaze_cursor: true }),
    );
  });
});

type Point = { x: number; y: number };
interface Hook {
  inject: (f: object) => void;
  eyes: (options?: { seed?: number; head?: "still" | "natural" }) => Promise<void>;
  lookAt: (target: string | Point) => void;
}

/** Hold a synthetic pointer at (x, y) with this error radius for `ms`, at ~30 frames per second. */
async function hold(page: Page, p: Point, errorRadius: number, ms: number) {
  await page.evaluate(
    async ({ p, errorRadius, ms }) => {
      const hook = (window as unknown as { __agency: Hook }).__agency;
      const end = performance.now() + ms;
      while (performance.now() < end) {
        hook.inject({ pointer: p, raw: p, confidence: 1, errorRadius });
        await new Promise((r) => setTimeout(r, 33));
      }
    },
    { p, errorRadius, ms },
  );
}

const pick = (page: Page, name: string) => page.getByRole("button", { name, exact: false }).first().click();

/** Start a food task and pause it: "Carry on" (what the paused agent waits for) sits next to "Home". */
async function pausedTask(page: Page) {
  await page.evaluate(() => localStorage.setItem("agency.fakeAgentDelayMs", "4000"));
  await page.goto("/#/flow/food");
  await pick(page, "Thai");
  await pick(page, "Pad thai");
  await pick(page, "As soon as possible");
  await page.getByRole("button", { name: "Pause" }).click();
  const carryOn = page.getByRole("button", { name: "Carry on" });
  const home = page.locator(".task-now").getByRole("button", { name: "Home" });
  await expect(carryOn).toBeVisible();
  await expect(carryOn).toHaveAttribute("data-likely", "strong");
  await expect(home).not.toHaveAttribute("data-likely", /.*/);
  const a = (await carryOn.boundingBox())!;
  const b = (await home.boundingBox())!;
  expect(b.x).toBeGreaterThan(a.x + a.width); // side by side
  // In the gap, 60 % of the way across: nearer Home.
  const gap = b.x - (a.x + a.width);
  return { x: a.x + a.width + 0.6 * gap, y: a.y + a.height / 2, gap };
}

test("rough tracking: a gaze between two buttons goes to the one the paused task is waiting for", async ({
  page,
}) => {
  await page.goto("/#/");
  const p = await pausedTask(page);
  await page.waitForTimeout(1300); // selection pause after the screen changed
  await hold(page, p, 120, 1800);
  await expect(page.getByRole("heading", { name: /Working on it/ })).toBeVisible();
});

test("sharp tracking: the same gaze goes to the nearer button; the eyes decide", async ({ page }) => {
  await page.goto("/#/");
  const p = await pausedTask(page);
  await page.waitForTimeout(1300);
  await hold(page, p, 10, 1800);
  await expect(page).toHaveURL(/#\/$/);
});

test("adaptive layout: rough tracking gives bigger, fewer choices on the next screen", async ({ page }) => {
  await page.goto("/#/flow/food");
  await expect(page.locator("html")).toHaveAttribute("data-gaze-precision", "normal");
  await expect(page.locator(".flow-options")).toHaveAttribute("data-count", "4");
  // Rough tracking for a few seconds, looking at empty space (no selection).
  await hold(page, { x: 5, y: 5 }, 220, 4500);
  // Nothing moved under the eyes: the layout waits for the next screen.
  await expect(page.locator("html")).toHaveAttribute("data-gaze-precision", "normal");
  await page.goto("/#/flow/watch");
  await expect(page.locator("html")).toHaveAttribute("data-gaze-precision", "rough");
  const count = Number(await page.locator(".flow-options").getAttribute("data-count"));
  expect(count).toBeLessThanOrEqual(4);
});

test("Gaze lab: 9-dot test on a simulated person, measured numbers, anonymous export", async ({ page }) => {
  // Calibrate the simulated person with the real 5-second eye scan first.
  await page.goto("/#/calibrate");
  await page.evaluate(() =>
    (window as unknown as { __agency: Hook }).__agency.eyes({ seed: 3, head: "still" }),
  );
  await page.evaluate(() => (window as unknown as { __agency: Hook }).__agency.lookAt(".cal-target"));
  await expect(page).toHaveURL(/#\/$/, { timeout: 40_000 });

  await page.goto("/#/settings/gaze-lab");
  await expect(page.getByRole("heading", { name: "How well do your eyes control AGENCY?" })).toBeVisible();
  // The person looks wherever the lab's dot is.
  await page.evaluate(() => (window as unknown as { __agency: Hook }).__agency.lookAt(".cal-target"));
  await page.getByRole("button", { name: "Start the 9-dot test" }).click();
  await expect(page.getByText(/Look at the dot · 1 of 9/)).toBeVisible();
  const table = page.getByRole("table", { name: "Measured on you" });
  await expect(table).toBeVisible({ timeout: 40_000 });
  const header = await table.locator("th").first().textContent();
  const measured = Number(/\((\d) of 9 dots\)/.exec(header ?? "")?.[1]);
  expect(measured).toBeGreaterThanOrEqual(7);
  const rows = await table.locator("tbody tr").allTextContents();
  console.log(`Gaze lab on a SIMULATED person (seed 3, still head):\n  ${rows.join("\n  ")}`);
  const accuracy = Number(/Accuracy[^\d]*(\d+) px/.exec(rows[0] ?? "")?.[1]);
  expect(accuracy).toBeGreaterThan(0);
  expect(accuracy).toBeLessThan(250);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Save the numbers/ }).click(),
  ]);
  const text = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
  const data = JSON.parse(text) as { kind: string; summary: { dotsMeasured: number }; dots: unknown[] };
  expect(data.kind).toBe("agency-gaze-lab");
  expect(data.summary.dotsMeasured).toBe(measured);
  expect(text).not.toMatch(/"raw"|"point"|"landmarks"|"image"|"x":|"y":/);
});
