/**
 * My day end to end, in practice mode (the sample day, the practice home, the practice carer's phone) and against
 * a real coordinator (telling a carer is off until turned on, then one message reaches the simulated phone and no
 * Lifeline alert starts). The clock is fixed at Monday 12 October 2026, 10:00, so care reminders are asking.
 */
import { type Page, expect, test } from "@playwright/test";
import { BACKEND, Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

const MONDAY_10AM = new Date(2026, 9, 12, 10, 0);

async function practice(page: Page, fakes = "memory,agent,native,daily") {
  await page.clock.setFixedTime(MONDAY_10AM);
  await page.addInitScript((f) => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.fakes", f);
    localStorage.setItem("agency.fakeAgentDelayMs", "100");
  }, fakes);
}

/** The screen fits without scrolling and every target is at least 96 px, 24 px apart (screens.spec's rules). */
async function fits(page: Page, name: string) {
  const r = await page.evaluate(() => {
    const main = document.getElementById("main")!;
    const boxes = Array.from(document.querySelectorAll<HTMLElement>("#main [data-dwell]"))
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({
        name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim(),
        r: el.getBoundingClientRect(),
      }));
    return {
      scroll: main.scrollHeight - main.clientHeight,
      docScroll: document.documentElement.scrollHeight - innerHeight,
      small: boxes.filter((b) => Math.min(b.r.width, b.r.height) < 96).map((b) => b.name),
      close: boxes.flatMap((a, i) =>
        boxes.slice(i + 1).flatMap((b) => {
          const dx = Math.max(0, Math.max(a.r.x, b.r.x) - Math.min(a.r.right, b.r.right));
          const dy = Math.max(0, Math.max(a.r.y, b.r.y) - Math.min(a.r.bottom, b.r.bottom));
          return Math.max(dx, dy) < 23.5 ? [`${a.name} / ${b.name}`] : [];
        }),
      ),
      cut: boxes.filter((b) => b.r.bottom > main.getBoundingClientRect().bottom + 1).map((b) => b.name),
    };
  });
  expect(r.scroll, `${name} scrolls`).toBeLessThanOrEqual(1);
  expect(r.docScroll, `${name} page scrolls`).toBeLessThanOrEqual(1);
  expect(r.small, `${name}: small targets`).toEqual([]);
  expect(r.close, `${name}: targets too close`).toEqual([]);
  expect(r.cut, `${name}: cut off`).toEqual([]);
}

test("Home's My day card shows what's next and opens My day", async ({ page }) => {
  await practice(page);
  await page.goto("/#/");
  const card = page.getByTestId("day-card");
  await expect(card).toContainText("Care reminder");
  await expect(card).toContainText("Eye drops");
  await expect(page.locator(".home-tile")).toHaveCount(12);
  await card.click();
  await expect(page).toHaveURL(/#\/day\/care$/);
});

test("every My day screen fits a 1280×800 and a 1440×900 screen", async ({ page }) => {
  await practice(page);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    for (const path of ["/#/day", "/#/day/care", "/#/day/home", "/#/day/help", "/#/day/remind"]) {
      await page.goto(path);
      await expect(page.locator("#day-title")).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({
        path: `test-results/daily/${size.width}x${size.height}-${path.replace(/\W+/g, "-")}.png`,
      });
      await fits(page, `${path} at ${size.width}×${size.height}`);
    }
  }
});

test("today: Done, Later and Not done, paging, and reading the day", async ({ page }) => {
  await practice(page);
  await page.goto("/#/day");
  await expect(page.locator("#day-title")).toHaveText("Today, Monday 12 October");
  await expect(page.getByText("5 still to do.")).toBeVisible();
  const rows = page.getByTestId("day-entry");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Morning wash with Jordan");

  await page.getByRole("button", { name: "Done: Morning wash with Jordan" }).click();
  await expect(page.getByText("4 still to do.")).toBeVisible();
  // Nothing moves when something is marked: the rows stay where the person is looking.
  await expect(rows.first()).toContainText("Morning wash with Jordan");
  await expect(rows.first()).toHaveAttribute("data-state", "done");
  await page.getByRole("button", { name: "Later: Physiotherapy visit" }).click();
  await expect(rows.nth(1)).toContainText("Later: back at 10:30 am");
  await rows.first().getByRole("button", { name: "Not done" }).click();
  await expect(page.getByText("5 still to do.")).toBeVisible();

  await page.getByRole("button", { name: /More/ }).click();
  await expect(page.getByText("2 of 2")).toBeVisible();
  await expect(rows).toHaveCount(2);
  // Kept on this computer: survives a reload.
  await page.getByRole("button", { name: "Done: Call Mom" }).click();
  await page.reload();
  await expect(page.getByText("4 still to do.")).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { spoken: string[] }).spoken = [];
    window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
      (window as unknown as { spoken: string[] }).spoken.push(u.text);
    };
  });
  await page.getByRole("button", { name: "Read my day" }).click();
  const spoken = await page.evaluate(() => (window as unknown as { spoken: string[] }).spoken.join(" "));
  expect(spoken).toContain("Today is Monday 12 October.");
  expect(spoken).toContain("At 11:00 am: Physiotherapy visit.");
  expect(spoken).toContain("Eye drops: now, when you're ready.");
});

test("Remind me adds the person's own reminder in two looks", async ({ page }) => {
  await practice(page);
  await page.goto("/#/day");
  await page.getByRole("button", { name: "Remind me" }).click();
  await page.getByRole("button", { name: /Have a rest/ }).click();
  await expect(page.locator("#day-title")).toHaveText("Have a rest: when?");
  await page.getByRole("button", { name: /In an hour/ }).click();
  await expect(page.locator("#day-title")).toHaveText("I'll remind you: Have a rest, in an hour (11:00 am).");
  await page.getByRole("button", { name: "Back to my day" }).click();
  await expect(page.getByText("6 still to do.")).toBeVisible();
});

test("care reminders ask, snooze and can tell the practice carer", async ({ page }) => {
  await practice(page);
  await page.goto("/#/day/care");
  await expect(page.locator("#day-title")).toHaveText("1 asking now");
  await expect(page.getByText("Not medical advice and not an alarm.")).toBeVisible();
  const drops = page.getByTestId("day-routine").filter({ hasText: "Eye drops" });
  await expect(drops).toHaveAttribute("data-state", "due");
  await drops.getByRole("button", { name: "Later: Eye drops" }).click();
  await expect(page.locator("#day-title")).toHaveText("Care reminders");
  await expect(page.getByTestId("day-routine").filter({ hasText: "Eye drops" })).toContainText("10:30 am");

  // Back to asking, then tell the carer: the exact words, a pause, then one message.
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("agency.daily.v1")!);
    for (const r of d.routines) if (r.label === "Eye drops") r.snoozedUntil = null;
    localStorage.setItem("agency.daily.v1", JSON.stringify(d));
  });
  await page.reload();
  await page.getByRole("button", { name: "Tell Jordan: Eye drops" }).click();
  await expect(page.locator("#day-title")).toHaveText("Send this to Jordan?");
  await expect(page.getByTestId("day-message")).toContainText(
    "Care reminder: Eye drops. Could you help me with it when you can?",
  );
  await expect(page.getByRole("button", { name: "One moment…" })).toBeDisabled();
  await page.getByRole("button", { name: "Send to Jordan" }).click();
  await expect(page.locator("#day-title")).toHaveText(
    "Sent to Jordan's practice phone. Nobody was really contacted.",
  );
  await page.getByTestId("day-tell-done").click();

  await page.getByRole("button", { name: "Done: Eye drops" }).click();
  await expect(page.locator("#day-title")).toHaveText("Care reminders");
  await expect(page.getByTestId("day-routine").filter({ hasText: "Eye drops" })).toContainText("2:00 pm");
});

test("the practice home: a light in one look, heating only after a confirmation look", async ({ page }) => {
  await practice(page);
  await page.goto("/#/day/home");
  await expect(page.getByText("Practice home: nothing real changes.")).toBeVisible();
  await expect(page.getByTestId("day-device")).toHaveCount(5);
  await expect(page.getByTestId("day-device").filter({ hasText: /door|lock|garage|gate/i })).toHaveCount(0);

  await page.getByTestId("day-device").filter({ hasText: "Bedroom light" }).click();
  await page.getByRole("button", { name: /^On/ }).click();
  await expect(page.locator("#day-title")).toHaveText("Bedroom light: On. (Practice: nothing real changed.)");
  await page.getByRole("button", { name: /All devices/ }).click();
  await expect(page.getByTestId("day-device").filter({ hasText: "Bedroom light" })).toContainText(
    "Last set: On",
  );

  await page.getByTestId("day-device").filter({ hasText: "Heating" }).click();
  await page.getByRole("button", { name: /Heating off/ }).click();
  await expect(page.locator("#day-title")).toHaveText("Heating: Heating off?");
  await expect(page.getByRole("button", { name: "One moment…" })).toBeDisabled();
  await page.getByRole("button", { name: "No, go back" }).click();
  await expect(page.locator("#day-title")).toHaveText("Heating");
  await page.getByRole("button", { name: /Heating off/ }).click();
  await page.getByRole("button", { name: "Yes, heating off" }).click();
  await expect(page.locator("#day-title")).toHaveText("Heating: Off. (Practice: nothing real changed.)");
});

test("asking for help: say it out loud, or send it to the practice carer after seeing the words", async ({
  page,
}) => {
  await practice(page);
  await page.goto("/#/day/help");
  await expect(page.getByText(/For an emergency, look at Help/)).toBeVisible();
  await expect(page.locator(".flow-options .choice")).toHaveCount(6);
  await page.getByRole("button", { name: /I'm cold/ }).click();
  await page.evaluate(() => {
    (window as unknown as { spoken: string[] }).spoken = [];
    window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
      (window as unknown as { spoken: string[] }).spoken.push(u.text);
    };
  });
  await page.getByRole("button", { name: /Say it out loud/ }).click();
  expect(await page.evaluate(() => (window as unknown as { spoken: string[] }).spoken)).toEqual([
    "I'm cold. Could you bring a blanket or turn the heating up?",
  ]);
  await page.getByRole("button", { name: /Send to Jordan/ }).click();
  await expect(page.getByTestId("day-message")).toHaveText(
    "The person you care for (not urgent): I'm cold. Could you bring a blanket or turn the heating up?\nSent from AGENCY. Nothing else will follow.",
  );
  await page.getByRole("button", { name: "No, go back" }).click();
  await expect(page.locator("#day-title")).toHaveText("I'm cold");
});

test("with the coordinator: off by default; once on, one message reaches the simulated phone and no alert starts", async ({
  page,
  request,
}) => {
  await request.put(`${BACKEND}/api/daily/settings`, { data: { notify_enabled: false, carer_id: null } });
  await practice(page, "memory,agent,native");
  await page.goto("/#/day/help");
  await page.getByRole("button", { name: /I'm cold/ }).click();
  await expect(page.getByText("Sending to a carer is off.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /Send to/ })).toHaveCount(0);

  // A helper turns it on with the person, in settings.
  await page.goto("/#/settings/daily");
  await page.getByRole("button", { name: /Tell my carer/ }).click();
  await expect(page.locator("p[role=status]")).toHaveText(
    "Requests can go to Jordan. Each one asks the person first.",
  );

  await page.goto("/#/day/help");
  await page.getByRole("button", { name: /Turn me, please/ }).click();
  await page.getByRole("button", { name: /Send to Jordan/ }).click();
  await expect(page.getByTestId("day-message")).toContainText(
    "Riley (not urgent): Could you help me change position, please?",
  );
  await expect(page.locator(".day-big")).toContainText("practice phone (simulated");
  await page.getByRole("button", { name: "Send to Jordan" }).click();
  await expect(page.locator("#day-title")).toHaveText(
    "Sent to Jordan's practice phone. Nobody was really contacted.",
  );

  const messages = (await (await request.get(`${BACKEND}/api/daily/messages`)).json()).messages;
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    contact_name: "Jordan",
    status: "delivered",
    simulated: true,
    kind: "help",
  });
  const status = await (await request.get(`${BACKEND}/api/lifeline/status`)).json();
  expect(status.open_alert).toBeNull();

  // The simulated phones page shows it on Jordan's phone, apart from Lifeline's messages.
  await page.goto("/#/phones");
  await expect(page.getByLabel("Jordan's simulated phone").getByTestId("phone-request")).toContainText(
    "Could you help me change position, please?",
  );

  await request.put(`${BACKEND}/api/daily/settings`, { data: { notify_enabled: false, carer_id: null } });
});

test("settings refuse a door, and the person can't be sent a door tile", async ({ page }) => {
  await practice(page);
  await page.goto("/#/settings/daily");
  await page.getByLabel("New device").fill("Front door");
  await expect(page.locator(".ll-field-error")).toContainText(
    "AGENCY never controls locks, doors, garage doors or gates.",
  );
  await expect(page.getByRole("button", { name: "Add device" })).toBeDisabled();
  await page.getByLabel("New device").fill("Reading lamp");
  await page.getByRole("button", { name: "Add device" }).click();
  await page.getByRole("button", { name: "Save the home setup" }).click();
  await expect(page.locator("p[role=status]")).toHaveText("Home setup saved.");
});
