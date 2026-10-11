/**
 * Review screenshots of the overlay over the fake desktop, following docs/os/DESIGN.md's convention:
 * `DESIGN_SHOTS=after npx playwright test e2e/screenshots.spec.ts` writes docs/os/design/after/<scheme>-overlay-*.png.
 * Skipped unless DESIGN_SHOTS is set, so CI never writes files.
 */
import { test, type Page } from "@playwright/test";

const phase = process.env.DESIGN_SHOTS;
const dir = `../../docs/os/design/${phase}`;
test.skip(!phase, "set DESIGN_SHOTS=before or after to capture design screenshots");

async function dwell(page: Page, selector: string, ms = 1700) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`not visible: ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.waitForTimeout(ms);
}

async function rest(page: Page) {
  await page.mouse.move(700, 120, { steps: 2 });
  await page.waitForTimeout(500);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test(`overlay screens (${scheme})`, async ({ page }) => {
      // Wait out the open/launch motion (at most --dur-slow, 350 ms) so every shot shows the settled screen.
      const shot = async (name: string) => {
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${dir}/${scheme}-overlay-${name}.png` });
      };
      await page.goto("/");
      await page.mouse.move(700, 120);
      await page.waitForTimeout(400);
      await shot("1-rail");
      await dwell(page, '[data-label="Reply all"]');
      await shot("2-which-one");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await rest(page);
      await dwell(page, '[data-label="To"]');
      await rest(page);
      await shot("3-keyboard");
      await page.getByRole("button", { name: "Hide keyboard" }).click();
      await page.getByRole("button", { name: "More", exact: true }).click();
      await shot("4-more");
      await page.getByRole("button", { name: /^Numbers/ }).click();
      await shot("5-numbers");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Pause eyes", exact: true }).click();
      await rest(page);
      await shot("6-paused");
    });
  });
}
