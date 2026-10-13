/** axe-core (WCAG 2.2 A/AA rules) on every screen, light and dark, with the in-page fakes. Zero violations. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

const SCREENS = [
  "/#/",
  "/#/flow/food",
  "/#/flow/shopping",
  "/#/flow/messages",
  "/#/apps?view=all",
  "/#/settings",
  "/#/settings/memory",
  "/#/settings/voice",
  "/#/settings/papers",
  "/#/papers/explain",
  "/#/talk",
  "/#/talk/phrases",
  "/#/talk/listen",
  "/#/talk/history",
  "/#/talk/voice",
  "/#/talk/emergency",
  "/#/memory",
  "/#/camera",
  "/#/status",
  "/#/onboarding",
  "/#/errands",
  "/#/lifeline",
  "/#/lifeline/setup",
  "/#/preferences",
  "/#/day",
  "/#/day/today",
  "/#/day/routines",
  "/#/day/home",
  "/#/day/help",
  "/#/day/tell?kind=help&text=I%27m%20cold",
  "/#/settings/day",
];

for (const theme of ["light", "dark", "contrast"]) {
  test(`axe: no violations on any screen (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => {
      localStorage.setItem("agency.onboarded", "1");
      localStorage.setItem("agency.fakes", "memory,agent,native");
      localStorage.setItem("agency.preferences", JSON.stringify({ theme: t, reduced_motion: true }));
    }, theme);
    for (const path of SCREENS) {
      await page.goto(path);
      await page.waitForTimeout(1300);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      const summary = result.violations.map(
        (v) =>
          `${v.id}: ${v.nodes
            .map((n) => n.target.join(" "))
            .slice(0, 3)
            .join(" | ")}`,
      );
      expect.soft(summary, `${theme} ${path}`).toEqual([]);
    }
  });
}

test("axe: My day with a full practice day and practice home", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.fakes", "memory,agent,native,daily,home");
    localStorage.setItem("agency.preferences", JSON.stringify({ reduced_motion: true }));
  });
  for (const path of [
    "/#/day",
    "/#/day/today",
    "/#/day/routines",
    "/#/day/home",
    "/#/day/tell?kind=help&text=Hi",
    "/#/settings",
  ]) {
    await page.goto(path);
    await page.waitForTimeout(1000);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect
      .soft(
        result.violations.map(
          (v) =>
            `${v.id}: ${v.nodes
              .map((n) => n.target.join(" "))
              .slice(0, 3)
              .join(" | ")}`,
        ),
        path,
      )
      .toEqual([]);
  }
});
