/**
 * Talk through the real interface wiring with SYNTHETIC gaze frames (as in dwell.spec.ts):
 * quick answers, eye typing with letter groups and word suggestions, and the pain reporter.
 * Speech itself is stubbed so the test can check what would have been said.
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
    localStorage.setItem(
      "agency.preferences",
      JSON.stringify({ input_mode: "gaze", dwell_ms: 800, show_gaze_cursor: true }),
    );
    // Record utterances instead of speaking them.
    const spoken: string[] = [];
    (window as unknown as { __spoken: string[] }).__spoken = spoken;
    const synth = {
      speak: (u: SpeechSynthesisUtterance) => {
        spoken.push(u.text);
        setTimeout(() => u.onend?.(new Event("end") as SpeechSynthesisEvent), 10);
      },
      cancel: () => undefined,
      getVoices: () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  });
});

async function gazeAt(page: Page, target: Locator, ms: number) {
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

/** Look away (off every target) so the next target is a fresh look. */
async function lookAway(page: Page) {
  await page.evaluate(async () => {
    const hook = (window as unknown as { __agency: { inject: (f: object) => void } }).__agency;
    for (let i = 0; i < 6; i++) {
      hook.inject({ pointer: { x: 2, y: window.innerHeight - 2 }, confidence: 1 });
      await new Promise((r) => setTimeout(r, 33));
    }
  });
}

const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);

test("a quick answer is spoken and shown large", async ({ page }) => {
  await page.goto("/#/talk");
  const yes = page.getByRole("button", { name: "Yes", exact: true });
  await expect(yes).toBeVisible();
  await page.waitForTimeout(1200);
  await gazeAt(page, yes, 1400);
  await expect(page.getByLabel("Last thing said")).toContainText("Yes.");
  expect(await spoken(page)).toContain("Yes.");

  // Long groups page with a "More phrases" tile instead of scrolling.
  await expect(page.getByRole("button", { name: "Please turn the light off." })).toHaveCount(0);
  await page.getByRole("button", { name: /More phrases/ }).click();
  await expect(page.getByRole("button", { name: /Page 2 of 2/ })).toBeVisible();
  await page.getByRole("button", { name: "Please turn the light off." }).click();
  await expect(page.getByLabel("Last thing said")).toContainText("Please turn the light off.");
});

test("eye typing: a group, then a letter, then a suggested word, then Speak", async ({ page }) => {
  await page.goto("/#/talk/type");
  const group = page.getByRole("button", { name: "T N S H R D" });
  await expect(group).toBeVisible();
  await page.waitForTimeout(1200);

  // Keep looking at the same spot after the group opens: the letter there (T) must not be
  // typed by the lingering gaze within the refractory period plus a short glance.
  await gazeAt(page, group, 1300);
  const letterT = page.getByRole("button", { name: "T", exact: true });
  await expect(letterT).toBeVisible();
  await gazeAt(page, letterT, 500);
  await expect(page.getByLabel("Your message")).not.toContainText("T");

  await lookAway(page);
  await gazeAt(page, letterT, 1400);
  await expect(page.getByLabel("Your message")).toContainText("T");

  // Suggestions now complete "t"; choose one.
  const suggestion = page.getByRole("group", { name: "Word suggestions" }).getByRole("button").first();
  const word = (await suggestion.textContent())!.trim();
  expect(word.startsWith("t")).toBe(true);
  await lookAway(page);
  await gazeAt(page, suggestion, 1400);
  const expected = word.charAt(0).toUpperCase() + word.slice(1);
  await expect(page.getByLabel("Your message")).toContainText(expected);

  const speakBtn = page.getByRole("button", { name: "Speak", exact: true });
  await lookAway(page);
  await gazeAt(page, speakBtn, 1400);
  await expect.poll(() => spoken(page)).toContain(expected);

  // The draft survives a reload.
  await page.reload();
  await expect(page.getByLabel("Your message")).toContainText(expected);
});

test("clear can be undone, and a message can be saved as a phrase", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agency.talk.draft", "Check my mask "));
  await page.goto("/#/talk/type");
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByLabel("Your message")).not.toContainText("Check my mask");
  await page.getByRole("button", { name: "Undo clear" }).click();
  await expect(page.getByLabel("Your message")).toContainText("Check my mask");
  await page.getByRole("button", { name: "Save as phrase" }).click();
  await expect(page.getByRole("button", { name: "Saved to My phrases" })).toBeDisabled();

  await page.goto("/#/talk");
  await page.getByRole("button", { name: /My phrases/ }).click();
  await page.getByRole("button", { name: "Check my mask" }).click();
  await expect(page.getByLabel("Last thing said")).toContainText("Check my mask");
});

test("pain reporter: what, where and how bad becomes one sentence", async ({ page }) => {
  await page.goto("/#/talk/pain");
  await page.getByRole("button", { name: /^Pain/ }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: /Very bad/ }).click();
  const sentence = "My back hurts. It's very bad, 8 out of 10.";
  await expect(page.getByLabel("Last thing said")).toContainText(sentence);
  expect(await spoken(page)).toContain(sentence);
  await expect(page.getByRole("note")).toContainText("If this is an emergency");
});
