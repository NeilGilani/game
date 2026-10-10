/**
 * Lifeline rescue end to end: a real browser, a real coordinator with its real supervisor loop and
 * timers. The person says what's wrong, a helper asks questions on the real response page, the
 * person answers with SYNTHETIC gaze frames (injected through the test hook, standing in for
 * calibrated gaze), the helper ticks care-plan steps, a SIMULATED ambulance is requested and
 * confirmed, and the alert is resolved. Then a SIMULATED power cut at the ventilator raises an alert.
 * Nobody real is contacted: simulated phones, the demo dispatch centre and the demo home.
 */
import { type BrowserContext, type Locator, type Page, expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

test.beforeEach(async ({ context }) => {
  await coordinator.api("/api/demo/reset", { method: "POST" });
  await coordinator.api("/api/demo/faults", {
    method: "PUT",
    body: JSON.stringify({ lifeline_primary_unreachable: false, lifeline_power_cut: false }),
  });
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.testHooks", "1");
    localStorage.setItem(
      "agency.preferences",
      JSON.stringify({ input_mode: "gaze", dwell_ms: 1000, show_gaze_cursor: true }),
    );
  });
});

interface Alert {
  id: string;
  kind: string;
  status: string;
  situation: string | null;
  urgency: string;
  resolved_by: string | null;
  questions: { text: string; answer: string | null }[];
  plan: { steps: { done_by: string | null }[] };
  dispatch: { status: string; simulated: boolean } | null;
  handoff: { label: string; text: string }[];
  notifications: { contact_id: string; purpose: string }[];
}
interface Status {
  open_alert: Alert | null;
  recent: Alert[];
}

const status = () => coordinator.api<Status>("/api/lifeline/status");
const overlay = (page: Page) => page.getByRole("alertdialog");

/** Hold a synthetic gaze point on an element's centre for `ms`, at ~30 frames per second. */
async function gazeAt(page: Page, target: Locator, ms: number): Promise<void> {
  await expect(target).toBeVisible();
  const box = (await target.boundingBox())!;
  await page.evaluate(
    async ({ x, y, ms }) => {
      const hook = (window as unknown as { __agency: { inject: (f: object) => void } }).__agency;
      const end = performance.now() + ms;
      while (performance.now() < end) {
        hook.inject({ pointer: { x, y }, confidence: 1 });
        await new Promise((r) => setTimeout(r, 33));
      }
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2, ms },
  );
}

/** Open a contact's response page from the simulated phones, like a helper tapping the link. */
async function responsePage(context: BrowserContext, name: string): Promise<Page> {
  const phones = await context.newPage();
  await phones.goto("/#/phones");
  await expect(phones.getByRole("region", { name: `${name}'s simulated phone` })).toContainText(
    "AGENCY ALERT",
  );
  const [responder] = await Promise.all([
    context.waitForEvent("page"),
    phones.getByRole("link", { name: `Open as ${name}` }).click(),
  ]);
  await phones.close();
  return responder;
}

test("rescue: say what's wrong, answer a helper with the eyes, steps ticked, simulated ambulance, resolved", async ({
  page,
  context,
}) => {
  await page.goto("/#/");
  await page.getByRole("button", { name: /Help: call for help/ }).click();
  await overlay(page).getByRole("button", { name: "Call now" }).click();
  await expect(overlay(page).getByRole("heading", { name: "Help is being called" })).toBeVisible();

  // The person says what's wrong with their eyes: breathing is critical, so everyone is alerted.
  await page.waitForTimeout(1200); // selection pauses briefly whenever the emergency screen changes
  await gazeAt(page, overlay(page).getByRole("button", { name: "Tell them what's wrong" }), 1700);
  await expect(overlay(page).getByRole("heading", { name: "What's wrong?" })).toBeVisible();
  await page.waitForTimeout(1200);
  await gazeAt(page, overlay(page).getByRole("button", { name: "Breathing or mask" }), 1700);
  await expect.poll(async () => (await status()).open_alert?.urgency).toBe("critical");
  const open = (await status()).open_alert!;
  expect(open.situation).toBe("breathing");
  // Critical: everyone (Jordan, Morgan and the monitoring centre) is alerted at once.
  expect(new Set(open.notifications.filter((n) => n.purpose === "alert").map((n) => n.contact_id))).toEqual(
    new Set(["jordan", "morgan", "monitoring"]),
  );

  // Jordan opens the real response page, says they're coming and asks a question.
  const jordan = await responsePage(context, "Jordan");
  await expect(jordan.getByRole("heading", { name: "CRITICAL: Riley needs help" })).toBeVisible();
  await expect(jordan.getByText("Riley says: breathing or mask (critical)")).toBeVisible();
  await jordan.getByRole("button", { name: "I'm on my way" }).click();
  await jordan.getByRole("button", { name: "Is it your breathing?" }).click();

  // The question takes over Riley's screen; Riley answers Yes by looking at it.
  await expect(overlay(page).getByText("Is it your breathing?")).toBeVisible();
  await page.waitForTimeout(1200);
  await gazeAt(page, overlay(page).getByRole("button", { name: "Yes" }), 1700);
  await expect(jordan.getByText(/Jordan asked: Is it your breathing\? Yes/)).toBeVisible({ timeout: 15_000 });

  // Jordan ticks the first two care-plan steps.
  await jordan.reload();
  await jordan.getByRole("button", { name: "Done" }).first().click();
  await jordan.getByRole("button", { name: "Done" }).first().click();
  await expect(jordan.getByText(/Done \(Jordan,/)).toHaveCount(2);

  // Jordan asks "Do you want an ambulance?"; Riley's "yes" requests one (simulated).
  await jordan.getByRole("button", { name: "Do you want an ambulance?" }).click();
  await expect(overlay(page).getByText("Do you want an ambulance?")).toBeVisible();
  await page.waitForTimeout(1200);
  await gazeAt(page, overlay(page).getByRole("button", { name: "Yes" }), 1700);
  await expect
    .poll(async () => (await status()).open_alert?.dispatch?.status, { timeout: 30_000 })
    .toBe("accepted");
  expect((await status()).open_alert!.dispatch!.simulated).toBe(true);
  await expect(overlay(page).getByText(/Ambulance:/)).toBeVisible();

  // Jordan is with Riley, and ends the alert with a deliberate confirmation.
  await jordan.reload();
  await jordan.getByRole("link", { name: "Riley is safe: end the alert" }).click();
  await jordan.getByRole("button", { name: "Yes, Riley is safe: end the alert" }).click();
  await expect(jordan.getByRole("heading", { name: "This alert has ended" })).toBeVisible();
  await expect(overlay(page)).toBeHidden();

  // The alert's page on Riley's screen tells the whole story.
  const id = (await status()).recent[0]!.id;
  const alert = await coordinator.api<Alert>(`/api/lifeline/alerts/${id}`);
  expect(alert.status).toBe("resolved");
  expect(alert.questions.map((q) => `${q.text} ${q.answer}`)).toEqual([
    "Is it your breathing? yes",
    "Do you want an ambulance? yes",
  ]);
  expect(alert.plan.steps.filter((st) => st.done_by === "Jordan")).toHaveLength(2);

  await page.goto(`/#/lifeline/alert/${id}`);
  await expect(page.getByTestId("alert-situation")).toHaveText("Breathing or mask");
  await expect(page.getByTestId("alert-questions")).toContainText("Do you want an ambulance?");
  await expect(page.getByTestId("alert-questions")).toContainText("Answer: Yes");
  await expect(page.getByTestId("alert-steps").locator('li[data-tone="ok"]')).toHaveCount(2);
  await expect(page.getByTestId("alert-dispatch")).toContainText("Confirmed");
  await expect(page.getByTestId("alert-dispatch")).toContainText("Simulated");
  await expect(page.getByTestId("alert-handoff")).toContainText("Riley's answers");
  await expect(page.getByTestId("alert-handoff")).toContainText("Done so far");
  await page.screenshot({ path: "test-results/rescue-alert-detail.png", fullPage: true });
});

test("a power cut at the ventilator raises a critical alert by itself", async ({ page }) => {
  await page.goto("/#/lifeline");
  await expect(page.getByText("Ventilator power watched")).toBeVisible();

  await coordinator.api("/api/demo/faults", {
    method: "PUT",
    body: JSON.stringify({ lifeline_power_cut: true }),
  });
  await expect.poll(async () => (await status()).open_alert?.kind, { timeout: 45_000 }).toBe("power_lost");
  const alert = (await status()).open_alert!;
  expect(alert.situation).toBe("equipment");
  await expect(overlay(page)).toBeVisible();
  await expect(
    overlay(page)
      .getByText(/ventilator/i)
      .first(),
  ).toBeVisible();

  await coordinator.api("/api/demo/faults", {
    method: "PUT",
    body: JSON.stringify({ lifeline_power_cut: false }),
  });
  await page.goto(`/#/lifeline/alert/${alert.id}`);
  await expect(page.getByRole("heading", { name: "Ventilator power cut" })).toBeVisible();
});

test("setup: care plan, emergency services and the home are saved, and bad input is refused", async ({
  page,
}) => {
  await page.goto("/#/lifeline/setup");
  await expect(
    page.getByRole("heading", { name: /When it's critical, alert everyone at once/ }),
  ).toBeVisible();
  await expect(
    page.getByText("A real care plan is written with the person's care team", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /Emergency services/ })).toContainText(
    "Simulated in this build",
  );

  // Nine steps is one too many.
  const pain = page.getByLabel(/^Pain/);
  await pain.fill(Array.from({ length: 9 }, (_, i) => `Step number ${i + 1}`).join("\n"));
  await expect(page.getByText("Pain: at most 8 steps.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Lifeline settings" })).toBeDisabled();
  await pain.fill("Ask where it hurts.\nHelp Riley change position.");

  // A PIN must be four digits.
  const pin = page.getByLabel(/Cancel PIN/);
  await pin.fill("12");
  await expect(page.getByText("The PIN must be exactly 4 digits.")).toBeVisible();
  await pin.fill("4321");

  await page.getByRole("button", { name: /Alert everyone at once/ }).click();
  await page.getByRole("button", { name: /Increase Critical below/ }).click();
  await page.getByRole("button", { name: "Save Lifeline settings" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

  const saved = await coordinator.api<{
    critical_alert_everyone: boolean;
    plans: Record<string, string[]>;
    dispatch: { pin: string; consented_at: string | null };
    home: { power_critical_minutes: number };
  }>("/api/lifeline/settings");
  expect(saved.critical_alert_everyone).toBe(false);
  expect(saved.plans.pain).toEqual(["Ask where it hurts.", "Help Riley change position."]);
  expect(saved.dispatch.pin).toBe("4321");
  expect(saved.dispatch.consented_at).not.toBeNull();
  expect(saved.home.power_critical_minutes).toBe(25);
});
