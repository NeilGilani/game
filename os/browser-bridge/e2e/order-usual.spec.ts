/**
 * End to end: Instance 8's ordering pack orders the person's usual meal on the sandbox store through the
 * real AGENCY Bridge (extension + native host + BridgeServer) in Chromium, with an approval of the exact
 * total. The test plays the person: it approves only if the approval shows exactly the total the store's
 * own pricing rules give for that cart.
 *
 * Instance 8's code is loaded from os/tasks once it is on main, or from AGENCY_TASKS_DIR (for example an
 * export of the os-8/tasks branch) until then. Without it this file is skipped and says so.
 */

import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { computeTotals } from "../../sandbox-web/src/sites/food.ts";
import { DashDishBridgeStore, formatCents } from "../src/stores/dashdish.ts";
import { startRig, type Rig } from "./harness.ts";

const TASKS = process.env.AGENCY_TASKS_DIR ?? resolve(import.meta.dirname, "../../tasks");
const HAVE_TASKS = existsSync(join(TASKS, "src", "packs", "ordering.ts"));

/* eslint-disable @typescript-eslint/no-explicit-any -- Instance 8's modules are loaded at run time. */
async function loadPack(): Promise<{ createOrderingPack: any; FakeMemory: any; encodeItems: any; runPack: any; ofType: any }> {
  const imp = (p: string) => import(pathToFileURL(join(TASKS, p)).href);
  const [ordering, memory, store, helpers] = await Promise.all([
    imp("src/packs/ordering.ts"),
    imp("src/memory/client.ts"),
    imp("src/ordering/store.ts"),
    imp("tests/helpers.ts"),
  ]);
  return { createOrderingPack: ordering.createOrderingPack, FakeMemory: memory.FakeMemory, encodeItems: store.encodeItems, runPack: helpers.runPack, ofType: helpers.ofType };
}

test.describe("order the usual meal through the bridge", () => {
  test.skip(!HAVE_TASKS, `Instance 8's ordering pack isn't in ${TASKS}; set AGENCY_TASKS_DIR.`);
  let rig: Rig;
  test.beforeAll(async () => {
    rig = await startRig();
  });
  test.afterAll(async () => {
    await rig?.close();
  });
  test.beforeEach(async () => {
    rig.sandbox.reset();
    await rig.bridge.call("session.reset", {});
  });

  async function setup() {
    const m = await loadPack();
    const usual = m.encodeItems([
      { itemId: "pad-thai", qty: 1, optionIds: ["mild"] },
      { itemId: "spring-rolls", qty: 1, optionIds: [] },
    ]);
    const memory = new m.FakeMemory(
      {},
      {
        "food/delivery/thai-basil": {
          nodeId: "n1",
          path: ["food", "delivery", "Thai Basil"],
          label: "Usual Friday dinner",
          score: 0.9,
          reason: "You chose this 4 of your last 5 Fridays.",
          task: { goal: "Order my usual", selections: { items: usual } },
        },
      },
    );
    const store = new DashDishBridgeStore(rig.bridge, new URL(rig.sandbox.url("food")).origin);
    const pack = m.createOrderingPack({ store, memory, limits: { perOrderCents: 5000, perDayCents: 10000 } });
    return { m, store, pack };
  }

  /** What the store's own rules say the total is for the cart as it stands now. */
  function storeTotal(): number {
    const f = rig.sandbox.world().food;
    return computeTotals(f.cart.lines, f.tipPercent, f.tipCustomCents).totalCents;
  }

  test("orders the usual with an approval of the exact total, and verifies the confirmation", async () => {
    const { m, pack } = await setup();
    const seenApprovals: Array<Record<string, string>> = [];
    const { events, last } = await m.runPack(
      pack,
      { goal: "Order my usual Friday dinner" },
      {
        answer: (q: { prompt: string; options: Array<{ id: string }> }) =>
          q.prompt === "Your usual?" ? "usual" : q.prompt.startsWith("Subtotal") ? "18" : q.options.at(-1)!.id,
        approve: (_summary: string, details: Record<string, string>) => {
          seenApprovals.push(details);
          // The person approves only the exact total the store will charge for this cart.
          return details.Total === formatCents(storeTotal()) ? "approve" : "decline";
        },
      },
    );
    expect(last).toMatchObject({ type: "task.done", verified: true });
    const approval = m.ofType(events, "approval.required")[0].approval;
    expect(approval.kind).toBe("purchase");
    expect(approval.simulated).toBe(true); // the sandbox store moves no real money
    expect(approval.details["Item 1"]).toBe("1 × Pad thai (Protein: Chicken, Spice level: Mild): $13.50");
    expect(approval.details["Item 2"]).toBe("1 × Spring rolls (4): $6.95");
    expect(seenApprovals).toHaveLength(1);

    const orders = rig.sandbox.world().food.orders;
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    // 20.45 subtotal + 2.99 delivery + 2.05 service + 1.81 tax + 3.68 tip (18%) = 30.98
    expect(o.totalCents).toBe(3098);
    expect(approval.details.Total).toBe(formatCents(o.totalCents));
    expect(o.lines.map((l) => [l.name, l.options])).toEqual([
      ["Pad thai", ["Protein: Chicken", "Spice level: Mild"]],
      ["Spring rolls (4)", []],
    ]);
    expect(o.payment).toBe("Visa ending in 4242 (sandbox card)");
    expect(last.outcome).toContain(o.id);
  });

  test("if the cart changes after approval, nothing is paid until the person approves the new total", async () => {
    const { m, pack } = await setup();
    let approvals = 0;
    const { events, last } = await m.runPack(
      pack,
      { goal: "Order my usual" },
      {
        answer: (q: { prompt: string; options: Array<{ id: string }> }) =>
          q.prompt === "Your usual?" ? "usual" : q.prompt.startsWith("Subtotal") ? "0" : q.options.at(-1)!.id,
        approve: () => {
          approvals++;
          if (approvals === 1) {
            // While the person is approving, someone adds a drink to the cart in the store.
            const f = rig.sandbox.world().food;
            f.cart.lines.push({ lineId: 99, itemId: "thai-iced-tea", name: "Thai iced tea", options: ["Ice: Regular ice"], qty: 1, unitCents: 450, note: "" });
          }
          return "approve";
        },
      },
    );
    const asked = m.ofType(events, "approval.required").map((e: { approval: { details: Record<string, string> } }) => e.approval.details.Total);
    expect(asked).toHaveLength(2);
    expect(asked[0]).not.toBe(asked[1]);
    const orders = rig.sandbox.world().food.orders;
    expect(orders).toHaveLength(1);
    expect(formatCents(orders[0]!.totalCents)).toBe(asked[1]);
    expect(last).toMatchObject({ type: "task.done", verified: true });
  });

  test("declining leaves nothing ordered and the cart empty", async () => {
    const { m, pack } = await setup();
    const { last } = await m.runPack(
      pack,
      { goal: "Order my usual" },
      {
        answer: (q: { prompt: string; options: Array<{ id: string }> }) =>
          q.prompt === "Your usual?" ? "usual" : q.prompt.startsWith("Subtotal") ? "15" : q.options.at(-1)!.id,
        approve: () => "decline",
      },
    );
    expect(last.type).toBe("task.done");
    expect(rig.sandbox.world().food.orders).toHaveLength(0);
    expect(rig.sandbox.world().food.cart.lines).toHaveLength(0);
  });
});
