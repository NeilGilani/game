/**
 * The ordering pack: food on DoorDash or Uber Eats, shopping on Amazon or Instacart, in the person's own signed-in
 * Chrome through the AGENCY Bridge (or the sandbox shops, simulated). No AI model: the steps are code, and every
 * click goes through the same guarded tools as everything else.
 *
 * It opens the site's search for what the person chose, picks a clear match or asks (2 to 4 real options with
 * prices), adds it to the cart, opens checkout, reads the exact total, and stops there. "Place order" is pressed
 * only with the person's approval of exactly that page: site, store, items and quantities, fees, tip, total,
 * delivery address and payment method as the page shows them. Anything that changes means a new approval. Then
 * it reads the confirmation back, and says so plainly when it can't.
 *
 * What it never does, in code: act outside the site's exact hosts; type anything (no card numbers, passwords or
 * codes; a sign-in, card, code or robot check stops it); change an account, address or payment method; sign up
 * for a membership, trial or repeat delivery; go over the spending cap; place more than one order per approval.
 */

import type { TaskRequest } from "@agency/contracts";
import type { GuardOutcome } from "../../guard";
import { realOrderingOf, type SafetySettings } from "../../policy/settings";
import { ToolError } from "../../tools/guarded";
import type {
  ActionClaim,
  PackContext,
  PackStep,
  PageNode,
  PageSnapshot,
  StepOutcome,
  TaskPack,
} from "../../types";
import {
  ADDED,
  addButton,
  afterPlace,
  asksForNewCard,
  blockerOf,
  CheckoutProblem,
  matchScore,
  menuItems,
  money,
  neverClick,
  openChoices,
  placeButton,
  readCheckout,
  searchProducts,
  searchStores,
  subscriptionChosen,
  tipChoices,
  upsellDecline,
  type Checkout,
  type Choice,
} from "./read";
import { onSite, siteFor, siteOrigins, type OrderSite } from "./sites";

export interface OrderingPackDeps {
  /** The caregiver's settings, re-read each time (real ordering on or off, the cap). */
  settings: () => SafetySettings;
  /** The sandbox web world's port (os/sandbox-web), for the practice shops. */
  sandboxPort?: number;
  /** Wait between page reads while a page loads or updates. */
  settleMs?: number;
  /** Page reads before giving up on a change (about settleMs × reads). */
  reads?: number;
}

/** What a real-ordering TaskRequest carries in its selections (the shell builds it; see frontend/src/state). */
export interface OrderingSelections {
  kind: "food" | "shopping";
  /** A site id from sites.ts. */
  orderSite: string;
  /** What to search for: the dish or the product. */
  orderQuery: string;
  /** Food: the restaurant the flow suggested (fictional in the demo flows; preferred only if the site has it). */
  restaurant?: string;
  when?: string;
}

const REFUSED = "refused: ";
const NOT_DONE = "not done: ";

/** Shared by the steps of one order. */
interface OrderState {
  store?: Choice;
  item?: Choice;
  options: string[];
  checkout?: Checkout;
  placed?: { orderNumber: string | null; eta: string | null; evidence: string };
  unknown?: boolean;
}

export function orderingSelections(r: TaskRequest): OrderingSelections | null {
  const s = r.selections ?? {};
  if ((s.kind !== "food" && s.kind !== "shopping") || !s.orderSite || !s.orderQuery?.trim()) return null;
  return {
    kind: s.kind,
    orderSite: s.orderSite,
    orderQuery: s.orderQuery.trim().slice(0, 80),
    ...(s.restaurant ? { restaurant: s.restaurant } : {}),
    ...(s.when ? { when: s.when } : {}),
  };
}

export function createOrderingPack(deps: OrderingPackDeps): TaskPack {
  const port = deps.sandboxPort ?? 8787;
  const settleMs = deps.settleMs ?? 600;
  const reads = deps.reads ?? 15;

  const target = (r: TaskRequest): { site: OrderSite; sel: OrderingSelections } | null => {
    const sel = orderingSelections(r);
    const site = sel ? siteFor(sel.orderSite, port) : null;
    return sel && site && site.kind === sel.kind ? { site, sel } : null;
  };

  return {
    id: "ordering",
    title: "Order food or shopping",
    matches: (r) => target(r) !== null,
    // This pack's actions run on its site only, under the real-ordering cap, and for real only when it's on.
    safety: (base, r) => {
      const t = target(r);
      const ro = realOrderingOf(base);
      return {
        ...base,
        siteAllowlist: t ? siteOrigins(t.site, port) : [],
        simulatedOnly: !t || t.site.simulated || !ro.enabled,
        maxPurchase: base.maxPurchase === null ? null : ro.maxOrder,
      };
    },
    steps: (r) => {
      const { site, sel } = target(r)!;
      const st: OrderState = { options: [] };
      const food = site.kind === "food";
      const what = sel.orderQuery;
      const cap = () => realOrderingOf(deps.settings()).maxOrder;

      // --- helpers ------------------------------------------------------------------------------------
      const pause = async (ctx: PackContext, ms = settleMs) => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          ctx.signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
        });
        await ctx.checkpoint?.();
      };
      /** Read the page until `until` holds (or the reads run out); a page that is loading is read again. */
      const read = async (ctx: PackContext, until: (s: PageSnapshot) => boolean = () => true, n = reads) => {
        let last: PageSnapshot | null = null;
        for (let i = 0; i < n; i++) {
          if (i > 0) await pause(ctx);
          await ctx.checkpoint?.();
          try {
            last = await ctx.tools.readPage();
          } catch (e) {
            if (i === n - 1 && !last) throw e;
            continue;
          }
          if (until(last) || blockerOf(last) || !onSite(site, last.url, port)) return last;
        }
        if (!last) throw new ToolError("The page didn't answer.");
        return last;
      };
      /** Why this page can't be worked on (another site, a sign-in, a card form, a robot check), or null. */
      const problem = (snap: PageSnapshot): string | null => {
        if (!onSite(site, snap.url, port))
          return `The page moved away from ${site.name} (to ${originOf(snap.url)}), so I stopped. Nothing was ordered.`;
        const b = blockerOf(snap);
        if (b)
          return `${b.message} Please ask a helper to finish that on ${site.name} in Chrome, then try again. Nothing was ordered.`;
        return null;
      };
      const failed = (o: GuardOutcome<unknown>): string | null => {
        if (o.status === "done") return null;
        if (o.status === "declined") return "declined: You said no, so nothing was ordered.";
        if (o.status === "change") return `${NOT_DONE}you asked for a change (${o.change}).`;
        return `${NOT_DONE}${o.reason}`;
      };
      const open = async (ctx: PackContext, url: string): Promise<string | null> => {
        if (!onSite(site, url, port)) return `${REFUSED}That link leaves ${site.name}, so I didn't open it.`;
        return failed(await ctx.tools.navigate(url));
      };
      const click = async (ctx: PackContext, node: PageNode): Promise<string | null> => {
        const never = neverClick(node.name);
        if (never) return REFUSED + never;
        return failed(await ctx.tools.click(node.ref));
      };
      const ask = async (ctx: PackContext, prompt: string, choices: Choice[], none: string) => {
        const a = await ctx.ask({
          prompt,
          options: [
            ...choices.slice(0, 4).map((c, i) => ({
              id: `c${i}`,
              label: c.name.slice(0, 60),
              description: [c.priceCents !== null ? money(c.priceCents) : "", c.detail ?? ""]
                .filter(Boolean)
                .join(" · ")
                .slice(0, 140),
            })),
            { id: "none", label: none },
          ],
        });
        const i = a.optionId?.startsWith("c") ? Number(a.optionId.slice(1)) : NaN;
        return Number.isInteger(i) ? (choices[i] ?? null) : null;
      };
      /** Every step body: a Stop always propagates; a tool error becomes a plain "not done" (never retried). */
      const guarded =
        (fn: (ctx: PackContext) => Promise<StepOutcome>, retry = false) =>
        async (ctx: PackContext): Promise<StepOutcome> => {
          try {
            return await fn(ctx);
          } catch (e) {
            if (e instanceof ToolError && !retry) return { verified: false, summary: NOT_DONE + e.message };
            if (e instanceof CheckoutProblem) return { verified: false, summary: REFUSED + e.message };
            throw e;
          }
        };

      // --- the order, as the person sees it on the checkout page ------------------------------------
      const claimFor = (snap: PageSnapshot): ActionClaim => {
        const p = problem(snap);
        if (p) throw new ToolError(p);
        if (asksForNewCard(snap))
          throw new ToolError(`${site.name} is asking for card details. I never type those; a helper can.`);
        const sub = subscriptionChosen(snap);
        if (sub)
          throw new ToolError(
            `The checkout includes "${sub.name.slice(0, 60)}". I never sign anyone up for memberships or repeat deliveries. A helper can switch it off on ${site.name}. Nothing was ordered.`,
          );
        let co: Checkout;
        try {
          co = readCheckout(snap, { item: st.item!.name });
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e));
        }
        const limit = cap();
        if (co.totalCents > Math.round(limit * 100))
          throw new ToolError(
            `The total is ${money(co.totalCents)}, over your limit of ${money(limit * 100)} for one order. Nothing was ordered. A helper can change the limit in Settings.`,
          );
        st.checkout = co;
        const storeName = st.store?.name ?? storeOnPage(snap) ?? site.name;
        const details: Record<string, string> = {
          Site: site.simulated ? `${site.name}, simulated` : site.name,
          [food ? "Restaurant" : "Store"]: storeName,
        };
        co.items.forEach((l, i) => {
          details[`Item ${i + 1}`] = `${l.qty} × ${l.name}${l.cents !== null ? `: ${money(l.cents)}` : ""}`;
        });
        if (co.items.length > 1 || co.items[0]!.qty > 1)
          details["Check"] = "There is more in the cart than one item. Make sure you want all of it.";
        if (co.subtotalCents !== null) details.Subtotal = money(co.subtotalCents);
        for (const f of co.fees) details[f.label] = money(f.cents);
        details.Tip = co.tipCents !== null ? money(co.tipCents) : "No tip shown";
        details.Total = money(co.totalCents);
        details[food ? "Deliver to" : "Ship to"] = co.deliverTo;
        details["Pay with"] = `${co.payWith} (saved on ${site.name})`;
        details["Your limit"] = `${money(limit * 100)} per order`;
        if (food && sel.when) details.When = "As soon as possible";
        const items = co.items.map((l) => `${l.qty} × ${l.name}`).join(", ");
        return {
          risk: "consequential",
          kind: "purchase",
          summary: `Pay ${money(co.totalCents)} on ${site.name} to ${storeName} for ${items}, ${food ? "delivered" : "shipped"} to ${co.deliverTo}, paid with ${co.payWith}.`,
          details,
          amount: co.totalCents / 100,
        };
      };

      // --- the steps --------------------------------------------------------------------------------
      const steps: PackStep[] = [
        {
          id: "open",
          title: `Open ${site.name} and look for ${what}`,
          risk: "reversible",
          run: guarded(async (ctx) => {
            if (!site.simulated) {
              if (!realOrderingOf(deps.settings()).enabled)
                return {
                  verified: false,
                  summary: `${REFUSED}Ordering for real is off. A helper can turn it on in Settings, For a helper, Ordering for real.`,
                };
              if (ctx.request.dryRun !== false)
                return {
                  verified: false,
                  summary: `${REFUSED}This was started as practice, so I won't order for real.`,
                };
            }
            if (food && sel.when && !/^as soon as possible$/i.test(sel.when)) {
              const a = await ctx.ask({
                prompt: `I can only order for as soon as possible on ${site.name}, not "${sel.when.toLowerCase()}". Order for as soon as possible?`,
                options: [
                  { id: "asap", label: "Yes, as soon as possible" },
                  { id: "no", label: "No, not now" },
                ],
              });
              if (a.optionId !== "asap")
                return { verified: false, summary: "declined: Nothing was ordered." };
            }
            const f = await open(ctx, site.searchUrl(what));
            if (f) return { verified: false, summary: f };
            const snap = await read(ctx, (s) => s.nodes.some((n) => n.role === "link"));
            const p = problem(snap);
            if (p) return { verified: false, summary: REFUSED + p };
            return { verified: true, summary: `${site.name} is open with results for "${what}".` };
          }, true),
        },
        {
          id: "choose",
          title: food ? `Choose the restaurant and the dish` : `Choose the product`,
          risk: "read",
          run: guarded(async (ctx) => {
            let snap = await read(ctx);
            let p = problem(snap);
            if (p) return { verified: false, summary: REFUSED + p };
            if (food) {
              const stores = searchStores(snap, site, `${what} ${sel.restaurant ?? ""}`);
              if (!stores.length)
                return {
                  verified: false,
                  summary: `${NOT_DONE}I couldn't find a restaurant with ${what} on ${site.name}.`,
                };
              const named = sel.restaurant
                ? stores.find((s) => s.name.toLowerCase() === sel.restaurant!.toLowerCase())
                : undefined;
              const store =
                named ??
                (stores.length === 1
                  ? stores[0]!
                  : await ask(ctx, `Which restaurant on ${site.name}?`, stores, "None of these"));
              if (!store)
                return {
                  verified: false,
                  summary: "declined: No restaurant chosen, so nothing was ordered.",
                };
              st.store = store;
              const f = await open(ctx, store.href!);
              if (f) return { verified: false, summary: f };
              snap = await read(ctx, (s) => menuItems(s, site, what).length > 0);
              p = problem(snap);
              if (p) return { verified: false, summary: REFUSED + p };
              const dishes = menuItems(snap, site, what);
              if (!dishes.length)
                return {
                  verified: false,
                  summary: `${NOT_DONE}I couldn't find ${what} on ${store.name}'s menu.`,
                };
              // One dish with every word asked for is a clear match; several (or only partial ones), the person picks.
              const full = dishes.filter((d) => matchScore(what, d.name) === 1);
              const dish =
                full.length === 1
                  ? full[0]!
                  : dishes.length === 1
                    ? dishes[0]!
                    : await ask(ctx, `Which one from ${store.name}?`, dishes, "None of these");
              if (!dish)
                return { verified: false, summary: "declined: Nothing chosen, so nothing was ordered." };
              st.item = dish;
              return {
                verified: true,
                summary: `Chose ${dish.name} (${money(dish.priceCents ?? 0)}) from ${store.name}.`,
              };
            }
            snap = await read(ctx, (s) => searchProducts(s, site, what).length > 0);
            p = problem(snap);
            if (p) return { verified: false, summary: REFUSED + p };
            const products = searchProducts(snap, site, what);
            if (!products.length)
              return {
                verified: false,
                summary: `${NOT_DONE}I couldn't find ${what} with a price on ${site.name}.`,
              };
            const product =
              products.length === 1
                ? products[0]!
                : await ask(ctx, `Which ${what}?`, products, "None of these");
            if (!product)
              return { verified: false, summary: "declined: Nothing chosen, so nothing was ordered." };
            st.item = product;
            return { verified: true, summary: `Chose ${product.name} (${money(product.priceCents ?? 0)}).` };
          }),
        },
        {
          id: "cart",
          title: "Put it in the cart",
          risk: "reversible",
          run: guarded(async (ctx) => {
            const item = st.item!;
            // A product or dish page of its own is opened; a dish that opens in a panel is clicked.
            if (item.href) {
              const f = await open(ctx, item.href);
              if (f) return { verified: false, summary: f };
            } else {
              const snap0 = await read(ctx);
              const node = snap0.nodes.find((n) => n.ref === item.ref);
              if (!node)
                return { verified: false, summary: `${NOT_DONE}${item.name} isn't on the page anymore.` };
              const f = await click(ctx, node);
              if (f) return { verified: false, summary: f };
            }
            let pressed = false;
            for (let round = 0; round < 8 && !pressed; round++) {
              const snap = await read(ctx, (s) => !!addButton(s) || openChoices(s).length > 0);
              const p = problem(snap);
              if (p) return { verified: false, summary: REFUSED + p };
              // Switching a chosen subscription off is itself a click the guard and the bridge read as a purchase,
              // so the person would be asked to "pay" for it. Stop instead, and say why.
              const sub = subscriptionChosen(snap);
              if (sub)
                return {
                  verified: false,
                  summary: `${REFUSED}"${sub.name.slice(0, 60)}" is chosen on this page. I never sign anyone up for repeat deliveries or memberships. A helper can choose a one-time purchase on ${site.name}, then try again. Nothing was ordered.`,
                };
              const group = openChoices(snap)[0];
              if (group) {
                const choice =
                  group.choices.length === 1
                    ? group.choices[0]!
                    : await (async () => {
                        const shown = group.choices.slice(0, 6);
                        const a = await ctx.ask({
                          prompt: `${group.name.replace(/\s*\(required\)\s*/i, "")}?`.slice(0, 120),
                          options: shown.map((c, i) => ({ id: `g${i}`, label: c.label.slice(0, 60) })),
                        });
                        return shown[Number(a.optionId?.slice(1))] ?? null;
                      })();
                if (!choice)
                  return { verified: false, summary: "declined: Nothing chosen, so nothing was ordered." };
                const node = snap.nodes.find((n) => n.ref === choice.ref)!;
                const f = await click(ctx, node);
                if (f) return { verified: false, summary: f };
                st.options.push(`${group.name.replace(/\s*\(required\)\s*/i, "")}: ${choice.label}`);
                continue;
              }
              const add = addButton(snap);
              if (!add)
                return { verified: false, summary: `${NOT_DONE}I can't find the "Add to cart" button.` };
              const f = await click(ctx, add);
              if (f) return { verified: false, summary: f };
              pressed = true;
            }
            if (!pressed)
              return { verified: false, summary: `${NOT_DONE}The item kept asking for more choices.` };
            // Say no to an upsell in the way (a membership, a protection plan), then look for the item in the cart.
            for (let i = 0; i < reads; i++) {
              const snap = await read(ctx, () => true, 1);
              const p = problem(snap);
              if (p) return { verified: false, summary: REFUSED + p };
              if (
                /\b(start a new (cart|order)|create new order|new order\?|items from another (restaurant|store))\b/i.test(
                  snap.text,
                )
              )
                return {
                  verified: false,
                  summary: `${REFUSED}Your cart on ${site.name} already has things from another place. A helper can empty it, then try again.`,
                };
              const no = upsellDecline(snap);
              if (no) {
                const f = await click(ctx, no);
                if (f) return { verified: false, summary: f };
                continue;
              }
              if (ADDED.test(snap.text))
                return {
                  verified: true,
                  summary: `${item.name}${st.options.length ? ` (${st.options.join(", ")})` : ""} is in the cart.`,
                  evidence: `${site.name} shows: added to the cart.`,
                };
              await pause(ctx);
            }
            return {
              verified: false,
              summary: `${NOT_DONE}I pressed "Add to cart", but I can't see it in the cart.`,
            };
          }),
        },
        {
          id: "review",
          title: "Open checkout and read the total",
          risk: "read",
          run: guarded(async (ctx) => {
            const f = await open(ctx, site.checkoutUrl);
            if (f) return { verified: false, summary: f };
            for (let declined = 0; declined < 3; declined++) {
              const snap = await read(ctx, (s) => !!placeButton(s) || !!upsellDecline(s));
              const p = problem(snap);
              if (p) return { verified: false, summary: REFUSED + p };
              const no = !placeButton(snap) ? upsellDecline(snap) : undefined;
              if (no) {
                const nf = await click(ctx, no);
                if (nf) return { verified: false, summary: nf };
                continue;
              }
              if (!placeButton(snap))
                return {
                  verified: false,
                  summary: `${NOT_DONE}I can't find the "Place order" button on the checkout page.`,
                };
              const claim = claimFor(snap);
              return {
                verified: true,
                summary: `Checkout shows a total of ${money(st.checkout!.totalCents)}.`,
                evidence: claim.summary,
              };
            }
            return { verified: false, summary: `${NOT_DONE}The checkout page kept showing offers.` };
          }),
        },
        {
          id: "place",
          title: "You approve the exact order, then I place it",
          risk: "consequential",
          run: guarded(async (ctx) => {
            // At most three approvals: one, and a new one each time the site changed the total.
            for (let round = 0; round < 3; round++) {
              const snap = await read(ctx, (s) => !!placeButton(s));
              const btn = placeButton(snap);
              if (!btn) return { verified: false, summary: `${NOT_DONE}The "Place order" button is gone.` };
              let outcome: GuardOutcome<string>;
              try {
                outcome = await ctx.tools.click(btn.ref, (s) => claimFor(s));
              } catch (e) {
                if (e instanceof ToolError) return { verified: false, summary: REFUSED + e.message };
                throw e;
              }
              if (outcome.status === "change") {
                const tips = tipChoices(await ctx.tools.readPage());
                if (!tips.length)
                  return {
                    verified: false,
                    summary: `${NOT_DONE}I can only change the tip here. Nothing was ordered.`,
                  };
                const a = await ctx.ask({
                  prompt: "What tip?",
                  options: [
                    ...tips.slice(0, 5).map((t, i) => ({ id: `t${i}`, label: t.label })),
                    { id: "keep", label: "Keep it as it is" },
                  ],
                });
                const tip = tips[Number(a.optionId?.slice(1))];
                if (tip && !tip.checked) {
                  const node = (await ctx.tools.readPage()).nodes.find((n) => n.ref === tip.ref);
                  const f = node ? await click(ctx, node) : `${NOT_DONE}The tip choices changed.`;
                  if (f) return { verified: false, summary: f };
                }
                continue;
              }
              const f = failed(outcome);
              if (f) return { verified: false, summary: f };
              // Pressed, with the person's approval. From here on this step never presses again unless the site
              // clearly said the order did not go through because the total changed.
              const before = ctx.tools.lastConsequentialBefore;
              for (let i = 0; i < reads; i++) {
                let now: PageSnapshot;
                try {
                  now = await read(ctx, () => true, 1);
                } catch {
                  await pause(ctx);
                  continue;
                }
                const r = afterPlace(now, before);
                if (r.kind === "placed") {
                  st.placed = r;
                  return { verified: true, summary: "Placed the order you approved.", evidence: r.evidence };
                }
                if (r.kind === "changed") {
                  ctx.tools.setWhy("The site changed the total: going back to checkout to ask you again");
                  const back = await open(ctx, site.checkoutUrl);
                  if (back) return { verified: false, summary: back };
                  break;
                }
                if (i === reads - 1) {
                  st.unknown = true;
                  return { verified: true, summary: "Pressed Place order with your approval." };
                }
                await pause(ctx);
              }
              if (st.placed) break;
            }
            return {
              verified: false,
              summary: `${NOT_DONE}${site.name} kept changing the total, so I stopped. Nothing more was ordered.`,
            };
          }),
        },
        {
          id: "confirm",
          title: "Read back the confirmation",
          risk: "read",
          run: guarded(async (ctx) => {
            const co = st.checkout!;
            const where = `${site.name}${st.store ? `, ${st.store.name}` : ""}`;
            if (st.unknown) {
              // One more look before saying it can't be checked.
              const snap = await read(
                ctx,
                (s) => afterPlace(s, ctx.tools.lastConsequentialBefore).kind === "placed",
                4,
              );
              const r = afterPlace(snap, ctx.tools.lastConsequentialBefore);
              if (r.kind === "placed") st.placed = r;
            }
            if (!st.placed)
              return {
                verified: false,
                unconfirmed: true,
                summary: "I couldn't read a confirmation.",
                outcome: `I pressed Place order on ${site.name} for ${money(co.totalCents)} with your approval, but I couldn't read a confirmation. Please check your orders on ${site.name} before ordering again.`,
              };
            const p = st.placed;
            const items = co.items.map((l) => `${l.qty} × ${l.name}`).join(", ");
            return {
              verified: true,
              summary: p.orderNumber ? `Order ${p.orderNumber} confirmed.` : "Order confirmed.",
              evidence: p.orderNumber
                ? `${site.name} shows order number ${p.orderNumber}.`
                : `${site.name} shows: ${p.evidence}`,
              outcome:
                `${site.simulated ? "Sandbox order" : "Ordered"} on ${where}: ${items}, ${money(co.totalCents)}.` +
                (p.orderNumber
                  ? ` Order number ${p.orderNumber}.`
                  : " The page didn't show an order number.") +
                (p.eta ? ` ${capitalize(p.eta)}.` : " It didn't say when it will arrive."),
            };
          }),
        },
      ];
      return steps;
    },
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "another page";
  }
}

function storeOnPage(snap: PageSnapshot): string | null {
  return /\bsold by:?\s+([^\n]{2,60})/i.exec(snap.text)?.[1]?.trim() ?? null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
