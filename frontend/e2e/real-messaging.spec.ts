/**
 * Real calls and texts as the Mac app shows them, with a stand-in for the Mac app's `window.agency` (its messaging
 * follows the main process's ticket rules; nothing reaches Messages or a phone). Off by default; once on, real saved
 * people come first; the approval shows the exact person and words, not simulated; only after the OK is it sent.
 */
import { expect, test, type Page } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.fakes", "memory,native");
    localStorage.setItem("agency.preferences", JSON.stringify({ reduced_motion: true }));
    localStorage.setItem("agency.fakeAgentDelayMs", "60");
    const log: { op: string; arg?: unknown }[] = [];
    let settings = { enabled: false, textVia: "auto", callVia: "phone" };
    const people = [{ id: "mom", name: "Mom", role: "family", display: "+1 (415) 555-0123" }];
    const tickets = new Map<string, string>();
    let n = 0;
    const status = async () => ({ available: true, settings, people: settings.enabled ? people : [] });
    (window as unknown as Record<string, unknown>).__sent = log;
    (window as unknown as Record<string, unknown>).agency = {
      role: "shell",
      agent: { send: () => {}, onEvent: () => () => {} },
      stopAll: async () => ({}),
      onStopAll: () => () => {},
      native: { call: async () => ({ ok: true, voices: [], apps: [] }) },
      permissions: { status: async () => ({}), request: async () => ({}), openSettings: async () => {} },
      messaging: {
        status,
        setSettings: async (s: Partial<typeof settings>) => {
          settings = { ...settings, ...s };
          return status();
        },
        check: async () => ({ imessage: true, sms: true, message: "Messages is ready." }),
        prepare: async (req: { kind: string; contactId: string; text?: string; textFirst?: boolean }) => {
          log.push({ op: "prepare", arg: req });
          if (!settings.enabled) return { ok: false, error: "off" };
          n += 1;
          tickets.set(`t${n}`, `fp${n}`);
          const text =
            req.kind === "text" ? req.text : req.textFirst ? "I'm calling you now through AGENCY." : null;
          return {
            ok: true,
            ticket: `t${n}`,
            fingerprint: `fp${n}`,
            kind: req.kind,
            person: people[0],
            text,
            via: "auto",
          };
        },
        send: async (ticket: string, fingerprint: string) => {
          const ok = tickets.get(ticket) === fingerprint;
          tickets.delete(ticket);
          log.push({ op: "send", arg: { ticket, fingerprint, ok } });
          return ok ? { ok: true, via: "imessage" } : { ok: false, error: "mismatch" };
        },
        cancel: async (ticket: string) => void tickets.delete(ticket),
      },
    };
  });
});

async function pick(page: Page, name: string | RegExp) {
  await page.getByRole("button", { name }).first().click();
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: { op: string }[] }).__sent);

test("off by default: only practice people; turned on in Settings, real people come first", async ({
  page,
}) => {
  await page.goto("/#/flow/messages");
  await expect(page.getByRole("button", { name: /Jordan.*Practice/ })).toBeVisible();
  await expect(page.getByText("Real ·")).toHaveCount(0);

  await page.goto("/#/settings/phone");
  await expect(page.getByRole("heading", { name: /Real calls and texts through your iPhone/ })).toBeVisible();
  const toggle = page.getByRole("button", { name: /Real calls and texts through your iPhone/ });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("+1 (415) 555-0123")).toBeVisible();
  await page.screenshot({ path: "test-results/real-messaging-settings.png", fullPage: true });

  await page.goto("/#/flow/messages");
  const first = page.locator(".flow-options .choice").first();
  await expect(first).toContainText("Mom");
  await expect(first).toContainText("Real · Family");
});

test("a real text shows the exact words, isn't simulated, and is sent only after the OK", async ({
  page,
}) => {
  await page.goto("/#/settings/phone");
  await page.getByRole("button", { name: /Real calls and texts through your iPhone/ }).click();
  await page.goto("/#/flow/messages");
  await pick(page, /Mom.*Real/);
  await pick(page, /Can you come by today\?/);
  const approval = page.getByTestId("approval");
  await expect(approval).toBeVisible();
  await expect(approval).toContainText("+1 (415) 555-0123");
  await expect(approval).toContainText("Can you come by today?");
  await expect(approval.getByText(/Simulated/)).toHaveCount(0);
  await expect(page.locator(".task-head .badge[data-tone=sim]")).toHaveCount(0);
  await page.screenshot({ path: "test-results/real-messaging-approval.png", fullPage: true });
  expect((await sent(page)).filter((e) => e.op === "send")).toEqual([]);

  await pick(page, "Approve");
  await page.getByRole("button", { name: /^Yes, send/ }).click();
  await expect(page.getByTestId("result")).toContainText("from your own number");
  expect((await sent(page)).filter((e) => e.op === "send")).toEqual([
    { op: "send", arg: { ticket: "t1", fingerprint: "fp1", ok: true } },
  ]);
});

test("a real call offers a text first and leads to Talk", async ({ page }) => {
  await page.goto("/#/settings/phone");
  await page.getByRole("button", { name: /Real calls and texts through your iPhone/ }).click();
  await page.goto("/#/flow/call");
  await pick(page, /Mom.*Real/);
  await pick(page, /Just to talk/);
  const approval = page.getByTestId("approval");
  await expect(approval).toContainText("I'm calling you now through AGENCY.");
  await page.screenshot({ path: "test-results/real-messaging-call.png", fullPage: true });
  await pick(page, "Approve");
  await page.getByRole("button", { name: /^Yes, / }).click();
  await expect(page.getByRole("button", { name: /Talk on the call/ })).toBeVisible();
});
