/**
 * What the eye cursor may choose, through the real input layer. The cursor positions are SYNTHETIC frames injected
 * through the test hook (the eye cursor, "head" mode, with no webcam), standing in for a person's eyes.
 * - Only what can be seen can be chosen: a page button hidden under the eye keyboard is never selected.
 * - Help stays choosable with the eyes while a dialog is open.
 * - The dock's Keyboard button moves through every text box on a screen; the 123 keys type addresses.
 */
import { type Locator, type Page, expect, test } from "@playwright/test";
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
      JSON.stringify({ input_mode: "head", show_gaze_cursor: true }),
    );
  });
});

type Hook = { inject: (f: object) => void; external: () => void };

/** Hold the eye cursor at (x, y) for `ms`, at about 30 frames a second. */
async function lookAtPoint(page: Page, x: number, y: number, ms: number) {
  await page.evaluate(
    async ({ x, y, ms }) => {
      const hook = (window as unknown as { __agency: Hook }).__agency;
      const end = performance.now() + ms;
      while (performance.now() < end) {
        hook.inject({ pointer: { x, y }, confidence: 1 });
        await new Promise((r) => setTimeout(r, 33));
      }
    },
    { x, y, ms },
  );
}

/** Look at a control's middle for `ms` (a new control holds still a moment, then the 1.5 s dwell). */
async function lookAt(page: Page, target: Locator, ms = 2800) {
  const box = (await target.boundingBox())!;
  await lookAtPoint(page, box.x + box.width / 2, box.y + box.height / 2, ms);
}

async function eyesOnly(page: Page, path: string) {
  await page.goto(path);
  await page.evaluate(() => (window as unknown as { __agency: Hook }).__agency.external());
  await page.waitForTimeout(1500); // the pause after a new screen
}

test("a button hidden under the eye keyboard is never chosen by looking at the keyboard", async ({
  page,
}) => {
  await eyesOnly(page, "/#/flow/messages");
  await page.getByRole("button", { name: /^Mom/ }).click();
  await page.getByRole("button", { name: /Write my own/ }).click();
  const keyboard = page.getByRole("group", { name: "Eye keyboard" });
  await expect(keyboard).toBeVisible();
  await page.locator(".flow-type textarea").fill("See you Sunday");

  // The page's Done sits under the keyboard; the person looks at the keyboard's own panel right over it.
  const done = page.locator(".flow-type button[type=submit]");
  const doneBox = (await done.boundingBox())!;
  const kbBox = (await keyboard.boundingBox())!;
  const x = kbBox.x + 8;
  const y = Math.max(doneBox.y, kbBox.y) + 20;
  expect(x).toBeLessThan(doneBox.x + doneBox.width);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x, y })).toBe(
    "eye-keyboard",
  );
  await lookAtPoint(page, x, y, 3500);
  await expect(page).toHaveURL(/#\/flow\/messages$/);
  await expect(page.locator(".flow-type textarea")).toHaveValue("See you Sunday");

  // Done on the keyboard puts it away; then the page's Done can be seen and chosen.
  await page.getByRole("button", { name: "Done", exact: true }).last().click();
  await expect(keyboard).toHaveCount(0);
  await lookAtPoint(page, 700, 80, 300);
  await lookAt(page, done);
  await expect(page).toHaveURL(/#\/task\//);
});

test("the dock's Keyboard moves through every text box, and the 123 keys type a web address", async ({
  page,
}) => {
  await eyesOnly(page, "/#/lifeline/setup");
  const keyboardButton = page.locator('[data-dock="keyboard"]');
  const values: string[] = [];
  for (let i = 0; i < 2; i++) {
    await lookAtPoint(page, 700, 80, 300); // a glance away: the same button can be chosen again
    await lookAt(page, keyboardButton);
    await expect(page.getByRole("group", { name: "Eye keyboard" })).toBeVisible();
    values.push(await page.evaluate(() => (document.activeElement as HTMLInputElement).value));
  }
  expect(values[0]).not.toBe(values[1]); // two different contacts' names

  await eyesOnly(page, "/#/settings/connection");
  await lookAt(page, keyboardButton);
  const address = page.locator('input[inputmode="url"]');
  await expect(address).toBeFocused();
  await lookAt(page, page.getByRole("button", { name: "Numbers and symbols" }));
  await lookAt(page, page.locator(".eye-key", { hasText: /^:$/ }));
  await lookAt(page, page.locator(".eye-key", { hasText: /^\/$/ }));
  await lookAt(page, page.locator(".eye-key", { hasText: /^8$/ }));
  await expect(address).toHaveValue(":/8");
  // It stays above the dock, so Help and Stop are never covered.
  const kb = (await page.getByRole("group", { name: "Eye keyboard" }).boundingBox())!;
  const dock = (await page.locator(".topbar.dock").boundingBox())!;
  expect(kb.y + kb.height).toBeLessThanOrEqual(dock.y);
});

// Last in this file: it leaves a (practice) Lifeline alert open on this coordinator, covering every screen.
test("Help can be chosen with the eyes while a dialog is open", async ({ page }) => {
  await eyesOnly(page, "/#/talk/listen");
  await page.getByRole("button", { name: /Practise conversation/ }).click();
  await page.getByRole("button", { name: /Pretend: “How are you/ }).click();
  await page.getByRole("button", { name: /Ideas from AI/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await lookAt(page, page.getByRole("button", { name: /Help: call for help/ }), 4500); // Help asks for a longer look
  await expect(page.getByRole("alertdialog")).toBeVisible();
});
