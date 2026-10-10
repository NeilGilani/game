// Automated accessibility checks on every page, in light and dark, with the download panel filled in.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { PAGES, makeRelease, mockGitHub } from "./fixtures";

for (const path of PAGES) {
  for (const scheme of ["light", "dark"] as const) {
    test(`axe: /${path} (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await mockGitHub(page, { status: 200, body: makeRelease({ body: "<!-- agency:unsigned -->" }) });
      await page.goto(path);
      if (path === "") await expect(page.locator("#download-panel")).toHaveAttribute("aria-busy", "false");
      // Open every disclosure, so the hidden content is checked too.
      await page.$$eval("details", (all) => all.forEach((d) => d.setAttribute("open", "")));
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      const summary = results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      );
      expect(summary).toEqual([]);
    });
  }
}

test("the theme toggle switches colours and keeps the choice on this device only", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await mockGitHub(page, { status: 404 });
  await page.goto("");
  const toggle = page.locator("[data-theme-toggle]");
  if (!(await toggle.isVisible()))
    test.skip(true, "toggle lives in the header, hidden behind nothing on phones");
  await expect(toggle).toHaveAccessibleName("Switch to dark colours");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await context.cookies()).toEqual([]);
});
