/**
 * Every OS screen at 1440 × 900 and 1280 × 800: it fits without scrolling, every target is at least 96 px (120 px on
 * Home) and at least 24 px from its neighbours, flows offer at most 6 choices, and each theme renders. Screenshots
 * land in test-results/screens/ for review. Memory, the agent and apps are the in-page fakes.
 */
import { type Page, expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.fakes", "memory,agent,native");
    localStorage.setItem("agency.fakeAgentDelayMs", "150");
  });
});

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
];

const SCREENS: { name: string; path: string; min: number; maxChoices?: number }[] = [
  { name: "home", path: "/#/", min: 120 },
  { name: "flow-food", path: "/#/flow/food", min: 96, maxChoices: 6 },
  { name: "flow-call", path: "/#/flow/call", min: 96, maxChoices: 6 },
  { name: "flow-papers", path: "/#/flow/papers", min: 96, maxChoices: 6 },
  { name: "flow-shopping", path: "/#/flow/shopping", min: 96, maxChoices: 6 },
  { name: "flow-messages", path: "/#/flow/messages", min: 96, maxChoices: 6 },
  { name: "flow-watch", path: "/#/flow/watch", min: 96, maxChoices: 6 },
  { name: "flow-browse", path: "/#/flow/browse", min: 96, maxChoices: 6 },
  { name: "flow-apps", path: "/#/flow/apps", min: 96, maxChoices: 6 },
  { name: "apps", path: "/#/apps?view=all", min: 96 },
  { name: "settings", path: "/#/settings", min: 96, maxChoices: 6 },
  { name: "settings-voice", path: "/#/settings/voice", min: 96 },
  { name: "settings-memory", path: "/#/settings/memory", min: 96 },
  { name: "talk", path: "/#/talk", min: 96 },
  { name: "onboarding", path: "/#/onboarding", min: 96 },
];

interface Box {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The person's own targets in the page content (the top bar is checked once, separately). `clipped` is how many
 * pixels of the target are hidden by the window or by a panel that cuts off its content.
 */
async function targets(page: Page, scope: string): Promise<(Box & { clipped: number })[]> {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll<HTMLElement>(`${sel} [data-dwell]`))
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        let bottom = window.innerHeight;
        let right = window.innerWidth;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const style = getComputedStyle(p);
          if (style.overflow !== "visible" || style.overflowY !== "visible") {
            const pr = p.getBoundingClientRect();
            bottom = Math.min(bottom, pr.bottom);
            right = Math.min(right, pr.right);
          }
        }
        return {
          name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40),
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          clipped: Math.max(0, r.bottom - bottom, r.right - right),
        };
      });
  }, scope);
}

function gap(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.max(dx, dy);
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(1500); // memory's usual and the selection pause
}

for (const size of SIZES) {
  test(`OS screens fit ${size.width}×${size.height}, with big, well-spaced targets`, async ({ page }) => {
    await page.setViewportSize(size);
    for (const s of SCREENS) {
      await page.goto(s.path);
      await settle(page);
      const scroll = await page.evaluate(() => {
        const main = document.getElementById("main")!;
        return {
          main: main.scrollHeight - main.clientHeight,
          doc: document.documentElement.scrollHeight - innerHeight,
        };
      });
      expect(scroll.main, `${s.name} scrolls`).toBeLessThanOrEqual(1);
      expect(scroll.doc, `${s.name} page scrolls`).toBeLessThanOrEqual(1);

      const boxes = await targets(page, "#main");
      expect(boxes.length, s.name).toBeGreaterThan(0);
      for (const b of boxes) {
        expect(b.clipped, `${s.name}: "${b.name}" is cut off`).toBeLessThanOrEqual(1);
        expect(
          Math.min(b.w, b.h),
          `${s.name}: "${b.name}" is ${Math.round(b.w)}×${Math.round(b.h)}`,
        ).toBeGreaterThanOrEqual(s.min);
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
          expect(
            gap(boxes[i]!, boxes[j]!),
            `${s.name}: "${boxes[i]!.name}" and "${boxes[j]!.name}"`,
          ).toBeGreaterThanOrEqual(23.5);
      if (s.maxChoices) {
        const choices = await page.locator("#main .choice").count();
        expect(choices, `${s.name} choices`).toBeLessThanOrEqual(s.maxChoices);
        expect(choices, `${s.name} choices`).toBeGreaterThanOrEqual(2);
      }
      await page.screenshot({ path: `test-results/screens/${size.width}x${size.height}-${s.name}.png` });
    }
  });
}

test("the task screen and its approval fit 1280×800 and 1440×900", async ({ page }) => {
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await page.goto("/#/flow/food");
    await settle(page);
    await page.getByRole("button", { name: /Your usual: Pad thai/ }).click();
    await expect(page.getByTestId("approval")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);
    const scroll = await page.evaluate(() => {
      const main = document.getElementById("main")!;
      return main.scrollHeight - main.clientHeight;
    });
    expect(scroll).toBeLessThanOrEqual(1);
    const check = async () => {
      for (const b of await targets(page, "#main")) {
        expect(Math.min(b.w, b.h), `"${b.name}"`).toBeGreaterThanOrEqual(96);
        expect(b.clipped, `"${b.name}" is cut off at ${size.width}×${size.height}`).toBeLessThanOrEqual(1);
      }
    };
    await check();
    await page.screenshot({ path: `test-results/screens/${size.width}x${size.height}-task-approval.png` });
    await page.getByRole("button", { name: "Approve" }).click();
    await page.waitForTimeout(1700);
    await check();
    await page.screenshot({ path: `test-results/screens/${size.width}x${size.height}-task-confirm.png` });
    await page.getByRole("button", { name: /Yes, pay/ }).click();
    await expect(page.getByTestId("result")).toBeVisible({ timeout: 20_000 });
    await check();
    await page.screenshot({ path: `test-results/screens/${size.width}x${size.height}-task-result.png` });
  }
});

test("themes: light, dark and high contrast all render Home", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/");
  for (const theme of ["light", "dark", "contrast"]) {
    await page.evaluate(
      (t) => localStorage.setItem("agency.preferences", JSON.stringify({ theme: t })),
      theme,
    );
    await page.reload();
    await settle(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.screenshot({ path: `test-results/screens/theme-${theme}-home.png` });
  }
});

test("the top bar's Help and Stop are big enough everywhere", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/flow/food");
  for (const name of [/Help: call for help/, /Stop agent/]) {
    const box = (await page.getByRole("button", { name }).boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(96);
  }
});
