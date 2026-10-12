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
  // The visible outcome (a polite live region announces the same words for screen readers).
  await expect(page.locator(".task-big").getByText(/Nothing was paid/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("call, messages (typed), papers and shopping end in their task; browse and watch open the site", async ({
  page,
}) => {
  await page.goto("/#/flow/call");
  await pick(page, "Jordan");
  await pick(page, "Just to talk");
  // Calls are a task pack: the flow hands over to Talk's call screen.
  await expect(page).toHaveURL(/#\/talk\/call/);

  await page.goto("/#/flow/messages");
  await pick(page, "Mom");
  await pick(page, "Write my own");
  await page.getByRole("textbox").fill("See you Sunday");
  // The eye keyboard is up while typing (covering the page's Done): its own Done puts it away.
  await page.getByRole("group", { name: "Eye keyboard" }).getByRole("button", { name: "Done" }).click();
  await pick(page, "Done");
  await expect(page.getByTestId("approval")).toContainText("See you Sunday");
  await approve(page, /Yes, send/);

  await page.goto("/#/flow/papers");
  await pick(page, "Sign a document");
  await pick(page, "Lease renewal");
  // Documents are a task pack too: signing happens in Talk's papers screen.
  await expect(page).toHaveURL(/#\/talk\/papers/);

  await page.goto("/#/flow/shopping");
  await pick(page, "Medical supplies");
  await pick(page, "Mask cushions");
  await expect(page.getByText("Arrives").first()).toBeVisible();
  await pick(page, /MedDirect/);
  await approve(page, /Yes, pay · \$35.00/);

  // Browse and Watch & listen open the real (allow-listed) site in a new tab, and say so. The sites are stood in
  // for here, so the test needs no network.
  await page
    .context()
    .route(/^https:\/\/(weather\.com|www\.youtube\.com)\//, (r) =>
      r.fulfill({ contentType: "text/html", body: "<title>stand-in</title>" }),
    );
  await page.goto("/#/flow/browse");
  let tab = page.waitForEvent("popup");
  await pick(page, "Weather");
  const weather = await tab;
  await weather.waitForLoadState();
  expect(weather.url()).toBe("https://weather.com/");
  await expect(page.getByRole("heading", { name: "Today's weather is open in your browser." })).toBeVisible();

  await page.goto("/#/flow/watch");
  await pick(page, "YouTube");
  tab = page.waitForEvent("popup");
  await pick(page, "My subscriptions");
  const youtube = await tab;
  await youtube.waitForLoadState();
  expect(youtube.url()).toBe("https://www.youtube.com/feed/subscriptions");
  await expect(page.getByRole("heading", { name: /is open in your browser\.$/ })).toBeVisible();
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

test("apps: in the browser, opening says it needs the AGENCY Mac app, never pretends", async ({ page }) => {
  await page.goto("/#/flow/apps");
  await pick(page, "Mail");
  await expect(
    page.getByRole("heading", { name: /Couldn't open Mail: opening Mac apps needs the AGENCY Mac app/ }),
  ).toBeVisible();
  await page.goto("/#/apps?view=all");
  await pick(page, /Music/);
  await expect(
    page.getByText(/Couldn't open Music: opening Mac apps needs the AGENCY Mac app/).first(),
  ).toBeVisible();
});

test("settings hub, talk and onboarding are reachable by big choices", async ({ page }) => {
  await page.goto("/#/settings");
  for (const n of ["How you choose", "Calibrate my eyes", "Voice", "What AGENCY remembers", "Gaze lab"])
    await expect(page.getByRole("button", { name: new RegExp(n) })).toBeVisible();
  await pick(page, "More settings");
  for (const n of ["Lifeline", "For a helper"])
    await expect(page.getByRole("button", { name: new RegExp(n) })).toBeVisible();
  await pick(page, "Previous settings");
  await pick(page, /What AGENCY remembers/);
  await pick(page, /Call Jordan/);
  await expect(page.getByText("Forgot Call Jordan.").first()).toBeVisible();
  await page.goto("/#/onboarding");
  await pick(page, "Start");
  await expect(page.getByRole("heading", { name: "What AGENCY needs to work" })).toBeVisible();
  await expect(page.getByText(/Browser: not needed/).first()).toBeVisible();
});

test("every Home tile opens its flow or screen", async ({ page }) => {
  const expected: [string, RegExp, string | RegExp][] = [
    ["Talk", /#\/talk$/, "Say something"],
    ["Call someone", /#\/flow\/call$/, "Who do you want to call?"],
    ["Food", /#\/flow\/food$/, "What would you like to eat?"],
    ["Messages", /#\/flow\/messages$/, "Who is it for?"],
    ["Watch & listen", /#\/flow\/watch$/, "What would you like?"],
    ["Browse", /#\/flow\/browse$/, "Where to?"],
    ["Shopping", /#\/flow\/shopping$/, "What do you need?"],
    ["Papers", /#\/flow\/papers$/, "What do you need to do?"],
    ["Apps", /#\/flow\/apps$/, "Which app?"],
    ["Errands", /#\/errands$/, "Repairs, rides and appointments"],
    ["Lifeline", /#\/lifeline$/, /Call for help/],
    ["Settings", /#\/settings$/, "What would you like to change?"],
  ];
  for (const [tile, url, heading] of expected) {
    await page.goto("/#/");
    await page.getByRole("button", { name: new RegExp(`^${tile}:`) }).click();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
});
