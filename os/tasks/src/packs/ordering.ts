/**
 * The ordering pack: food and shopping. It builds the cart from the person's usual (memory
 * tree), shows every item, fee, the tip and the total, enforces the spending limit in code,
 * and places the order only with an approval bound to those exact items and that total.
 * If anything changes after approval, it asks again. It never enters card numbers: only a
 * payment method already saved on the site. It verifies the order confirmation and offers
 * tracking.
 */

import type { TaskRequest } from "../contracts";
import { PolicyRefusal, type PackContext, type PackOutcome, type TaskPack } from "../core/pack";
import type { MemoryClient } from "../memory/client";
import { decodeItems, type Cart, type MenuItem, type StoreClient, type WantedItem } from "../ordering/store";
import { checkSpending, formatMoney, tipCents, type SpendingLimits } from "../policy/money";

export interface OrderingPackDeps {
  store: StoreClient;
  limits: SpendingLimits;
  /** Spent today through AGENCY, for the daily limit. */
  spentTodayCents?: () => number;
  memory?: MemoryClient;
}

export const TIP_CHOICES = [15, 18, 20, 0];

export function describeLine(l: { name: string; qty: number; options: string[] }): string {
  return `${l.qty} × ${l.name}${l.options.length ? ` (${l.options.join(", ")})` : ""}`;
}

/** The exact, comparable content of a cart that an approval binds to. */
export function cartTerms(storeId: string, cart: Cart, paymentMethodId: string) {
  return {
    store: storeId,
    lines: cart.lines.map((l) => ({ name: l.name, qty: l.qty, options: l.options, lineCents: l.lineCents })),
    fees: cart.fees,
    tipCents: cart.tipCents,
    totalCents: cart.totalCents,
    deliverTo: cart.deliverTo,
    paymentMethodId,
  };
}

function wantedLabel(items: WantedItem[], menu: MenuItem[]): string {
  return items
    .map((w) => {
      const m = menu.find((x) => x.id === w.itemId);
      const opts = w.optionIds.map((id) => m?.options?.find((o) => o.id === id)?.label ?? id);
      return `${w.qty} × ${m?.name ?? w.itemId}${opts.length ? ` (${opts.join(", ")})` : ""}`;
    })
    .join(", ");
}

export function createOrderingPack(deps: OrderingPackDeps): TaskPack {
  const { store, limits, memory } = deps;

  async function chooseItems(
    ctx: PackContext,
    request: TaskRequest,
    menu: MenuItem[],
  ): Promise<WantedItem[]> {
    if (request.selections?.items) return decodeItems(request.selections.items);
    const usual = await memory?.usual(`food/delivery/${store.storeId}`);
    const usualItems = usual?.task?.selections.items;
    if (usual && usualItems) {
      const items = decodeItems(usualItems);
      const a = await ctx.ask({
        prompt: "Your usual?",
        options: [
          { id: "usual", label: wantedLabel(items, menu), suggestedBecause: usual.reason },
          { id: "other", label: "Something else" },
        ],
      });
      if (a.optionId === "usual") return items;
    }
    const picked: WantedItem[] = [];
    for (;;) {
      const page = menu.slice(0, 5);
      const a = await ctx.ask({
        prompt: picked.length
          ? `Added. Anything else? (${wantedLabel(picked, menu)})`
          : "What would you like?",
        options: [
          ...page.map((m) => ({ id: m.id, label: m.name, description: formatMoney(m.priceCents) })),
          { id: "done", label: picked.length ? "That's all" : "Never mind" },
        ],
      });
      if (!a.optionId || a.optionId === "done") return picked;
      const item = menu.find((m) => m.id === a.optionId)!;
      const optionIds: string[] = [];
      if (item.options?.length) {
        const o = await ctx.ask({
          prompt: `How would you like the ${item.name}?`,
          options: [
            ...item.options.slice(0, 5).map((x) => ({
              id: x.id,
              label: x.label,
              ...(x.priceCents ? { description: `+${formatMoney(x.priceCents)}` } : {}),
            })),
            { id: "as-is", label: "As it comes" },
          ],
        });
        if (o.optionId && o.optionId !== "as-is") optionIds.push(o.optionId);
      }
      picked.push({ itemId: item.id, qty: 1, optionIds });
    }
  }

  return {
    id: "ordering",
    title: "Food and shopping",
    description:
      "Order your usual (or something new) with every item, fee, tip and total shown before you approve.",
    surfaces: ["food", "shopping"],
    goals: ["Order my usual Friday dinner", "Order pad thai from Thai Basil"],
    tools: [
      { name: "store.read", description: "Read the menu, cart and saved payment methods", risk: "read" },
      {
        name: "cart.build",
        description: "Put the chosen items in the cart and set the tip",
        risk: "reversible",
      },
      {
        name: "order.place",
        description: "Place the order with a saved payment method",
        risk: "consequential",
        kind: "purchase",
      },
    ],
    policies: [
      {
        id: "exact-approval",
        rule: "The approval binds to the exact items, fees, tip, total, address and payment method.",
      },
      {
        id: "reapprove-on-change",
        rule: "If the cart changes after approval, the order isn't placed and a new approval is needed.",
      },
      {
        id: "spending-limit",
        rule: "Orders over the per-order or daily limit are refused; a helper can change the limit.",
      },
      {
        id: "no-card-numbers",
        rule: "Never enters card numbers: only a payment method already saved on the site.",
      },
      { id: "verify", rule: "Reports the order as placed only after reading back the store's confirmation." },
    ],
    approvals: [
      { kind: "purchase", bindsTo: ["items", "fees", "tip", "total", "delivery address", "payment method"] },
    ],
    verification: [{ check: "The store reports a confirmed order with the approved items and total." }],
    honesty: {
      real: [
        "Cart review, spending limits, approval binding, re-approval on change and read-back verification are tested.",
      ],
      simulated: [
        "The store is the in-memory sandbox (Thai Basil) until Instance 5's sandbox site and the Bridge adapter land.",
      ],
      untested: [
        "Real stores through the AGENCY Bridge.",
        "Order tracking beyond the sandbox's single status.",
      ],
    },
    matches: (r: TaskRequest) =>
      /\b(order|food|dinner|lunch|breakfast|buy|shop|groceries)\b/i.test(r.goal) ? 0.75 : 0,

    async run(ctx: PackContext, request: TaskRequest): Promise<PackOutcome> {
      ctx.plan([
        { id: "choose", title: "Choose what to order", risk: "read" },
        { id: "cart", title: "Put it in the cart", risk: "reversible" },
        { id: "review", title: "Review items, fees, tip and total", risk: "read" },
        { id: "approve", title: "You approve the exact total", risk: "consequential" },
        { id: "place", title: "Place the order and check the confirmation", risk: "consequential" },
      ]);
      const menu = await ctx.exec("store.read", { what: "menu" }, () => store.menu());
      ctx.step("choose", "running", `Shopping at ${store.storeName}`);
      const items = await chooseItems(ctx, request, menu);
      if (items.length === 0) {
        ctx.step("choose", "skipped", "Nothing chosen");
        return { outcome: "Nothing was ordered.", verified: true };
      }
      ctx.step("choose", "done", wantedLabel(items, menu));

      ctx.step("cart", "running", "Adding to the cart");
      await ctx.exec("cart.build", { items }, async () => {
        await store.clearCart();
        for (const i of items) await store.addToCart(i.itemId, i.qty, i.optionIds);
      });
      let cart = await ctx.exec("store.read", { what: "cart" }, () => store.cart());
      ctx.step("cart", "done", cart.lines.map(describeLine).join(", "));

      ctx.step("review", "running", "Choose a tip");
      const tip = await ctx.ask({
        prompt: `Subtotal ${formatMoney(cart.subtotalCents)}. Add a tip for the driver?`,
        options: TIP_CHOICES.map((p) => ({
          id: String(p),
          label: p ? `${p}% (${formatMoney(tipCents(cart.subtotalCents, p))})` : "No tip",
        })),
      });
      const percent = Number(tip.optionId ?? 0);
      await ctx.exec("cart.build", { tipPercent: percent }, () =>
        store.setTip(tipCents(cart.subtotalCents, percent)),
      );

      const methods = await ctx.exec("store.read", { what: "payment" }, () => store.savedPaymentMethods());
      const method = methods[0];
      if (!method)
        throw new PolicyRefusal(
          "This store has no saved payment method. AGENCY never types card numbers. A helper can add one on the store's site, then try again.",
          "no-card-numbers",
        );

      for (let attempt = 0; attempt < 3; attempt++) {
        cart = await ctx.exec("store.read", { what: "cart" }, () => store.cart());
        const limit = checkSpending(cart.totalCents, deps.spentTodayCents?.() ?? 0, limits);
        if (!limit.ok) {
          ctx.step("review", "failed", limit.message);
          throw new PolicyRefusal(limit.message, "spending-limit");
        }
        ctx.step("review", "done", `Total ${formatMoney(cart.totalCents)}`);
        const terms = cartTerms(store.storeId, cart, method.id);
        const details: Record<string, string> = {};
        cart.lines.forEach(
          (l, i) => (details[`Item ${i + 1}`] = `${describeLine(l)}: ${formatMoney(l.lineCents)}`),
        );
        details.Subtotal = formatMoney(cart.subtotalCents);
        for (const f of cart.fees) details[f.label] = formatMoney(f.cents);
        details.Tip = formatMoney(cart.tipCents);
        details.Total = formatMoney(cart.totalCents);
        details["Deliver to"] = cart.deliverTo;
        details["Pay with"] = `${method.label} (saved on the site)`;
        details["Your limit"] = `${formatMoney(limits.perOrderCents)} per order`;
        ctx.step("approve", "waiting", "Waiting for your approval");
        const answer = await ctx.approve({
          kind: "purchase",
          summary: `Pay ${formatMoney(cart.totalCents)} to ${store.storeName} for ${cart.lines.map(describeLine).join(", ")}, delivered to ${cart.deliverTo}`,
          details,
          action: { tool: "order.place", args: terms },
          simulated: store.kind === "sandbox",
        });
        if (!answer.approved) {
          ctx.step("approve", "skipped", "You didn't approve.");
          await ctx.exec("cart.build", { clear: true }, () => store.clearCart());
          return { outcome: "Nothing was ordered. The cart was emptied.", verified: true };
        }
        ctx.step("approve", "done", "Approved");

        // Re-read right before placing: the approval covers these exact terms only.
        const latest = await ctx.exec("store.read", { what: "cart" }, () => store.cart());
        const latestTerms = cartTerms(store.storeId, latest, method.id);
        if (JSON.stringify(latestTerms) !== JSON.stringify(terms)) {
          ctx.note(
            `The store changed the order after you approved it (total ${formatMoney(cart.totalCents)} → ${formatMoney(latest.totalCents)}). Nothing was paid. Please look again.`,
          );
          continue;
        }
        ctx.step("place", "running", "Placing the order");
        const { orderId } = await ctx.exec(
          "order.place",
          terms,
          () => store.placeOrder({ paymentMethodId: method.id, expectedTotalCents: terms.totalCents }),
          answer.grant,
        );
        const status = await ctx.exec("store.read", { what: "order", orderId }, () => store.order(orderId));
        const verified =
          !!status &&
          status.status !== "cancelled" &&
          status.totalCents === terms.totalCents &&
          JSON.stringify(status.lines) ===
            JSON.stringify(terms.lines.map(({ name, qty, options }) => ({ name, qty, options })));
        ctx.step(
          "place",
          verified ? "done" : "failed",
          verified ? `Confirmed: order ${orderId}` : "The confirmation didn't match.",
        );
        void memory?.log({
          path: ["food", "delivery", store.storeId, wantedLabel(items, menu)],
          surface: "food",
          outcome: verified ? "completed" : "abandoned",
          attributes: { store: store.storeName, items: request.selections?.items ?? "" },
        });
        if (!verified)
          return {
            outcome: `AGENCY couldn't confirm order ${orderId}. Please check with the store before ordering again.`,
            verified: false,
          };
        const track = await ctx.ask({
          prompt: `Order ${orderId} is confirmed. Arriving in ${status!.eta ?? "a while"}. Follow it?`,
          options: [
            { id: "track", label: "Show me where it is" },
            { id: "no", label: "No, thanks" },
          ],
        });
        if (track.optionId === "track") {
          const now = await ctx.exec("store.read", { what: "order", orderId }, () => store.order(orderId));
          ctx.note(
            `Order ${orderId}: ${now?.status.replace(/-/g, " ") ?? "unknown"}${now?.eta ? `, ${now.eta}` : ""}.`,
          );
        }
        return {
          outcome: `${store.kind === "sandbox" ? "Sandbox order" : "Order"} ${orderId} placed: ${formatMoney(terms.totalCents)} to ${store.storeName}.`,
          verified: true,
          evidence: `The store confirmed order ${orderId} with the approved items and total.`,
        };
      }
      return {
        outcome: "The store kept changing the total, so AGENCY stopped. Nothing was paid.",
        verified: true,
      };
    },
  };
}
