/**
 * Design review screenshots: every screen at 1440 × 900 in light and dark, saved as JPEG to
 * docs/os/design/<DESIGN_SHOTS>/. Only runs when DESIGN_SHOTS is set (e.g. DESIGN_SHOTS=after npx playwright test
 * e2e/design-shots.spec.ts); it asserts nothing, so it never affects CI.
 */
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const phase = process.env.DESIGN_SHOTS;
const dir = resolve(import.meta.dirname, "..", "..", "docs", "os", "design", phase ?? "none");
const coordinator = new Coordinator();
test.skip(!phase, "set DESIGN_SHOTS=before|after to capture");
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

const SCREENS: [string, string][] = [
  ["home", "/#/"],
  ["flow-food", "/#/flow/food"],
  ["flow-shopping", "/#/flow/shopping"],
  ["flow-messages", "/#/flow/messages"],
  ["apps", "/#/apps?view=all"],
  ["settings", "/#/settings"],
  ["settings-memory", "/#/settings/memory"],
  ["settings-voice", "/#/settings/voice"],
  ["talk", "/#/talk"],
  ["onboarding", "/#/onboarding"],
  ["errands", "/#/errands"],
  ["lifeline", "/#/lifeline"],
  ["lifeline-setup", "/#/lifeline/setup"],
  ["preferences", "/#/preferences"],
];

for (const theme of ["light", "dark"]) {
  test(`design shots, ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((t) => {
      localStorage.setItem("agency.onboarded", "1");
      localStorage.setItem("agency.fakes", "memory,agent,native");
      localStorage.setItem("agency.fakeAgentDelayMs", "100");
      localStorage.setItem("agency.preferences", JSON.stringify({ theme: t }));
    }, theme);
    for (const [name, path] of SCREENS) {
      await page.goto(path);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${dir}/${theme}-${name}.jpg`, type: "jpeg", quality: 70 });
    }
    // A task waiting for approval, and the Lifeline emergency screen.
    await page.goto("/#/flow/food");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /^Your usual/ }).click();
    await expect(page.getByTestId("approval")).toBeVisible();
    await page.screenshot({ path: `${dir}/${theme}-task-approval.jpg`, type: "jpeg", quality: 70 });
    await page.goto("/#/");
    await page.getByRole("button", { name: /Help: call for help/ }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.screenshot({ path: `${dir}/${theme}-lifeline-alert.jpg`, type: "jpeg", quality: 70 });
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /Cancel, I'm OK/ })
      .click();
  });
}
