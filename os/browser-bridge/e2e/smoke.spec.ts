import { expect, test } from "@playwright/test";
import { startRig, type Rig } from "./harness.ts";

let rig: Rig;
test.beforeAll(async () => {
  rig = await startRig();
});
test.afterAll(async () => {
  await rig?.close();
});

test("the extension pairs with AGENCY through the native host and lists tabs", async () => {
  const status = await rig.bridge.call("bridge.status", {});
  expect(status.protocol).toBe(1);
  const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("food") });
  const tabs = await rig.bridge.call("tabs.list", {});
  expect(tabs.untrusted).toBe(true);
  expect(tabs.data.find((t) => t.tabId === tabId)?.title).toContain("DashDish");
});
