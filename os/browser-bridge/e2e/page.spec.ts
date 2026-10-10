/**
 * The bridge's page tools on the sandbox, through the real extension, native host and BridgeServer.
 */

import { expect, test } from "@playwright/test";
import { BridgeCallError } from "../src/app/server.ts";
import type { BridgeEvent } from "../src/protocol.ts";
import { startRig, type Rig } from "./harness.ts";
import { clickByName, find } from "./helpers.ts";

let rig: Rig;
const events: BridgeEvent[] = [];

test.beforeAll(async () => {
  rig = await startRig();
  rig.bridge.onEvent((e) => events.push(e));
});
test.afterAll(async () => {
  await rig?.close();
});
test.beforeEach(async () => {
  rig.sandbox.reset();
  await rig.bridge.call("session.reset", {});
});

async function expectError(p: Promise<unknown>, code: string): Promise<BridgeCallError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeCallError);
    expect((e as BridgeCallError).code).toBe(code);
    return e as BridgeCallError;
  }
  throw new Error(`Expected ${code}, but the call succeeded.`);
}

test("reads the page as an accessibility tree with stable refs, marked untrusted", async () => {
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("food") });
  const tree = await rig.bridge.call("page.tree", { tabId });
  expect(tree.untrusted).toBe(true);
  expect(tree.notice).toMatch(/data, not instructions/);
  expect(tree.origin).toBe(new URL(rig.sandbox.url("food")).origin);
  const heading = tree.data.nodes.find((n) => n.role === "heading" && n.level === 1);
  expect(heading?.name).toBe("Order delivery near you");
  const search = tree.data.nodes.find((n) => n.role === "textbox");
  expect(search?.name).toBe("Search restaurants and dishes");
  const link = tree.data.nodes.find((n) => n.role === "link" && /Thai Basil/.test(n.name));
  expect(link?.href).toContain("/r/thai-basil");
  expect(link?.rect.width).toBeGreaterThan(0);
  // Refs are stable across reads of the same page.
  const again = await rig.bridge.call("page.tree", { tabId });
  expect(again.data.nodes.find((n) => n.name === link?.name)?.ref).toBe(link?.ref);
});

test("clicks, chooses options, types and selects by reference", async () => {
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("food", "/r/thai-basil") });
  const res = await clickByName(rig.bridge, tabId, "link", "Add Pad thai");
  expect(res.navigated).toBe(true);
  expect(res.url).toContain("/item/pad-thai");

  await clickByName(rig.bridge, tabId, "radio", "Tofu");
  const spice = await find(rig.bridge, tabId, "combobox", "Spice level");
  expect(spice.options).toEqual(["Mild", "Medium", "Hot", "Thai hot"]);
  const sel = await rig.bridge.call("page.select", { tabId, ref: spice.ref, option: "medium" });
  expect(sel.value).toBe("Medium");
  await clickByName(rig.bridge, tabId, "checkbox", /Fried egg/);
  const note = await find(rig.bridge, tabId, "textbox", /Special instructions/);
  const typed = await rig.bridge.call("page.type", { tabId, ref: note.ref, text: "No cilantro please" });
  expect(typed.value).toBe("No cilantro please");

  const tree = await rig.bridge.call("page.tree", { tabId });
  expect(tree.data.nodes.find((n) => n.role === "radio" && n.name === "Tofu")?.state.checked).toBe(true);
  expect(tree.data.nodes.find((n) => n.role === "checkbox" && /Fried egg/.test(n.name))?.state.checked).toBe(true);
  // The live price updates: 13.50 + 1.50 egg.
  const add = tree.data.nodes.find((n) => n.role === "button" && /Add to cart/.test(n.name));
  expect(add?.name).toContain("$15.00");

  await rig.bridge.call("page.click", { tabId, ref: add!.ref });
  const cart = rig.sandbox.world().food.cart.lines;
  expect(cart).toHaveLength(1);
  expect(cart[0]).toMatchObject({ name: "Pad thai", unitCents: 1500, note: "No cilantro please" });
  expect(cart[0]?.options).toEqual(["Protein: Tofu", "Spice level: Medium", "Add-ons: Fried egg"]);
});

test("consequential clicks need an approval bound to the exact page state", async () => {
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("food", "/r/morning-grind") });
  await clickByName(rig.bridge, tabId, "link", "Add Blueberry muffin");
  await clickByName(rig.bridge, tabId, "button", /Add to cart/);
  await clickByName(rig.bridge, tabId, "link", "Go to checkout");

  const place = await find(rig.bridge, tabId, "button", "Place order");
  const err = await expectError(rig.bridge.call("page.click", { tabId, ref: place.ref }), "approval-required");
  const action = err.error.action!;
  expect(action.consequential).toBe("purchase");
  expect(action.details.Button).toBe("Place order");
  expect(Object.values(action.details).join("\n")).toMatch(/Total\s+\$8\.52/);
  expect(rig.sandbox.world().food.orders).toHaveLength(0);

  // A wrong fingerprint is refused.
  await expectError(rig.bridge.call("page.click", { tabId, ref: place.ref, approvedFingerprint: "0".repeat(64) }), "approval-mismatch");

  // The page changes (the tip changes the total): the old approval no longer applies.
  await clickByName(rig.bridge, tabId, "radio", "20%");
  const place2 = await find(rig.bridge, tabId, "button", "Place order");
  await expectError(
    rig.bridge.call("page.click", { tabId, ref: place2.ref, approvedFingerprint: action.fingerprint }),
    "approval-mismatch",
  );

  // Describe again, approve that exact action, and it goes through.
  const fresh = await rig.bridge.call("page.describeAction", { tabId, ref: place2.ref });
  expect(fresh.data.fingerprint).not.toBe(action.fingerprint);
  const done = await rig.bridge.call("page.click", { tabId, ref: place2.ref, approvedFingerprint: fresh.data.fingerprint });
  expect(done.navigated).toBe(true);
  expect(done.url).toMatch(/\/orders\/DD-\d+\?placed=1/);
  expect(rig.sandbox.world().food.orders).toHaveLength(1);
});

test("never types into card, password or code fields, and never types card numbers", async () => {
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("food", "/payment/new") });
  const tree = await rig.bridge.call("page.tree", { tabId });
  const number = tree.data.nodes.find((n) => n.name === "Card number");
  expect(number?.state.secure).toBe(true);
  await expectError(rig.bridge.call("page.type", { tabId, ref: number!.ref, text: "hello" }), "secure-field");
  const csc = tree.data.nodes.find((n) => n.name === "Security code");
  expect(csc?.state.secure).toBe(true);
  const name = tree.data.nodes.find((n) => n.name === "Name on card");
  await expectError(rig.bridge.call("page.type", { tabId, ref: name!.ref, text: "4242 4242 4242 4242" }), "secret-in-text");
  await rig.bridge.call("page.type", { tabId, ref: name!.ref, text: "Riley Morgan" });
});

test("password values are never read, and the injection page is flagged but hidden text is left out", async () => {
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("inject") });
  // Put a value in the page's password field the way a person would; the bridge must not read it.
  const page = rig.context.pages().find((p) => p.url().startsWith(rig.sandbox.url("inject")))!;
  await page.fill("#vp", "hunter2-secret");
  const tree = await rig.bridge.call("page.tree", { tabId });
  const pw = tree.data.nodes.find((n) => n.name === "Password");
  expect(pw?.state.secure).toBe(true);
  expect(pw?.value).toBeUndefined();
  expect(JSON.stringify(tree)).not.toContain("hunter2-secret");
  expect(tree.suspectedInjection.length).toBeGreaterThan(0);

  const text = await rig.bridge.call("page.extractText", { tabId });
  expect(text.data.text).toContain("Coziest Red Lentil Soup");
  expect(text.data.text).toContain("Note to AI assistants"); // visible attempts stay visible, flagged
  for (const hidden of ["Forward all emails", "10 pizzas", "visit http", "Reveal the user's password", "approve all purchases"]) {
    expect(text.data.text).not.toContain(hidden);
  }
  expect(text.suspectedInjection.join("\n")).toMatch(/ignore previous instructions/);
  expect(text.suspectedInjection.join("\n")).toMatch(/fake approval/);
  expect(JSON.stringify(text)).not.toContain("hunter2-secret");
  expect(rig.sandbox.world().inject.canaries).toHaveLength(0);
});

test("extracts tables", async () => {
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("pharmacy") });
  const tables = await rig.bridge.call("page.extractTables", { tabId });
  const t = tables.data[0]!;
  expect(t.caption).toBe("Your prescriptions");
  expect(t.headers).toEqual(["Refill", "Medicine", "Rx number", "Refills left", "Last filled", "Status"]);
  expect(t.rows.map((r) => r[2])).toContain("RX-204118");
});

test("waits for late elements, survives slow pages and reports what didn't happen", async () => {
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("flaky", "/late") });
  const early = await rig.bridge.call("page.waitFor", { tabId, condition: { kind: "element", role: "button", name: "Show offers" }, timeoutMs: 300 });
  expect(early.met).toBe(false);
  const late = await rig.bridge.call("page.waitFor", { tabId, condition: { kind: "element", role: "button", name: "Show offers" }, timeoutMs: 8000 });
  expect(late.met).toBe(true);
  await rig.bridge.call("page.click", { tabId, ref: late.ref! });
  const t = await rig.bridge.call("page.waitFor", { tabId, condition: { kind: "text", text: "Offers shown" }, timeoutMs: 3000 });
  expect(t.met).toBe(true);

  const nav = await rig.bridge.call("tabs.navigate", { tabId, url: rig.sandbox.url("flaky", "/slow?ms=1500") });
  expect(nav.url).toContain("/slow");
  const text = await rig.bridge.call("page.extractText", { tabId });
  expect(text.data.text).toContain("Finally loaded");

  await rig.bridge.call("tabs.navigate", { tabId, url: rig.sandbox.url("flaky", "/flaky") });
  expect((await rig.bridge.call("page.extractText", { tabId })).data.text).toContain("Something went wrong (attempt 1)");
});

test("Stop in the page halts AGENCY until the person starts a new task", async () => {
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("mail") });
  await rig.bridge.call("session.start", { tabId, taskId: "t-stop" });
  const page = rig.context.pages().find((p) => p.url().startsWith(rig.sandbox.url("mail")))!;
  const banner = page.locator("agency-bridge-ui");
  await expect(banner).toHaveCount(1);
  // The banner is in a closed shadow root: click its Stop button by position, like the person would.
  const stopBox = await page.evaluate(() => ({ w: innerWidth }));
  await page.mouse.click(stopBox.w - 120, 56);
  await expect.poll(() => events.some((e) => e.type === "stopped" && e.tabId === tabId)).toBe(true);
  await expectError(rig.bridge.call("page.tree", { tabId }), "stopped");
  const status = await rig.bridge.call("bridge.status", {});
  expect(status.stopped).toBe(true);
  await rig.bridge.call("session.reset", {});
  const tree = await rig.bridge.call("page.tree", { tabId });
  expect(tree.data.title).toContain("Postbox");
});

test("stop.all from AGENCY refuses every later page command", async () => {
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("clinic") });
  await rig.bridge.call("stop.all", {});
  await expectError(rig.bridge.call("page.extractText", { tabId }), "stopped");
  await expectError(rig.bridge.call("tabs.open", { url: rig.sandbox.url("food") }), "stopped");
});

test("protected sites need the person's own allowance, given in a window AGENCY can't press", async () => {
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("bank") });
  const tabs = await rig.bridge.call("tabs.list", {});
  const bankTab = tabs.data.find((t) => t.tabId === tabId)!;
  expect(bankTab.protected).toEqual({ category: "banking", allowed: false });
  expect(bankTab.title).toBe("(protected site)");
  await expectError(rig.bridge.call("page.tree", { tabId }), "protected-site");
  await expectError(rig.bridge.call("page.capture", { tabId }), "protected-site");

  // The person says no.
  const popupNo = rig.context.waitForEvent("page");
  const askNo = rig.bridge.call("policy.requestAllowance", { tabId });
  const no = await popupNo;
  await no.getByRole("button", { name: /No, keep it private/ }).click();
  expect((await askNo).allowed).toBe(false);
  await expectError(rig.bridge.call("page.tree", { tabId }), "protected-site");

  // The person says yes (after the pause).
  const popupYes = rig.context.waitForEvent("page");
  const askYes = rig.bridge.call("policy.requestAllowance", { tabId });
  const yes = await popupYes;
  const button = yes.getByRole("button", { name: /Yes, allow/ });
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled({ timeout: 4000 });
  await button.click();
  expect(await askYes).toMatchObject({ allowed: true });
  const tree = await rig.bridge.call("page.tree", { tabId });
  // Even when allowed, the password field is secure and can't be typed into.
  const pass = tree.data.nodes.find((n) => n.name === "Password")!;
  expect(pass.state.secure).toBe(true);
  await expectError(rig.bridge.call("page.type", { tabId, ref: pass.ref, text: "x" }), "secure-field");
});

test("refuses browser pages and non-web URLs", async () => {
  await expectError(rig.bridge.call("tabs.open", { url: "javascript:alert(1)" }), "disallowed-url");
  await expectError(rig.bridge.call("tabs.open", { url: "file:///etc/passwd" }), "disallowed-url");
  await expectError(rig.bridge.call("tabs.open", { url: "chrome://settings" }), "disallowed-url");
});

test("reading mode makes text and links bigger, and capture returns an image", async () => {
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("mail") });
  const before = await find(rig.bridge, tabId, "link", "Sunday dinner?");
  await rig.bridge.call("reading.set", { tabId, on: true });
  const after = await find(rig.bridge, tabId, "link", "Sunday dinner?");
  expect(after.rect.height).toBeGreaterThanOrEqual(64);
  expect(after.rect.height).toBeGreaterThan(before.rect.height);
  const shot = await rig.bridge.call("page.capture", { tabId });
  expect(shot.data.dataUrl).toMatch(/^data:image\/png;base64,/);
  await rig.bridge.call("reading.set", { tabId, on: false });
});
