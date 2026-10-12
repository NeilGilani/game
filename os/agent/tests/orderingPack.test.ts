/**
 * The ordering pack against a fake DoorDash-like and Amazon-like site (tests/fixtures/orderSite.ts). The person is
 * played by the test: it answers questions and approvals the way it's told. Outcomes are read from the fake
 * site's own records (orders, clicks, typing), not from what the agent reports.
 */

import type { AgentEvent, ApprovalRequest, ChoiceQuestion, TaskRequest } from "@agency/contracts";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit";
import { createOrderingPack } from "../src/packs/ordering/pack";
import { onSite, REAL_SITES, sandboxSites, siteOrigins } from "../src/packs/ordering/sites";
import { DEFAULT_SETTINGS, type SafetySettings } from "../src/policy/settings";
import { AgentRuntime } from "../src/runtime/runtime";
import { FakeOrderSite, type SiteFlags } from "./fixtures/orderSite";

const ON: Partial<SafetySettings> = { realOrdering: { enabled: true, maxOrder: 60 } };

function foodRequest(extra: Record<string, string> = {}, dryRun = false): Omit<TaskRequest, "id"> {
  return {
    goal: "Order pad thai on DoorDash",
    origin: "flow",
    dryRun,
    selections: {
      kind: "food",
      orderSite: "doordash",
      orderQuery: "pad thai",
      restaurant: "Thai Basil",
      ...extra,
    },
  };
}

function shopRequest(): Omit<TaskRequest, "id"> {
  return {
    goal: "Buy paper towels on Amazon",
    origin: "flow",
    dryRun: false,
    selections: { kind: "shopping", orderSite: "amazon", orderQuery: "paper towels" },
  };
}

interface Person {
  /** Which option to pick, by label; default the first. */
  choose?: (q: ChoiceQuestion) => string | null;
  /** Default: approve. */
  approve?: (
    a: ApprovalRequest,
    n: number,
    site: FakeOrderSite,
  ) => "approve" | "decline" | { change: string };
  /** Called once when the first approval is shown (e.g. to press Stop). */
  onApproval?: (runtime: AgentRuntime, taskId: string) => void;
}

async function run(
  site: FakeOrderSite,
  request: Omit<TaskRequest, "id">,
  settings: Partial<SafetySettings> = ON,
  person: Person = {},
) {
  const s: SafetySettings = { ...DEFAULT_SETTINGS, ...settings };
  const runtime = new AgentRuntime({
    model: null,
    bridge: site,
    native: null,
    memory: null,
    packs: [createOrderingPack({ settings: () => s, settleMs: 1, reads: 3 })],
    audit: new AuditLog(),
    settings: () => s,
  });
  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const questions: ChoiceQuestion[] = [];
  const id = "t1";
  runtime.onEvent((e) => {
    events.push(e);
    if (e.type === "task.question") {
      questions.push(e.question);
      const label = person.choose?.(e.question);
      const opt =
        label === undefined ? e.question.options[0] : e.question.options.find((o) => o.label === label);
      queueMicrotask(
        () =>
          void runtime.handle({
            type: "task.answer",
            taskId: id,
            questionId: e.question.id,
            optionId: opt?.id ?? null,
          }),
      );
    }
    if (e.type === "approval.required") {
      approvals.push(e.approval);
      if (person.onApproval) {
        person.onApproval(runtime, id);
        return;
      }
      const d = person.approve?.(e.approval, approvals.length, site) ?? "approve";
      queueMicrotask(
        () =>
          void runtime.handle({
            type: "approval.decide",
            taskId: id,
            decision: {
              approvalId: e.approval.id,
              fingerprint: e.approval.fingerprint,
              decision: typeof d === "string" ? d : "change",
              ...(typeof d === "object" ? { change: d.change } : {}),
            },
          }),
      );
    }
  });
  await runtime.handle({ type: "task.start", request: { ...request, id } });
  const end = [...events].reverse().find((e) => /^task\.(done|failed|stopped)$/.test(e.type));
  return { events, approvals, questions, end, runtime };
}

describe("ordering sites: exact hosts, https only", () => {
  it("accepts the real sites' own hosts over https on the default port", () => {
    expect(onSite(REAL_SITES.doordash, "https://www.doordash.com/store/x/", 8787)).toBe(true);
    expect(onSite(REAL_SITES.amazon, "https://www.amazon.com/dp/B000000001", 8787)).toBe(true);
    expect(onSite(REAL_SITES.ubereats, "https://www.ubereats.com/checkout", 8787)).toBe(true);
    expect(onSite(REAL_SITES.instacart, "https://www.instacart.com/store/checkout_v3", 8787)).toBe(true);
  });

  it("refuses lookalikes, other subdomains, http, other ports and addresses with a user name", () => {
    const dd = REAL_SITES.doordash;
    for (const bad of [
      "http://www.doordash.com/",
      "https://www.doordash.com:8443/",
      "https://www.doordash.com.evil.example/",
      "https://doordash.co/",
      "https://identity.doordash.com/login",
      "https://evil.example/?https://www.doordash.com/",
      "https://user:pw@www.doordash.com/",
      "https://www.dооrdash.com/",
      "javascript:alert(1)",
      "not a url",
    ])
      expect(onSite(dd, bad, 8787), bad).toBe(false);
    expect(onSite(REAL_SITES.amazon, "https://www.amazon.co.uk/", 8787)).toBe(false);
  });

  it("sandbox shops are http on their own localhost name and port only", () => {
    const sb = sandboxSites(8787);
    expect(onSite(sb.dashdish, "http://food.localhost:8787/checkout", 8787)).toBe(true);
    expect(onSite(sb.dashdish, "http://food.localhost:9999/checkout", 8787)).toBe(false);
    expect(onSite(sb.dashdish, "http://bank.localhost:8787/", 8787)).toBe(false);
    expect(siteOrigins(sb.shopmart, 8787)).toEqual(["http://shop.localhost:8787"]);
    expect(siteOrigins(REAL_SITES.doordash, 8787)).toEqual([
      "https://www.doordash.com",
      "https://doordash.com",
    ]);
  });
});

describe("ordering pack: which requests and which settings", () => {
  const pack = createOrderingPack({ settings: () => DEFAULT_SETTINGS });
  const req = (selections: Record<string, string>): TaskRequest => ({
    id: "x",
    goal: "g",
    origin: "flow",
    selections,
  });

  it("takes only a food or shopping request naming a known site of the same kind", () => {
    expect(pack.matches(req({ kind: "food", orderSite: "doordash", orderQuery: "pad thai" }))).toBe(true);
    expect(pack.matches(req({ kind: "shopping", orderSite: "amazon", orderQuery: "soap" }))).toBe(true);
    expect(pack.matches(req({ kind: "food", orderSite: "amazon", orderQuery: "soap" }))).toBe(false);
    expect(pack.matches(req({ kind: "food", orderSite: "grubhub", orderQuery: "pizza" }))).toBe(false);
    expect(pack.matches(req({ kind: "food", orderSite: "constructor", orderQuery: "x" }))).toBe(false);
    expect(pack.matches(req({ kind: "food", orderSite: "doordash", orderQuery: " " }))).toBe(false);
    // The practice flows (no orderSite) stay with the practice agent.
    expect(pack.matches(req({ kind: "food", restaurant: "Thai Basil", dish: "Pad thai" }))).toBe(false);
  });

  it("narrows the guard to the one site and the ordering cap; real only when switched on", () => {
    const r = req({ kind: "food", orderSite: "doordash", orderQuery: "pad thai" });
    const off = pack.safety!(DEFAULT_SETTINGS, r);
    expect(off.siteAllowlist).toEqual(["https://www.doordash.com", "https://doordash.com"]);
    expect(off.simulatedOnly).toBe(true);
    const on = pack.safety!({ ...DEFAULT_SETTINGS, realOrdering: { enabled: true, maxOrder: 35 } }, r);
    expect(on.simulatedOnly).toBe(false);
    expect(on.maxPurchase).toBe(35);
    // Purchases turned off altogether stay off.
    expect(pack.safety!({ ...DEFAULT_SETTINGS, maxPurchase: null, ...ON }, r).maxPurchase).toBeNull();
    // A malformed setting is off.
    const odd = {
      ...DEFAULT_SETTINGS,
      realOrdering: { enabled: "yes", maxOrder: 60 },
    } as unknown as SafetySettings;
    expect(pack.safety!(odd, r).simulatedOnly).toBe(true);
  });
});

describe("ordering pack: food on a DoorDash-like site", () => {
  it("asks which restaurant and protein, shows the exact order, and places one order after approval", async () => {
    const site = new FakeOrderSite("food");
    const r = await run(site, foodRequest({ restaurant: "Somewhere fictional" }), ON, {
      choose: (q) => (/protein/i.test(q.prompt) ? "Chicken" : undefined) ?? q.options[0]!.label,
    });
    expect(r.end?.type).toBe("task.done");
    expect(site.orders).toHaveLength(1);
    // Real options with prices were offered.
    expect(r.questions[0]!.prompt).toBe("Which restaurant on DoorDash?");
    expect(r.questions[0]!.options.map((o) => o.label)).toEqual([
      "Thai Basil",
      "Bangkok Kitchen",
      "None of these",
    ]);
    expect(r.questions.some((q) => /protein/i.test(q.prompt))).toBe(true);
    // Pad Thai was the one full match on the menu, so it wasn't asked.
    expect(r.questions.some((q) => /Which one/.test(q.prompt))).toBe(false);

    expect(r.approvals).toHaveLength(1);
    const a = r.approvals[0]!;
    expect(a.kind).toBe("purchase");
    expect(a.simulated).toBe(false);
    const total = `$${(site.orders[0]!.totalCents / 100).toFixed(2)}`;
    expect(a.details).toMatchObject({
      Site: "DoorDash",
      Restaurant: "Thai Basil",
      "Item 1": "1 × Pad Thai (Chicken): $15.99",
      Subtotal: "$15.99",
      "Delivery Fee": "$2.99",
      "Service Fee": "$2.40",
      "Estimated Tax": "$1.40",
      Tip: "$2.40",
      Total: total,
      "Deliver to": "12 Elm Street, Apt 3",
      "Pay with": "Visa ending in 4242 (saved on DoorDash)",
      "Your limit": "$60.00 per order",
    });
    expect(a.summary).toContain(total);

    const done = r.end as Extract<AgentEvent, { type: "task.done" }>;
    expect(done.verified).toBe(true);
    expect(done.outcome).toContain("Order number 1234-5678");
    expect(done.outcome).toContain("Estimated arrival 6:45 PM");
    expect(done.outcome).toContain(total);
    // Only Place order was pressed as an approved click, once. Nothing was ever typed.
    expect(site.clicks.filter((c) => c.endsWith("(approved)"))).toEqual(["Place Order (approved)"]);
    expect(site.typed).toEqual([]);
    // It never opened anything but DoorDash.
    expect(site.navigations.every((u) => u.startsWith("https://www.doordash.com/"))).toBe(true);
  });

  it("a price change after approval means a new approval with the new total, and still one order", async () => {
    const site = new FakeOrderSite("food", { priceUpOnPlace: true });
    const r = await run(site, foodRequest(), ON, { choose: (q) => q.options[0]!.label });
    expect(r.end?.type).toBe("task.done");
    expect(r.approvals).toHaveLength(2);
    const [first, second] = r.approvals as [ApprovalRequest, ApprovalRequest];
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.details.Total).not.toBe(second.details.Total);
    expect(site.orders).toHaveLength(1);
    expect(`$${(site.orders[0]!.totalCents / 100).toFixed(2)}`).toBe(second.details.Total);
    expect(site.clicks.filter((c) => c.endsWith("(approved)"))).toHaveLength(2);
  });

  it("the page changing between approval and click needs the person again (the old approval isn't used)", async () => {
    const site = new FakeOrderSite("food");
    const r = await run(site, foodRequest(), ON, {
      approve: (_a, n, s) => {
        // The person approves, but the restaurant raised the price meanwhile (the page re-reads it).
        if (n === 1) s.raisePrice(200);
        return "approve";
      },
    });
    expect(r.approvals).toHaveLength(2);
    expect(r.approvals[0]!.details.Total).not.toBe(r.approvals[1]!.details.Total);
    expect(site.orders).toHaveLength(1);
    expect(`$${(site.orders[0]!.totalCents / 100).toFixed(2)}`).toBe(r.approvals[1]!.details.Total);
  });

  it("Change lets the person pick another tip, then asks again with the new total", async () => {
    const site = new FakeOrderSite("food");
    const r = await run(site, foodRequest(), ON, {
      choose: (q) => (q.prompt === "What tip?" ? "20%" : q.options[0]!.label),
      approve: (_a, n) => (n === 1 ? { change: "tip" } : "approve"),
    });
    expect(r.end?.type).toBe("task.done");
    expect(r.approvals).toHaveLength(2);
    expect(r.approvals[0]!.details.Tip).toBe("$2.40");
    expect(r.approvals[1]!.details.Tip).toBe("$3.20");
    expect(site.orders).toEqual([expect.objectContaining({ tipCents: 320 })]);
  });

  it("No means nothing is ordered", async () => {
    const site = new FakeOrderSite("food");
    const r = await run(site, foodRequest(), ON, { approve: () => "decline" });
    expect(r.end).toMatchObject({ type: "task.failed" });
    expect((r.end as { reason: string }).reason).toContain("You said no, so nothing was ordered.");
    expect(site.orders).toHaveLength(0);
  });

  it("over the spending cap: refused in plain words before any approval", async () => {
    const site = new FakeOrderSite("food", { priceCents: 5200 });
    const r = await run(site, foodRequest(), ON);
    expect(r.approvals).toHaveLength(0);
    expect(site.orders).toHaveLength(0);
    expect((r.end as { reason: string }).reason).toMatch(
      /The total is \$\d+\.\d\d, over your limit of \$60\.00 for one order\. Nothing was ordered\./,
    );
  });

  it("a membership switched on at checkout stops it; nothing is ordered", async () => {
    const site = new FakeOrderSite("food", { membershipOn: true });
    const r = await run(site, foodRequest());
    expect(r.approvals).toHaveLength(0);
    expect(site.orders).toHaveLength(0);
    expect((r.end as { reason: string }).reason).toMatch(/never sign anyone up/);
  });

  for (const [flag, words] of [
    ["loginWall", /sign in.*never type passwords.*helper/i],
    ["captcha", /robot check.*helper/i],
    ["cvv", /card details.*never type card numbers/i],
  ] as const) {
    it(`stops and asks for a helper on ${flag}, never typing anything`, async () => {
      const site = new FakeOrderSite("food", { [flag]: true } as SiteFlags);
      const r = await run(site, foodRequest());
      expect(r.end?.type).toBe("task.failed");
      expect((r.end as { reason: string }).reason).toMatch(words);
      expect(r.approvals).toHaveLength(0);
      expect(site.orders).toHaveLength(0);
      expect(site.typed).toEqual([]);
    });
  }

  it("never follows a store link to another site", async () => {
    const site = new FakeOrderSite("food", { offsiteStore: true });
    const r = await run(site, foodRequest());
    expect(site.orders).toHaveLength(0);
    expect(site.navigations.some((u) => u.includes("evil"))).toBe(false);
    expect(r.end?.type).toBe("task.failed");
  });

  it("real ordering off: refused before opening anything", async () => {
    const site = new FakeOrderSite("food");
    const r = await run(site, foodRequest(), {});
    expect((r.end as { reason: string }).reason).toMatch(/Ordering for real is off/);
    expect(site.navigations).toEqual([]);
  });

  it("a practice (dry run) request never orders on a real site", async () => {
    const site = new FakeOrderSite("food");
    const r = await run(site, foodRequest({}, true));
    expect((r.end as { reason: string }).reason).toMatch(/started as practice/);
    expect(site.navigations).toEqual([]);
  });

  it("a later time is asked about first: it only orders for as soon as possible", async () => {
    const site = new FakeOrderSite("food");
    const r = await run(site, foodRequest({ when: "At 7 pm" }), ON, { choose: () => "No, not now" });
    expect(r.questions[0]!.prompt).toMatch(/only order for as soon as possible/);
    expect(site.navigations).toEqual([]);
    expect(site.orders).toHaveLength(0);
  });

  it("Stop while the approval is open: nothing is ordered and the approval can't be used", async () => {
    const site = new FakeOrderSite("food");
    let pending: ApprovalRequest | undefined;
    const r = await run(site, foodRequest(), ON, {
      onApproval: (rt, id) => {
        pending = rt.gate.pending(id);
        void rt.handle({ type: "stop.all" });
      },
    });
    expect(r.end?.type).toBe("task.stopped");
    expect(site.orders).toHaveLength(0);
    // Deciding afterwards does nothing.
    await r.runtime.handle({
      type: "approval.decide",
      taskId: "t1",
      decision: { approvalId: pending!.id, fingerprint: pending!.fingerprint, decision: "approve" },
    });
    expect(site.orders).toHaveLength(0);
  });

  it("no confirmation after Place order: finished but not confirmed, said plainly", async () => {
    const site = new FakeOrderSite("food", { silentPlace: true });
    const r = await run(site, foodRequest());
    expect(r.end).toMatchObject({ type: "task.done", verified: false });
    expect((r.end as { outcome: string }).outcome).toMatch(
      /couldn't read a confirmation\. Please check your orders on DoorDash/,
    );
    expect(site.orders).toHaveLength(1);
  });
});

describe("ordering pack: shopping on an Amazon-like site", () => {
  it("asks which product (with prices), declines the protection-plan upsell, orders once", async () => {
    const site = new FakeOrderSite("shopping", { protectionUpsell: true });
    const r = await run(site, shopRequest());
    expect(r.end?.type).toBe("task.done");
    const q = r.questions[0]!;
    expect(q.prompt).toBe("Which paper towels?");
    expect(q.options.map((o) => [o.label, o.description])).toEqual([
      ["Bounty Paper Towels, 6 Double Rolls", "$12.99"],
      ["Viva Paper Towels, 6 Big Rolls", "$11.49"],
      ["None of these", undefined],
    ]);
    expect(site.clicks).toContain("No thanks");
    expect(site.clicks.some((c) => /subscribe|protection/i.test(c))).toBe(false);
    expect(r.approvals[0]!.details).toMatchObject({
      Site: "Amazon",
      Store: "Amazon",
      "Item 1": "1 × Bounty Paper Towels, 6 Double Rolls: $12.99",
      "Ship to": "Jane Doe, 12 Elm Street, Springfield",
      Tip: "No tip shown",
      "Pay with": "Visa ending in 4242 (saved on Amazon)",
    });
    expect(site.orders).toHaveLength(1);
    expect((r.end as { outcome: string }).outcome).toContain("Order number 112-3456789-0001");
  });

  it("Subscribe & Save already chosen: stops (switching it off would itself read as a purchase)", async () => {
    const site = new FakeOrderSite("shopping", { subscribeChosen: true });
    const r = await run(site, shopRequest());
    expect(r.end?.type).toBe("task.failed");
    expect((r.end as { reason: string }).reason).toMatch(
      /Subscribe & Save.*never sign anyone up.*one-time purchase/,
    );
    expect(r.approvals).toHaveLength(0);
    expect(site.orders).toHaveLength(0);
    expect(site.clicks.some((c) => /subscribe|one-time/i.test(c))).toBe(false);
  });
});
