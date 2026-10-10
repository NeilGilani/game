/**
 * Every Home flow end to end with the in-page fakes (agent, memory, apps): a few big choices make a task, the agent
 * plans it, asks for an approval with the exact details, and the result is shown as checked. All simulated.
 */
import { type Page, expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.fakes", "memory,agent,native");
    localStorage.setItem("agency.fakeAgentDelayMs", "100");
  });
});

const pick = (page: Page, name: string | RegExp) =>
  page
    .getByRole("button", {
      name:
        typeof name === "string" ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`) : name,
    })
    .first()
    .click();

async function approve(page: Page, yes: RegExp) {
  await expect(page.getByTestId("approval")).toBeVisible();
  await pick(page, "Approve");
  await expect(page.getByRole("button", { name: "One moment…" })).toBeDisabled();
  await pick(page, yes);
  await expect(page.getByTestId("result")).toContainText("Done, and checked");
}

test("Home: tiles, usuals with reasons, and a usual done in one look plus an approval", async ({ page }) => {
  await page.goto("/#/");
  await expect(
    page.getByRole("button", { name: /Your usual: Pad thai.*4 of the last 5 Fridays/ }),
  ).toBeVisible();
  for (const t of [
    "Talk",
    "Call someone",
    "Food",
    "Papers",
    "Shopping",
    "Messages",
    "Watch & listen",
    "Browse",
    "Apps",
    "Lifeline",
    "Settings",
  ])
    await expect(page.getByRole("button", { name: new RegExp(`^${t.replace("&", "&")}:`) })).toBeVisible();
  await pick(page, /Your usual: Pad thai/);
  await approve(page, /Yes, pay · \$24.80/);
  await pick(page, "Home");
  await expect(page).toHaveURL(/#\/$/);
});

test("food: choices, a question as cards, change makes a new approval, decline does nothing", async ({
  page,
}) => {
  await page.goto("/#/flow/food");
  await pick(page, "Pizza");
  await pick(page, "Margherita pizza");
  await pick(page, "At 7 pm");
  await pick(page, "Mild");
  await expect(page.getByTestId("approval")).toContainText("$19.00");
  await pick(page, "Change");
  await pick(page, "Deliver to");
  await pick(page, "Front desk");
  await expect(page.getByTestId("approval")).toContainText("Front desk");
  await pick(page, "Decline");
  await expect(page.getByText(/Nothing was paid/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("call, messages (typed), papers, shopping comparison, browse and watch all end in a checked task", async ({
  page,
}) => {
  await page.goto("/#/flow/call");
  await pick(page, "Jordan");
  await pick(page, "Just to talk");
  await approve(page, /Yes, call · Jordan/);

  await page.goto("/#/flow/messages");
  await pick(page, "Mom");
  await pick(page, "Write my own");
  await page.getByRole("textbox").fill("See you Sunday");
  await pick(page, "Done");
  await expect(page.getByTestId("approval")).toContainText("See you Sunday");
  await approve(page, /Yes, send/);

  await page.goto("/#/flow/papers");
  await pick(page, "Sign a document");
  await pick(page, "Lease renewal");
  await approve(page, /Yes, sign/);

  await page.goto("/#/flow/shopping");
  await pick(page, "Medical supplies");
  await pick(page, "Mask cushions");
  await expect(page.getByText("Arrives").first()).toBeVisible();
  await pick(page, /MedDirect/);
  await approve(page, /Yes, pay · \$35.00/);

  await page.goto("/#/flow/browse");
  await pick(page, "Weather");
  await expect(page.getByTestId("result")).toContainText("Done, and checked");

  await page.goto("/#/flow/watch");
  await pick(page, "YouTube");
  await pick(page, "My subscriptions");
  await expect(page.getByTestId("result")).toBeVisible();
});

test("back, paging-free screens, Stop mid-task, and Continue on Home", async ({ page }) => {
  await page.goto("/#/flow/food");
  await pick(page, "Thai");
  await pick(page, "Back");
  await expect(page.getByRole("heading", { name: "What would you like to eat?" })).toBeVisible();
  await pick(page, "Thai");
  await pick(page, "Pad thai");
  await pick(page, "As soon as possible");
  await expect(page.getByRole("heading", { name: "How spicy?" })).toBeVisible();
  await pick(page, "Home");
  await expect(
    page.getByRole("button", { name: /Continue: Order Pad thai.*Waiting for your choice/ }),
  ).toBeVisible();
  await pick(page, /Continue:/);
  await pick(page, "Stop this task");
  await expect(page.getByText("Nothing more will happen with this task.")).toBeVisible();
});

test("apps: launch from the flow, switch on the Apps screen (simulated in the browser)", async ({ page }) => {
  await page.goto("/#/flow/apps");
  await pick(page, "Mail");
  await expect(page.getByRole("heading", { name: /Mail is open \(simulated/ })).toBeVisible();
  await page.goto("/#/apps?view=all");
  await pick(page, /Music/);
  await expect(page.getByText(/Music is open/).first()).toBeVisible();
});

test("settings hub, talk and onboarding are reachable by big choices", async ({ page }) => {
  await page.goto("/#/settings");
  for (const n of [
    "How you choose",
    "Calibrate my eyes",
    "Voice",
    "What AGENCY remembers",
    "Lifeline",
    "For a helper",
  ])
    await expect(page.getByRole("button", { name: new RegExp(n) })).toBeVisible();
  await pick(page, /What AGENCY remembers/);
  await pick(page, /Call Jordan/);
  await expect(page.getByText("Forgot Call Jordan.").first()).toBeVisible();
  await page.goto("/#/onboarding");
  await pick(page, "Start");
  await expect(page.getByRole("heading", { name: "What AGENCY needs to work" })).toBeVisible();
  await expect(page.getByText(/Browser: not needed/).first()).toBeVisible();
});
