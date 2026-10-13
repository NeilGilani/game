/**
 * My day end to end. Practice mode (the browser version and web demo): a due routine, the day's plans with Done and
 * Later, the practice home with a confirmation look for heating, and an everyday request the practice carer answers.
 * Against the real coordinator: telling a carer is off by default; once a helper turns it on, a request reaches the
 * simulated phone, the carer answers from its link, and the person sees the answer. Lifeline is never involved.
 * And the Mac app's home (its main process stood in for here): real devices, no practice label, prepare then run.
 */
import { expect, test, type Page } from "@playwright/test";
import { BACKEND, Coordinator } from "./backend";

const pick = (page: Page, name: string | RegExp) => page.getByRole("button", { name }).first().click();

async function base(page: Page, fakes: string) {
  // A fixed afternoon, so the practice day reads the same whenever the tests run. Time then runs as usual.
  await page.clock.install({ time: new Date(2026, 9, 12, 14, 5, 0) });
  await page.clock.resume();
  await page.addInitScript((f) => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.fakes", f);
    localStorage.setItem("agency.preferences", JSON.stringify({ reduced_motion: true }));
  }, fakes);
}

test.describe("practice mode", () => {
  test.beforeEach(async ({ page }) => {
    await base(page, "memory,agent,native,daily,home");
  });

  test("Home opens My day; a due routine asks gently and goes away when done", async ({ page }) => {
    await page.goto("/#/");
    await page.getByRole("button", { name: /^My day:/ }).click();
    await expect(page).toHaveURL(/#\/day$/);
    await expect(page.getByTestId("day-practice").first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Time to drink some water?");
    await expect(page.getByText("Only if you'd like to.")).toBeVisible();
    await pick(page, /^Done$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Next: Physio visit at/);
    // Every choice on the hub is big enough to look at.
    for (const b of await page.locator(".day-options .choice").all()) {
      const box = await b.boundingBox();
      expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(96);
    }
  });

  test("Today: what's next, Done, Later and undo", async ({ page }) => {
    await page.goto("/#/day/today");
    const physio = page.getByTestId("day-item-physio");
    await expect(physio).toHaveAttribute("data-status", "next");
    await expect(page.getByTestId("day-item-eye-drops-am")).toHaveAttribute("data-status", "done");
    await physio.getByRole("button", { name: "Done: Physio visit" }).click();
    await expect(physio).toHaveAttribute("data-status", "done");
    await physio.getByRole("button", { name: /Not done/ }).click();
    await expect(physio).toHaveAttribute("data-status", "next");
    await physio.getByRole("button", { name: "Later: Physio visit" }).click();
    await expect(physio).toHaveAttribute("data-status", /later|upcoming|next/);
    for (const b of await page.locator(".day-item .btn-xl").all()) {
      const box = await b.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(96);
    }
  });

  test("the practice home: a lamp in one look, heating only after a confirmation look", async ({ page }) => {
    await page.goto("/#/day/home");
    await expect(page.getByText("Practice home").first()).toBeVisible();
    await expect(page.getByText(/nothing in your home changes/i)).toBeVisible();
    await expect(page.getByTestId("day-device-bedroom-lamp")).toContainText("Off");
    await page.getByTestId("day-device-bedroom-lamp").click();
    await pick(page, /^Turn on/);
    await expect(page.getByText("Done: Turn on: Bedroom lamp.")).toBeVisible();
    await expect(page.getByText("The home · On")).toBeVisible();
    await pick(page, /^Back$/);

    await page.getByTestId("day-device-thermostat").click();
    await pick(page, /^Heating off/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Are you sure?");
    const yes = page.getByRole("button", { name: /Yes: Heating off: Thermostat/ });
    await expect(yes).toBeEnabled({ timeout: 5000 });
    await expect(page.getByText("The home · 20°C")).toBeVisible(); // nothing changed before the yes
    await yes.click();
    await expect(page.getByText("The home · Heating off")).toBeVisible();
    // No doors or locks anywhere.
    await pick(page, /^Back$/);
    await expect(page.locator(".day-options")).not.toContainText(/door|lock|garage/i);
  });

  test("ask for help: exactly what goes to whom, a second look, then the carer's answer", async ({
    page,
  }) => {
    await page.goto("/#/day/help");
    await expect(page.locator(".day-options .choice")).toHaveCount(8);
    await expect(page.getByRole("button", { name: /It's urgent/ })).toBeVisible();
    await pick(page, /^I'm cold/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tell Jordan?");
    await expect(page.getByTestId("day-tell-text")).toHaveText('"I\'m cold"');
    await expect(page.getByText(/practice phone/).first()).toBeVisible();
    await pick(page, /^Send to Jordan/);
    const yes = page.getByRole("button", { name: /Yes, send it/ });
    await expect(yes).toBeEnabled({ timeout: 5000 });
    await yes.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sent to Jordan");
    await expect(page.getByText(/Waiting for Jordan to answer/)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Jordan: On my way", {
      timeout: 15_000,
    });
  });

  test("the reminder waits in the dock on other screens, never on Lifeline, and opens Routines", async ({
    page,
  }) => {
    await page.goto("/#/settings");
    const dock = page.getByTestId("day-nudge");
    await expect(dock).toContainText("Drink some water?");
    await expect(dock).toHaveAttribute("aria-label", "Time to drink some water? Open routines.");
    const box = await dock.boundingBox();
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(96);
    await page.goto("/#/lifeline");
    await expect(page.locator('main[data-zone="lifeline"]')).toBeVisible();
    await expect(page.getByTestId("day-nudge")).toHaveCount(0);
    await page.goto("/#/settings");
    await page.getByTestId("day-nudge").click();
    await expect(page).toHaveURL(/#\/day\/routines$/);
    await page
      .getByTestId("day-routine-water")
      .getByRole("button", { name: /In 30 minutes/ })
      .click();
    await expect(page.getByTestId("day-routine-water")).toHaveAttribute("data-due", "false");
    await page.goto("/#/apps");
    await expect(page.getByTestId("day-nudge")).toHaveCount(0);
    // Home shows it on the My day tile too.
    await page.goto("/#/");
    await expect(page.getByRole("button", { name: /^My day:/ })).toHaveAttribute(
      "aria-label",
      "My day: Plans, home & help",
    );
  });
});

test.describe("with the real coordinator", () => {
  const coordinator = new Coordinator();
  test.beforeAll(async () => coordinator.start());
  test.afterAll(async () => coordinator.stop());
  test.beforeEach(async ({ page }) => {
    await base(page, "memory,agent,native,home");
  });

  test("telling a carer is off by default: the request stays on screen", async ({ page }) => {
    await page.goto("/#/day/help");
    await pick(page, /^Turn me, please/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Telling a carer by phone is off");
    await pick(page, /Show it big/);
    await expect(page.getByTestId("day-big")).toHaveText("Turn me, please");
    const outbox = await coordinator.api<{ messages: unknown[] }>("/api/daily/outbox");
    expect(outbox.messages).toHaveLength(0);
  });

  test("a helper sets up the day and a carer; the carer answers from the phone's link", async ({
    page,
    context,
  }) => {
    // A helper adds a visit and turns on telling Jordan (a simulated phone) in Settings.
    await page.goto("/#/settings/day");
    await page.getByRole("form", { name: "Add to the schedule" }).getByLabel("What").fill("Speech therapist");
    await page.getByRole("form", { name: "Add to the schedule" }).getByLabel("Time").fill("23:30");
    await page.getByRole("button", { name: /Add to the schedule/ }).click();
    await expect(page.getByText("Added Speech therapist.").first()).toBeVisible();
    await page.getByLabel("Who requests go to").selectOption("jordan");
    await page.getByRole("button", { name: /Let the person tell a carer/ }).click();
    await expect(page.getByRole("button", { name: /Let the person tell a carer/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.goto("/#/day/today");
    await expect(page.getByText("Speech therapist")).toBeVisible();

    // The person asks for help.
    await page.goto("/#/day/help");
    await pick(page, /^I need the bathroom/);
    await expect(page.getByText(/practice phone/).first()).toBeVisible();
    await pick(page, /^Send to Jordan/);
    const yes = page.getByRole("button", { name: /Yes, send it/ });
    await expect(yes).toBeEnabled({ timeout: 5000 });
    await yes.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sent to Jordan");

    // It's on Jordan's simulated phone, separate from Lifeline's alerts, and Lifeline has no alert.
    const phones = await context.newPage();
    await phones.goto("/#/phones");
    const request = phones.getByTestId("phone-requests-jordan");
    await expect(request).toContainText("Not an emergency");
    const lifeline = await coordinator.api<{ open_alert: unknown }>("/api/lifeline/status");
    expect(lifeline.open_alert).toBeNull();
    const [carer] = await Promise.all([
      context.waitForEvent("page"),
      request.getByRole("link", { name: "Answer as this person" }).click(),
    ]);
    await expect(carer.getByRole("heading", { level: 1 })).toContainText("is asking for you");
    await expect(carer.getByText('"I need the bathroom"')).toBeVisible();
    await carer.getByRole("button", { name: "On my way" }).click();
    await expect(carer.getByText(/can see that you.re on your way/)).toBeVisible();

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Jordan: On my way", {
      timeout: 10_000,
    });
  });

  test("the carer page needs no token but shows only that one request", async ({ page }) => {
    await coordinator.api("/api/daily/settings", {
      method: "PUT",
      body: JSON.stringify({ carer_notify: true, carer_id: "morgan", speak_prompts: false }),
    });
    await coordinator.api("/api/daily/requests", {
      method: "POST",
      body: JSON.stringify({ kind: "help", text: "Fix my pillow, please" }),
    });
    const { messages } = await coordinator.api<{ messages: { link: string; contact_id: string }[] }>(
      "/api/daily/outbox",
    );
    const link = messages.find((m) => m.contact_id === "morgan")!.link;
    await page.goto(`${BACKEND}${link}`);
    await expect(page.getByText('"Fix my pillow, please"')).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/medication|allerg|address/i);
    await page.goto(`${BACKEND}/carer/not-a-real-link`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link doesn't work");
  });
});

test.describe("the Mac app's home", () => {
  test("real devices from the main process: no practice label, heating confirmed, the run uses the ticket", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("agency.onboarded", "1");
      localStorage.setItem("agency.fakes", "memory,agent,native,daily");
      localStorage.setItem("agency.preferences", JSON.stringify({ reduced_motion: true }));
      const calls: string[] = [];
      let state = "18°C";
      const devices = () => [
        {
          id: "heat",
          name: "Living room heating",
          kind: "thermostat",
          actions: [{ id: "warm", label: "Warmer", confirm: true }],
          state,
          stateFromDevice: true,
          stateAt: null,
        },
      ];
      (window as unknown as Record<string, unknown>).__homeCalls = calls;
      (window as unknown as Record<string, unknown>).agency = {
        role: "shell",
        agent: { send: () => {}, onEvent: () => () => {} },
        stopAll: async () => ({}),
        onStopAll: () => () => {},
        native: { call: async () => ({ ok: true, voices: [], apps: [] }) },
        permissions: { status: async () => ({}), request: async () => ({}), openSettings: async () => {} },
        home: {
          status: async () => ({ available: true, enabled: true, devices: devices() }),
          refresh: async () => ({ available: true, enabled: true, devices: devices() }),
          settings: async () => ({ enabled: true, devices: [] }),
          setSettings: async () => ({ ok: false, error: "not in this test" }),
          shortcuts: async () => ({ ok: true, names: [] }),
          prepare: async (d: string, a: string) => {
            calls.push(`prepare ${d} ${a}`);
            return {
              ok: true,
              ticket: "t1",
              fingerprint: "f1",
              device: "Living room heating",
              action: "Warmer",
              confirm: true,
              summary: "Warmer: Living room heating",
            };
          },
          run: async (t: string, f: string) => {
            calls.push(`run ${t} ${f}`);
            state = "21°C";
            return { ok: true, state, summary: "Warmer: Living room heating" };
          },
          cancel: async (t: string) => void calls.push(`cancel ${t}`),
        },
      };
    });
    await page.goto("/#/day/home");
    await expect(page.getByTestId("day-device-heat")).toContainText("18°C");
    await expect(page.getByText("Practice home")).toHaveCount(0);
    await page.getByTestId("day-device-heat").click();
    await pick(page, /^Warmer/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Are you sure?");
    expect(await page.evaluate(() => (window as unknown as { __homeCalls: string[] }).__homeCalls)).toEqual([
      "prepare heat warm",
    ]);
    const yes = page.getByRole("button", { name: /Yes: Warmer: Living room heating/ });
    await expect(yes).toBeEnabled({ timeout: 5000 });
    await yes.click();
    await expect(page.getByText("The home · 21°C")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __homeCalls: string[] }).__homeCalls)).toEqual([
      "prepare heat warm",
      "run t1 f1",
    ]);
  });
});
