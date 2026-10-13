/**
 * The caregiver's phone companion end to end: a real coordinator with its phone server on 127.0.0.1:8766 (serving
 * the real built companion page), the person's screen in one browser context, and a phone-size, touch browser
 * context for the carer. Pairing goes through the real QR link; alerts through Lifeline's real response page.
 */
import { resolve } from "node:path";
import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const PHONE = "http://127.0.0.1:8766";
const coordinator = new Coordinator({
  AGENCY_FRONTEND_DIST: resolve(import.meta.dirname, "..", "dist"),
  AGENCY_COMPANION_HOST: "127.0.0.1",
  AGENCY_COMPANION_PORT: "8766",
});

test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

interface Device {
  id: string;
}
interface Status {
  enabled: boolean;
  devices: Device[];
}

test.beforeEach(async ({ context }) => {
  await coordinator.api("/api/demo/reset", { method: "POST" });
  const status = await coordinator.api<Status>("/api/companion/status");
  for (const d of status.devices)
    await coordinator.api(`/api/companion/devices/${d.id}`, { method: "DELETE" });
  if (status.enabled)
    await coordinator.api("/api/companion/enabled", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.testHooks", "1");
  });
});

async function phoneContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: PHONE,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
}

/** At the Mac: turn caregiver phones on and show a pairing code; returns the code and the QR link. */
async function showCode(mac: Page): Promise<{ code: string; link: string }> {
  await mac.goto("/#/settings/companion");
  const toggle = mac.getByRole("button", { name: /Let carers' phones connect/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await mac.getByRole("button", { name: "Show a pairing code" }).click();
  await expect(mac.getByRole("img", { name: /QR code to pair a phone/ })).toBeVisible();
  const code = ((await mac.locator(".cmp-code").textContent()) ?? "").trim();
  expect(code).toMatch(/^\d{6}$/);
  const url = ((await mac.locator(".cmp-url").textContent()) ?? "").trim();
  expect(url).toBe(PHONE);
  return { code, link: `${url}/#pair=${code}` };
}

/** On the phone: open the QR link, type a name, pair, and say who you are on the Lifeline list. */
async function pairPhone(phone: Page, link: string, name: string, as: string | null): Promise<void> {
  await phone.goto(link);
  await expect(phone.getByRole("heading", { name: "Pair with AGENCY" })).toBeVisible();
  // The code arrived with the link and is no longer in the address.
  await expect(phone.getByLabel("Code on the Mac")).toHaveValue(link.slice(-6));
  expect(phone.url()).not.toContain("pair=");
  await phone.getByLabel("Your name").fill(name);
  await phone.getByRole("button", { name: "Pair this phone" }).tap();
  await expect(phone.getByRole("heading", { name: "Paired" })).toBeVisible();
  if (as) await phone.getByRole("button", { name: `I'm ${as}` }).tap();
  else await phone.getByRole("button", { name: "I'm not on the list" }).tap();
  await expect(phone.getByRole("heading", { name: "Riley" })).toBeVisible();
}

test("pair a phone with the QR link, set AGENCY up from it, and the person sees every change", async ({
  page: mac,
  browser,
}) => {
  const { link } = await showCode(mac);
  const ctx = await phoneContext(browser);
  const phone = await ctx.newPage();
  await pairPhone(phone, link, "Jordan", "Jordan");

  // Home: the person's screen is open on the Mac, so AGENCY is running.
  await expect(phone.getByText("AGENCY is running")).toBeVisible();
  await expect(phone.getByRole("navigation", { name: "Companion" })).toBeVisible();
  // The Mac lists the phone.
  await expect(mac.getByText(/gets Lifeline alerts as Jordan/)).toBeVisible();

  // Talk phrases are kept on the Mac: the Mac applies them and the person is told who changed what.
  await phone.getByRole("link", { name: "Set up", exact: true }).tap();
  await phone.getByRole("link", { name: /Talk phrases/ }).tap();
  await phone.getByLabel("New phrase").fill("Please turn me onto my side");
  await phone.getByRole("button", { name: "+ Add phrase" }).tap();
  await phone.getByRole("button", { name: "Save" }).tap();
  await expect(phone.getByRole("status")).toContainText("Sent to the Mac");
  await expect(mac.locator(".cmp-notice")).toContainText("Jordan: Talk phrases: added 1 phrase.");
  const boards = await mac.evaluate(() => JSON.parse(localStorage.getItem("agency.talk.boards") ?? "[]"));
  expect(boards.find((b: { id: string }) => b.id === "carers")).toEqual({
    id: "carers",
    title: "From your carers",
    phrases: ["Please turn me onto my side"],
  });
  await expect(mac.getByRole("region", { name: "Changes from phones" })).toContainText(
    "Talk phrases: added 1 phrase.",
  );

  // A practice contact applies at once.
  await phone.getByRole("link", { name: "‹ Set up" }).tap();
  await phone.getByRole("link", { name: /Lifeline contacts/ }).tap();
  await phone.getByRole("button", { name: "+ Add a person" }).tap();
  await phone.getByLabel("Name").last().fill("Sam");
  await phone.getByRole("button", { name: "Save" }).tap();
  await expect(phone.getByRole("status")).toContainText("Done. It shows on the AGENCY screen.");
  const settings = await coordinator.api<{ contacts: { name: string; channel: string }[] }>(
    "/api/lifeline/settings",
  );
  expect(settings.contacts.map((c) => c.name)).toContain("Sam");

  // A real phone number waits for the person, who allows it with one look on their screen.
  await phone.getByLabel("How Lifeline reaches them").last().selectOption("sms");
  await phone.getByLabel("Phone number, with country code").fill("+14155550123");
  await phone.getByRole("button", { name: "Save" }).tap();
  await expect(phone.getByRole("status")).toContainText("waits for the person");
  const ask = mac.getByRole("dialog", { name: /Jordan wants to change something/ });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("changed Sam");
  await ask.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(ask).toBeHidden();
  await expect
    .poll(async () => {
      const s = await coordinator.api<{ contacts: { name: string; channel: string }[] }>(
        "/api/lifeline/settings",
      );
      return s.contacts.find((c) => c.name === "Sam")?.channel;
    })
    .toBe("sms");

  // Safety: turning a protection on applies at once.
  await phone.getByRole("link", { name: "‹ Set up" }).tap();
  await phone.getByRole("link", { name: /Safety/ }).tap();
  await phone.getByLabel(/Check-ins/).selectOption("60");
  await phone.getByRole("button", { name: "Save" }).tap();
  await expect(phone.getByRole("status")).toContainText("Done");
  expect(
    (await coordinator.api<{ checkin_interval_min: number }>("/api/lifeline/settings")).checkin_interval_min,
  ).toBe(60);
  await ctx.close();
});

test("a message and photo appear big on the person's screen, and notes pass between shifts", async ({
  page: mac,
  browser,
}) => {
  const { link } = await showCode(mac);
  const ctx = await phoneContext(browser);
  const phone = await ctx.newPage();
  await pairPhone(phone, link, "Morgan", "Morgan");

  await phone.getByRole("link", { name: "Send", exact: true }).tap();
  await phone.getByLabel("Message").fill("Back at 6 with dinner");
  // A tiny PNG stands in for a photo from the camera roll; the phone shrinks it to a JPEG before sending.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  await phone
    .locator('input[type="file"]')
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
  await expect(phone.getByRole("img", { name: "The photo you're sending" })).toBeVisible();
  await phone.getByRole("button", { name: "Send to the screen" }).tap();
  await expect(phone.getByRole("status")).toContainText("Sent.");
  await expect(phone.getByText("Not seen yet")).toBeVisible();

  await mac.goto("/#/");
  const shown = mac.getByRole("dialog", { name: /From Morgan/ });
  await expect(shown).toBeVisible();
  await expect(shown).toContainText("Back at 6 with dinner");
  await expect(shown.getByRole("img", { name: "Photo from Morgan" })).toBeVisible();
  // While it shows, eye control can only select inside it.
  await expect(shown).toHaveAttribute("data-dwell-scope", "modal");
  await shown.getByRole("button", { name: "Got it" }).click();
  await expect(shown).toBeHidden();
  await expect(phone.getByText(/Seen at/)).toBeVisible({ timeout: 15_000 });

  // Hand-over notes: the phone writes one, the Mac reads it and adds another, the phone sees both.
  await phone.getByRole("link", { name: "Notes", exact: true }).tap();
  await phone.getByLabel("New note").fill("Slept well. Mask refitted at 6.");
  await phone.getByRole("button", { name: "Save note" }).tap();
  await expect(phone.getByRole("list", { name: "Notes" })).toContainText("Slept well. Mask refitted at 6.");
  await mac.goto("/#/settings/companion");
  const notes = mac.getByRole("region", { name: "Hand-over notes" });
  await expect(notes).toContainText("Slept well. Mask refitted at 6.");
  await notes.getByLabel("Leave a note for the next carer").fill("Nurse visit at 2.");
  // The eye keyboard comes up while a text box has focus; its Done puts it away (and submits the form it is in).
  await mac.getByRole("group", { name: "Eye keyboard" }).getByRole("button", { name: "Done" }).click();
  if (await notes.getByLabel("Leave a note for the next carer").inputValue())
    await notes.getByRole("button", { name: "Save note" }).click();
  await expect(notes).toContainText("At the Mac");
  await phone.reload();
  await expect(phone.getByRole("list", { name: "Notes" })).toContainText("Nurse visit at 2.");
  await ctx.close();
});

test("a Lifeline alert reaches the paired phone, which answers on the real response page", async ({
  page: mac,
  browser,
}) => {
  const { link } = await showCode(mac);
  const ctx = await phoneContext(browser);
  const phone = await ctx.newPage();
  await pairPhone(phone, link, "Jordan", "Jordan");

  await mac.goto("/#/");
  await mac.getByRole("button", { name: /Help: call for help/ }).click();
  await mac.getByRole("alertdialog").getByRole("button", { name: "Call now" }).click();

  const alert = phone.locator(".ph-alert");
  await expect(alert).toContainText("Riley needs help");
  await phone.getByRole("link", { name: "Open the alert" }).tap();
  await expect(phone).toHaveURL(/\/respond\//);
  await phone.getByRole("button", { name: "I'm on my way" }).tap();
  await expect(phone.getByText(/can see that you're on the way/)).toBeVisible();
  await expect(mac.getByRole("alertdialog")).toContainText(/Jordan/);
  const status = await coordinator.api<{ open_alert: { status: string; acknowledged_by: string } }>(
    "/api/lifeline/status",
  );
  expect(status.open_alert.status).toBe("acknowledged");
  expect(status.open_alert.acknowledged_by).toBe("Jordan");
  await ctx.close();
});

test("security: unpaired phones see nothing, wrong codes and bursts are refused, a removed phone is locked out", async ({
  page: mac,
  browser,
}) => {
  // Off: the phone server isn't even listening.
  const ctx = await phoneContext(browser);
  const phone = await ctx.newPage();
  await expect(phone.goto("/")).rejects.toThrow();

  const { code, link } = await showCode(mac);
  await phone.goto("/");
  await expect(phone.getByRole("heading", { name: "Pair with AGENCY" })).toBeVisible();
  for (const path of ["/phone/api/home", "/phone/api/setup", "/phone/api/notes"]) {
    const r = await phone.request.get(path);
    expect(r.status(), path).toBe(401);
  }
  expect((await phone.request.get("/api/lifeline/settings")).status()).toBe(404);

  // A wrong code is refused with tries left.
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  await phone.getByLabel("Code on the Mac").fill(wrong);
  await phone.getByLabel("Your name").fill("Mallory");
  await phone.getByRole("button", { name: "Pair this phone" }).tap();
  await expect(phone.getByRole("alert")).toContainText("That code is wrong. 4 tries left.");

  // Pair for real, then the Mac removes the phone: the phone goes back to pairing.
  // A wrong try doesn't use the code up, so the Mac still shows it; ask for a new one anyway.
  await mac.getByRole("button", { name: "New code" }).click();
  await expect(mac.locator(".cmp-code")).not.toHaveText(code);
  const fresh = ((await mac.locator(".cmp-code").textContent()) ?? "").trim();
  await pairPhone(phone, link.replace(/\d{6}$/, fresh), "Jordan", null);
  await mac.getByRole("button", { name: "Remove Jordan's phone" }).click();
  await expect(phone.getByRole("heading", { name: "Pair with AGENCY" })).toBeVisible({ timeout: 15_000 });
  expect(await phone.evaluate(() => localStorage.getItem("agency.companion.token"))).toBeNull();

  // Bursts of pairing tries from one address are cut off.
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await phone.request.post("/phone/api/pair", { data: { code: "000000", name: "Mallory" } });
    statuses.push(r.status());
  }
  expect(statuses).toContain(429);

  // Turning caregiver phones off stops the phone server.
  await mac.getByRole("button", { name: /Let carers' phones connect/ }).click();
  await expect(mac.getByRole("button", { name: /Let carers' phones connect/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(phone.request.get("/phone/api/home")).rejects.toThrow();
  await ctx.close();
});
