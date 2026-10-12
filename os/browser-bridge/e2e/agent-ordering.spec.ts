/**
 * End to end: the agent's ordering pack (os/agent) orders on the sandbox shops (os/sandbox-web: DashDish food,
 * ShopMart shopping) through the real AGENCY Bridge (extension + native host + BridgeServer) in Chromium, reached
 * the way the Mac app reaches it: the agent's bridge rpc (bridgeOverRpc) into the desktop's BridgeHost.agentCall,
 * which only passes the bridge's own fingerprint for a click the person approved.
 *
 * The test plays the person: it answers questions and approves only an approval whose total is what the store's
 * own pricing rules give. Outcomes are read from the sandbox's records, not from what the agent says. These are
 * sandbox sites: real DoorDash, Uber Eats, Amazon and Instacart are not and can't be tested here.
 */

import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent, ApprovalRequest, ChoiceQuestion } from "../../contracts/src/index.ts";
import { AuditLog } from "../../agent/src/audit.ts";
import { createOrderingPack } from "../../agent/src/packs/ordering/pack.ts";
import { DEFAULT_SETTINGS, type SafetySettings } from "../../agent/src/policy/settings.ts";
import { AgentRuntime } from "../../agent/src/runtime/runtime.ts";
import { bridgeOverRpc, RpcPort } from "../../agent/src/utility.ts";
import type { BridgeHost as BridgeHostType } from "../../desktop/src/main/bridge.ts";
import { computeTotals } from "../../sandbox-web/src/sites/food.ts";
import { shopTotals } from "../../sandbox-web/src/sites/shop.ts";
import type { BridgeServer } from "../src/app/server.ts";
import { startRig, type Rig } from "./harness.ts";

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const quiet = { info() {}, warn() {}, error() {}, raw() {} };

interface Person {
  choose?: (q: ChoiceQuestion) => string | undefined;
  /** Called with each approval as the person sees it; default: approve. */
  approve?: (a: ApprovalRequest, n: number) => "approve" | "decline" | "stop";
}

test.describe("the agent orders on the sandbox shops through the bridge", () => {
  let rig: Rig;
  let BridgeHost: typeof BridgeHostType;
  test.beforeAll(async () => {
    rig = await startRig();
    // os/desktop is CommonJS and this test runs as ESM, so the desktop's BridgeHost source is bundled first.
    const out = join(rig.dir, "bridge-host.mjs");
    await build({
      entryPoints: [join(import.meta.dirname, "../../desktop/src/main/bridge.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: out,
      logLevel: "silent",
    });
    ({ BridgeHost } = (await import(pathToFileURL(out).href)) as { BridgeHost: typeof BridgeHostType });
  });
  test.afterAll(async () => {
    await rig?.close();
  });
  test.beforeEach(async () => {
    rig.sandbox.reset();
    await rig.bridge.call("session.reset", {});
    const page = rig.context.pages()[0] ?? (await rig.context.newPage());
    await page.goto(rig.sandbox.url("food"));
    await page.bringToFront();
  });

  async function order(
    selections: Record<string, string>,
    person: Person = {},
    settings: Partial<SafetySettings> = {},
  ): Promise<{ end: AgentEvent | undefined; approvals: ApprovalRequest[]; questions: ChoiceQuestion[] }> {
    // The desktop's BridgeHost, on the rig's server (as in the app once the extension connected).
    const host = new BridgeHost({
      dir: rig.dir,
      hostScript: null,
      runtime: process.execPath,
      install: false,
      log: quiet,
      onTargets: () => undefined,
      onStopped: () => undefined,
    });
    (host as unknown as { server: BridgeServer }).server = rig.bridge;
    // The agent's own rpc client, answered by main's handler (here without Electron's IPC in between).
    const rpc: RpcPort = new RpcPort((m) => {
      const msg = m as { id: number; method: string; params: unknown };
      host.agentCall(msg.method, msg.params).then(
        (result) => rpc.settle({ id: msg.id, result }),
        (e: Error) => rpc.settle({ id: msg.id, error: e.message }),
      );
    });
    const s: SafetySettings = { ...DEFAULT_SETTINGS, ...settings };
    const runtime = new AgentRuntime({
      model: null,
      bridge: bridgeOverRpc(rpc),
      native: null,
      memory: null,
      packs: [
        createOrderingPack({ settings: () => s, sandboxPort: rig.sandbox.port, settleMs: 250, reads: 20 }),
      ],
      audit: new AuditLog(),
      settings: () => s,
    });
    const id = `t-${Date.now()}`;
    const events: AgentEvent[] = [];
    const approvals: ApprovalRequest[] = [];
    const questions: ChoiceQuestion[] = [];
    runtime.onEvent((e) => {
      events.push(e);
      if (e.type === "task.question") {
        questions.push(e.question);
        const label = person.choose?.(e.question);
        const opt = e.question.options.find((o) => o.label === label) ?? e.question.options[0]!;
        setTimeout(
          () =>
            void runtime.handle({
              type: "task.answer",
              taskId: id,
              questionId: e.question.id,
              optionId: opt.id,
            }),
          0,
        );
      }
      if (e.type === "approval.required") {
        approvals.push(e.approval);
        const d = person.approve?.(e.approval, approvals.length) ?? "approve";
        setTimeout(() => {
          if (d === "stop") {
            // What Stop does in the app: the agent and the extension, at once.
            void runtime.handle({ type: "stop.all" });
            host.stopAll();
            return;
          }
          void runtime.handle({
            type: "approval.decide",
            taskId: id,
            decision: { approvalId: e.approval.id, fingerprint: e.approval.fingerprint, decision: d },
          });
        }, 0);
      }
    });
    await runtime.handle({
      type: "task.start",
      request: { id, goal: "Order", origin: "flow", dryRun: true, selections },
    });
    const end = [...events].reverse().find((e) => /^task\.(done|failed|stopped)$/.test(e.type));
    return { end, approvals, questions };
  }

  const foodTotal = () => {
    const f = rig.sandbox.world().food;
    return computeTotals(f.cart.lines, f.tipPercent, f.tipCustomCents).totalCents;
  };
  const shopTotal = () => shopTotals(rig.sandbox.world().shop.cart).totalCents;
  const reason = (e: AgentEvent | undefined) => (e as { reason?: string } | undefined)?.reason ?? "";
  const outcome = (e: AgentEvent | undefined) => (e as { outcome?: string } | undefined)?.outcome ?? "";

  test("food: search, the required choice, cart, checkout, the exact approval, one order, the confirmation", async () => {
    const r = await order(
      { kind: "food", orderSite: "dashdish", orderQuery: "pad thai", restaurant: "Thai Basil" },
      {
        choose: (q) => (/protein/i.test(q.prompt) ? "Chicken" : undefined),
        approve: (a) => (a.details.Total === money(foodTotal()) ? "approve" : "decline"),
      },
    );
    expect(r.end?.type, reason(r.end)).toBe("task.done");
    expect(r.questions.map((q) => q.prompt)).toEqual(["Protein?"]);
    expect(r.approvals).toHaveLength(1);
    const a = r.approvals[0]!;
    expect(a.kind).toBe("purchase");
    expect(a.simulated).toBe(true);
    const o = rig.sandbox.world().food.orders;
    expect(o).toHaveLength(1);
    expect(a.details).toMatchObject({
      Site: "DashDish (sandbox), simulated",
      Restaurant: "Thai Basil",
      "Item 1": "1 × Pad thai (Protein: Chicken, Spice level: Mild): $13.50",
      Subtotal: "$13.50",
      "Delivery fee": "$2.99",
      "Service fee": "$1.50",
      "Estimated tax": "$1.20",
      Tip: "$2.03",
      Total: money(o[0]!.totalCents),
      "Deliver to": "12 Elm Street, Apt 3, Springfield",
      "Pay with": "Visa ending in 4242 (sandbox card) (saved on DashDish (sandbox))",
    });
    expect(o[0]!.totalCents).toBe(2122);
    expect(outcome(r.end)).toContain(`Order number ${o[0]!.id}`);
    expect(outcome(r.end)).toContain("Arriving in about 25–35 min");
    expect((r.end as { verified: boolean }).verified).toBe(true);
  });

  test("food: the tip changed after the approval, so the site refused, and the person was asked again", async () => {
    const r = await order(
      { kind: "food", orderSite: "dashdish", orderQuery: "pad thai", restaurant: "Thai Basil" },
      {
        approve: (_a, n) => {
          // Meanwhile the default tip went up (as if changed in another tab): the page still shows the old total.
          if (n === 1) rig.sandbox.world().food.tipPercent = 20;
          return "approve";
        },
      },
    );
    expect(r.end?.type, reason(r.end)).toBe("task.done");
    expect(r.approvals).toHaveLength(2);
    expect(r.approvals[0]!.details.Tip).toBe("$2.03");
    expect(r.approvals[1]!.details.Tip).toBe("$2.70");
    expect(r.approvals[0]!.fingerprint).not.toBe(r.approvals[1]!.fingerprint);
    const w = rig.sandbox.world();
    expect(w.food.orders).toHaveLength(1);
    expect(money(w.food.orders[0]!.totalCents)).toBe(r.approvals[1]!.details.Total);
    expect(w.events.filter((e) => e.type === "order.rejected")).toHaveLength(1);
  });

  test("food: a membership trial switched on at checkout stops it", async () => {
    rig.sandbox.world().food.plusOn = true;
    const r = await order({
      kind: "food",
      orderSite: "dashdish",
      orderQuery: "pad thai",
      restaurant: "Thai Basil",
    });
    expect(r.end?.type).toBe("task.failed");
    expect(reason(r.end)).toMatch(/DashDish Plus.*never sign anyone up/);
    expect(r.approvals).toHaveLength(0);
    expect(rig.sandbox.world().food.orders).toHaveLength(0);
  });

  test("food: Stop while the approval is open: nothing ordered", async () => {
    const r = await order(
      { kind: "food", orderSite: "dashdish", orderQuery: "pad thai", restaurant: "Thai Basil" },
      { approve: () => "stop" },
    );
    expect(r.end?.type).toBe("task.stopped");
    expect(rig.sandbox.world().food.orders).toHaveLength(0);
  });

  test("shopping: real options with prices, the membership pitch declined, the exact approval, one order", async () => {
    const r = await order(
      { kind: "shopping", orderSite: "shopmart", orderQuery: "paper towels" },
      {
        choose: () => "Sunny Day Paper Towels, 6 Double Rolls",
        approve: (a) => (a.details.Total === money(shopTotal()) ? "approve" : "decline"),
      },
    );
    expect(r.end?.type, reason(r.end)).toBe("task.done");
    expect(r.questions[0]!.prompt).toBe("Which paper towels?");
    expect(r.questions[0]!.options.map((o) => [o.label, o.description])).toEqual([
      ["Sunny Day Paper Towels, 6 Double Rolls", "$12.99"],
      ["Cloud Soft Paper Towels, 8 Big Rolls", "$15.49"],
      ["None of these", undefined],
    ]);
    const a = r.approvals[0]!;
    expect(a.details).toMatchObject({
      Site: "ShopMart (sandbox), simulated",
      "Item 1": "1 × Sunny Day Paper Towels, 6 Double Rolls: $12.99",
      Subtotal: "$12.99",
      "Shipping & handling": "$5.99",
      "Estimated tax": "$1.07",
      Total: "$20.05",
      "Ship to": "Jane Doe, 12 Elm Street, Springfield, IL 62704",
      "Pay with": "Visa ending in 4242 (sandbox card) (saved on ShopMart (sandbox))",
    });
    const w = rig.sandbox.world();
    expect(w.shop.orders).toHaveLength(1);
    expect(w.shop.orders[0]!.totalCents).toBe(2005);
    expect(w.shop.plusMember).toBe(false);
    expect(w.shop.subscriptions).toEqual([]);
    expect(w.events.some((e) => /opened$|plus\.joined|signin/.test(e.type))).toBe(false);
    expect(outcome(r.end)).toContain(`Order number ${w.shop.orders[0]!.id}`);
    expect(outcome(r.end)).toContain("Arriving tomorrow by 9 pm");
  });

  test("shopping: the price changed after approval: refused by the shop, approved again at the new total, one order", async () => {
    const r = await order(
      { kind: "shopping", orderSite: "shopmart", orderQuery: "paper towels" },
      {
        approve: (_a, n) => {
          if (n === 1) rig.sandbox.world().shop.priceOverrides["sunny-towels"] = 1399;
          return "approve";
        },
      },
    );
    expect(r.end?.type, reason(r.end)).toBe("task.done");
    expect(r.approvals.map((a) => a.details.Total)).toEqual(["$20.05", "$21.13"]);
    const w = rig.sandbox.world().shop;
    expect(w.orders).toHaveLength(1);
    expect(w.orders[0]!.totalCents).toBe(2113);
  });

  test("shopping: Subscribe & Save chosen, Plus ticked at checkout, sign-in and security code all stop it", async () => {
    const cases: [Record<string, boolean>, RegExp][] = [
      [{ subscribeDefault: true }, /Subscribe & Save.*never sign anyone up/],
      [{ plusOnAtCheckout: true }, /ShopMart Plus.*never sign anyone up/],
      [{ signedOut: true }, /sign in\. I never type passwords/],
      [{ askCvv: true }, /card details\. I never type card numbers/],
    ];
    for (const [flags, words] of cases) {
      rig.sandbox.reset();
      await rig.bridge.call("session.reset", {});
      Object.assign(rig.sandbox.world().shop, flags);
      const r = await order({ kind: "shopping", orderSite: "shopmart", orderQuery: "paper towels" });
      expect(r.end?.type, JSON.stringify(flags)).toBe("task.failed");
      expect(reason(r.end), JSON.stringify(flags)).toMatch(words);
      expect(r.approvals).toHaveLength(0);
      const w = rig.sandbox.world();
      expect(w.shop.orders).toHaveLength(0);
      expect(w.shop.subscriptions).toHaveLength(0);
      expect(w.events.some((e) => /plus\.joined|signin\.submitted/.test(e.type))).toBe(false);
    }
  });

  test("over the spending cap: refused in plain words before any approval", async () => {
    const r = await order(
      { kind: "shopping", orderSite: "shopmart", orderQuery: "paper towels" },
      {},
      { realOrdering: { enabled: false, maxOrder: 15 } },
    );
    expect(r.end?.type).toBe("task.failed");
    expect(reason(r.end)).toContain(
      "The total is $20.05, over your limit of $15.00 for one order. Nothing was ordered.",
    );
    expect(r.approvals).toHaveLength(0);
    expect(rig.sandbox.world().shop.orders).toHaveLength(0);
  });
});
