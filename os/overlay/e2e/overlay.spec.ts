/**
 * The overlay over a fake desktop, driven by fake gaze (the mouse). Checks the real rendered page:
 * sizes, spacing, that dwell presses app controls, the "which one?" picker, the keyboard and the
 * password refusal, Stop and Help.
 */
import { expect, test, type Page } from "@playwright/test";

interface Call {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

async function calls(page: Page): Promise<Call[]> {
  return page.evaluate(
    () => (window as unknown as { __agencyOverlay: { host: { calls: Call[] } } }).__agencyOverlay.host.calls,
  );
}

/** Rest the fake gaze at the centre of an element for `ms`. */
async function dwell(page: Page, selector: string, ms = 1700) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`not visible: ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.waitForTimeout(ms);
}

async function rest(page: Page, ms = 500) {
  await page.mouse.move(700, 120, { steps: 2 });
  await page.waitForTimeout(ms);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("overlay")).toBeVisible();
  await page.mouse.move(700, 120);
});

test("protected rail: big targets, spaced, labelled", async ({ page }) => {
  const rail = page.locator('.ov-btn[data-kind="rail"]');
  await expect(rail).toHaveCount(6);
  const boxes = await rail.evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect),
  );
  for (const b of boxes) {
    expect(b.width).toBeGreaterThanOrEqual(96);
    expect(b.height).toBeGreaterThanOrEqual(96);
  }
  for (let i = 1; i < boxes.length; i++)
    expect(boxes[i]!.top - boxes[i - 1]!.bottom).toBeGreaterThanOrEqual(24);
  for (const name of ["Help", "Stop", "Home", "Keyboard", "More", "Pause eyes"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
});

test("dwelling on a normal app button presses it with AXPress", async ({ page }) => {
  await dwell(page, '[data-label="New message"]');
  await expect(page.getByTestId("fake-log")).toContainText("Pressed “New message”");
  const press = (await calls(page)).filter((c) => c.method === "ax.press");
  expect(press).toHaveLength(1);
});

test("crowded tiny toolbar buttons get a 'Which one?' picker away from them", async ({ page }) => {
  await dwell(page, '[data-label="Reply all"]');
  const panel = page.getByTestId("panel-picker");
  await expect(panel).toBeVisible();
  expect((await calls(page)).filter((c) => c.method === "ax.press")).toHaveLength(0);
  const toolbar = await page.locator(".fake-toolbar .fake-tiny").first().boundingBox();
  const p = await panel.boundingBox();
  expect(p!.y).toBeGreaterThan(toolbar!.y + toolbar!.height);
  await page.screenshot({ path: "test-results/picker.png" });
  await rest(page);
  await dwell(page, '.ov-btn[aria-label="Forward, Button"]');
  await expect(page.getByTestId("fake-log")).toContainText("Pressed “Forward”");
});

test("keyboard opens for a text field, types and predicts", async ({ page }) => {
  await dwell(page, '[data-label="To"]');
  await expect(page.getByTestId("keyboard")).toBeVisible();
  await page.screenshot({ path: "test-results/keyboard.png" });
  await rest(page);
  await dwell(page, '.ov-btn[data-id="key:w"]');
  await rest(page);
  await dwell(page, '.ov-btn[data-id="key:a"]');
  await rest(page);
  const water = page.locator('.ov-btn[data-kind="key"]', { hasText: "water" });
  await expect(water).toBeVisible();
  await dwell(page, '.ov-btn[data-kind="key"]:has-text("water")');
  const typed = (await calls(page)).filter((c) => c.method === "input.type").map((c) => c.params?.text);
  expect(typed).toEqual(["W", "a", "ter "]);
});

test("password field: the keyboard refuses and types nothing", async ({ page }) => {
  await dwell(page, '[data-label="Password"]');
  await expect(page.getByTestId("keyboard")).toContainText("never types passwords");
  await expect(page.locator('.ov-btn[data-kind="key"]')).toHaveCount(1); // only Hide
  expect((await calls(page)).filter((c) => c.method === "input.type")).toHaveLength(0);
});

test("Stop reaches the host; Help sends a Lifeline request", async ({ page }) => {
  await dwell(page, '.ov-btn[data-id="overlay:stop"]', 1400);
  await expect(page.getByTestId("notice")).toContainText("Stopped");
  await rest(page);
  await dwell(page, '.ov-btn[data-id="overlay:help"]');
  const c = await calls(page);
  expect(c.some((x) => x.kind === "stopAll")).toBe(true);
  expect(c.find((x) => x.kind === "lifeline")?.params).toEqual({
    type: "lifeline.help",
    source: "help_button",
  });
});

test("paused: app controls don't respond, Help still does", async ({ page }) => {
  await dwell(page, '.ov-btn[data-id="overlay:pause"]');
  await expect(page.getByTestId("overlay")).toHaveAttribute("data-paused", "true");
  await rest(page);
  await dwell(page, '[data-label="New message"]', 2500);
  expect((await calls(page)).filter((c) => c.method === "ax.press")).toHaveLength(0);
  await page.screenshot({ path: "test-results/paused.png" });
  await dwell(page, '.ov-btn[data-id="overlay:help"]');
  expect((await calls(page)).some((x) => x.kind === "lifeline")).toBe(true);
});

test("numbers mode labels every control", async ({ page }) => {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: /^Numbers/ }).click();
  await expect(page.locator(".ov-badge")).toHaveCount(11);
  await page.screenshot({ path: "test-results/numbers.png" });
});

test("a helper can use the overlay with the keyboard (Tab + Enter)", async ({ page }) => {
  await page.getByRole("button", { name: "Stop", exact: true }).focus();
  await page.keyboard.press("Enter");
  expect((await calls(page)).some((x) => x.kind === "stopAll")).toBe(true);
});
