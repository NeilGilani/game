import { test as base, expect, type Locator, type Page } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, provide) => {
    await page.addInitScript(() => {
      localStorage.setItem("agency.onboarded", "1");
      localStorage.setItem("agency.preferences", JSON.stringify({ input_mode: "pointer", dwell_ms: 800 }));
    });
    await provide(page);
  },
});

export { expect };

export async function spoken(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __talk: { spoken: string[] } }).__talk.spoken);
}

/** Hold a synthetic gaze point on an element's centre for `ms` (needs gaze input mode). */
export async function gazeAt(page: Page, target: Locator, ms: number) {
  const box = (await target.boundingBox())!;
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

/** Every visible dwell target is at least 96 px in both directions. */
export async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("main [data-dwell], .sheet [data-dwell]")]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width < 96 || r.height < 96)
      .map(
        ({ el, r }) =>
          `${(el.textContent ?? "").trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      ),
  );
}
