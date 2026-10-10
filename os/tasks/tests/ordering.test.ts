import { describe, expect, it } from "vitest";
import { FakeMemory } from "../src/memory/client";
import { FakeSandboxStore, decodeItems, encodeItems } from "../src/ordering/store";
import { createOrderingPack } from "../src/packs/ordering";
import { ofType, runPack } from "./helpers";

const USUAL = encodeItems([
  { itemId: "pad-thai", qty: 1, optionIds: ["mild"] },
  { itemId: "spring-rolls", qty: 1, optionIds: [] },
]);

function setup(opts: ConstructorParameters<typeof FakeSandboxStore>[0] = {}, limit = 5000) {
  const store = new FakeSandboxStore(opts);
  const memory = new FakeMemory(
    {},
    {
      "food/delivery/thai-basil": {
        nodeId: "n1",
        path: ["food", "delivery", "Thai Basil"],
        label: "Usual Friday dinner",
        score: 0.9,
        reason: "You chose this 4 of your last 5 Fridays.",
        task: { goal: "Order my usual", selections: { items: USUAL } },
      },
    },
  );
  const pack = createOrderingPack({ store, memory, limits: { perOrderCents: limit, perDayCents: 10000 } });
  return { store, memory, pack };
}

describe("items encoding", () => {
  it("round-trips and rejects junk", () => {
    expect(decodeItems(USUAL)).toEqual([
      { itemId: "pad-thai", qty: 1, optionIds: ["mild"] },
      { itemId: "spring-rolls", qty: 1, optionIds: [] },
    ]);
    expect(() => decodeItems("pad-thai*0")).toThrow();
    expect(() => decodeItems("bad item!")).toThrow();
  });
});

describe("ordering pack", () => {
  it("orders the usual with an approval of the exact items and total, and verifies", async () => {
    const { store, pack, memory } = setup();
    const { events, last } = await runPack(
      pack,
      { goal: "Order my usual Friday dinner" },
      {
        answer: (q) =>
          q.prompt === "Your usual?"
            ? "usual"
            : q.prompt.startsWith("Subtotal")
              ? "18"
              : q.options.at(-1)!.id,
      },
    );
    expect(last).toMatchObject({ type: "task.done", verified: true });
    const q = ofType(events, "task.question")[0]!.question;
    expect(q.options[0]!.suggestedBecause).toMatch(/4 of your last 5 Fridays/);
    const approval = ofType(events, "approval.required")[0]!.approval;
    expect(approval.kind).toBe("purchase");
    expect(approval.simulated).toBe(true);
    expect(approval.details["Item 1"]).toBe("1 × Pad thai (Mild): $14.50");
    expect(approval.details["Item 2"]).toBe("1 × Spring rolls (4): $6.50");
    // 21.00 + 2.99 delivery + 1.05 service + 1.68 tax + 3.78 tip = 30.50
    expect(approval.details.Total).toBe("$30.50");
    expect(approval.details["Pay with"]).toMatch(/saved on the site/);
    expect(store.orders).toHaveLength(1);
    expect(store.orders[0]!.totalCents).toBe(3050);
    expect(memory.events.at(-1)).toMatchObject({ surface: "food", outcome: "completed" });
  });

  it("asks again when the total changes after approval, and never pays the old total", async () => {
    const { store, pack } = setup({ priceChangeAfterReview: true });
    const { events, last } = await runPack(
      pack,
      { goal: "Order", selections: { items: USUAL } },
      { answer: (q) => (q.prompt.startsWith("Subtotal") ? "0" : q.options.at(-1)!.id) },
    );
    const approvals = ofType(events, "approval.required").map((e) => e.approval);
    expect(approvals).toHaveLength(2);
    expect(approvals[0]!.fingerprint).not.toBe(approvals[1]!.fingerprint);
    expect(approvals[1]!.details["Delivery fee"]).toBe("$4.99");
    expect(store.orders[0]!.totalCents).toBe(Number(approvals[1]!.details.Total!.replace(/[$.]/g, "")));
    expect(last).toMatchObject({ type: "task.done", verified: true });
  });

  it("refuses over the spending limit before asking for approval", async () => {
    const { store, pack } = setup({}, 2000);
    const { events, last } = await runPack(
      pack,
      { goal: "Order", selections: { items: USUAL } },
      { answer: () => "20" },
    );
    expect(last.type === "task.failed" && last.reason).toMatch(/over your limit of \$20.00/);
    expect(ofType(events, "approval.required")).toEqual([]);
    expect(store.orders).toEqual([]);
  });

  it("refuses when there is no saved payment method (never asks for a card)", async () => {
    const { store, pack } = setup({ noSavedPayment: true });
    const { last } = await runPack(
      pack,
      { goal: "Order", selections: { items: USUAL } },
      { answer: () => "0" },
    );
    expect(last.type === "task.failed" && last.reason).toMatch(/never types card numbers/);
    expect(store.orders).toEqual([]);
  });

  it("declining empties the cart and orders nothing", async () => {
    const { store, pack } = setup();
    const { last } = await runPack(
      pack,
      { goal: "Order", selections: { items: USUAL } },
      { answer: () => "0", approve: () => "decline" },
    );
    expect(last).toMatchObject({ type: "task.done", outcome: "Nothing was ordered. The cart was emptied." });
    expect(store.orders).toEqual([]);
    expect((await store.cart()).lines).toEqual([]);
  });

  it("can pick from the menu with options when there's no usual", async () => {
    const store = new FakeSandboxStore();
    const pack = createOrderingPack({ store, limits: { perOrderCents: 5000 } });
    const answers = ["green-curry", "mild", "done", "15", "no"];
    const { last } = await runPack(pack, { goal: "Order food" }, { answer: () => answers.shift()! });
    expect(last).toMatchObject({ type: "task.done", verified: true });
    expect(store.orders[0]!.lines).toEqual([{ name: "Green curry", qty: 1, options: ["Mild"] }]);
  });

  it("offers tracking after a verified order", async () => {
    const { pack } = setup();
    const { events } = await runPack(
      pack,
      { goal: "Order", selections: { items: USUAL } },
      {
        answer: (q) => (q.prompt.startsWith("Subtotal") ? "15" : q.options[0]!.id),
      },
    );
    expect(
      ofType(events, "task.step").some((s) => /TB-1001: confirmed, 35 to 45 minutes/.test(s.summary)),
    ).toBe(true);
  });
});
