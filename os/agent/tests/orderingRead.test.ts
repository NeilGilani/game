import { describe, expect, it } from "vitest";
import {
  afterPlace,
  blockerOf,
  centsIn,
  CheckoutProblem,
  matchScore,
  neverClick,
  openChoices,
  placeButton,
  readCheckout,
  subscriptionChosen,
  upsellDecline,
} from "../src/packs/ordering/read";
import { classify } from "../src/policy/classify";
import type { PageNode, PageSnapshot } from "../src/types";

let seq = 0;
const node = (role: string, name: string, extra: Partial<PageNode> = {}): PageNode => ({
  ref: `r${++seq}`,
  role,
  name,
  ...extra,
});
const page = (
  nodes: PageNode[],
  url = "https://www.doordash.com/consumer/checkout/",
  title = "Checkout",
): PageSnapshot => ({
  tabId: "1",
  url,
  origin: new URL(url).origin,
  title,
  nodes,
  text: nodes.map((n) => n.name).join("\n"),
  simulated: false,
});

/** The sandbox DashDish checkout, as the bridge describes it (one line per element). */
const dashdishCheckout = () =>
  page([
    node("heading", "Checkout"),
    node("heading", "Deliver to"),
    node("radio", "Home: 12 Elm Street, Apt 3, Springfield", { checked: true }),
    node("radio", "Work: 400 Main Street, Floor 2, Springfield", { checked: false }),
    node("heading", "Tip your courier"),
    node("radio", "15%", { checked: true }),
    node("radio", "Visa ending in 4242 (sandbox card)", { checked: true }),
    node("link", "Add a new card", { href: "http://food.localhost:8787/payment/new" }),
    node("text", "Thai Basil · 25–35 min"),
    node("text", "1 × Pad thai (Protein: Chicken, Spice level: Mild) — $13.50"),
    node("text", "Subtotal"),
    node("text", "$13.50"),
    node("text", "Delivery fee"),
    node("text", "$2.99"),
    node("text", "Service fee"),
    node("text", "$1.50"),
    node("text", "Estimated tax"),
    node("text", "$1.20"),
    node("text", "Tip (15%)"),
    node("text", "$2.03"),
    node("text", "Total"),
    node("text", "$21.22"),
    node(
      "text",
      "Deliver to 12 Elm Street, Apt 3, Springfield. Pay with Visa ending in 4242 (sandbox card).",
    ),
    node("button", "Place order"),
  ]);

describe("reading ordering pages", () => {
  it("money and matching", () => {
    expect(centsIn("Total $1,024.50")).toBe(102450);
    expect(centsIn("Add to cart - $8")).toBe(800);
    expect(centsIn("no price")).toBeNull();
    expect(matchScore("pad thai", "Pad Thai")).toBe(1);
    expect(matchScore("paper towels", "Bounty Paper Towel, 6 rolls")).toBe(1);
    expect(matchScore("pad thai", "Pad See Ew")).toBe(0.5);
  });

  it("reads every line of a checkout: items, fees, tip, total, address, card", () => {
    const co = readCheckout(dashdishCheckout(), { item: "Pad thai" });
    expect(co).toEqual({
      items: [{ qty: 1, name: "Pad thai (Protein: Chicken, Spice level: Mild)", cents: 1350 }],
      subtotalCents: 1350,
      fees: [
        { label: "Delivery fee", cents: 299 },
        { label: "Service fee", cents: 150 },
        { label: "Estimated tax", cents: 120 },
      ],
      tipCents: 203,
      totalCents: 2122,
      deliverTo: "12 Elm Street, Apt 3, Springfield",
      payWith: "Visa ending in 4242 (sandbox card)",
    });
    expect(placeButton(dashdishCheckout())?.name).toBe("Place order");
  });

  it("won't guess: two totals, no card, no address, or not the item asked for", () => {
    const base = dashdishCheckout().nodes;
    const without = (re: RegExp) => page(base.filter((n) => !re.test(n.name)));
    expect(() =>
      readCheckout(page([...base, node("text", "Total"), node("text", "$99.00")]), { item: "Pad thai" }),
    ).toThrow(CheckoutProblem);
    expect(() => readCheckout(without(/Visa/), { item: "Pad thai" })).toThrow(/saved card/);
    expect(() => readCheckout(without(/Elm Street|Main Street|^Deliver to$/), { item: "Pad thai" })).toThrow(
      /delivery address/,
    );
    expect(() => readCheckout(dashdishCheckout(), { item: "Green curry" })).toThrow(/can't find Green curry/);
  });

  it("stops on sign-in, card, code and robot pages", () => {
    expect(
      blockerOf(page([node("textbox", "Password", { secure: true })], "https://www.amazon.com/ap/signin"))
        ?.kind,
    ).toBe("login");
    expect(blockerOf(page([node("heading", "Sign in")], "https://www.doordash.com/"))?.kind).toBe("login");
    expect(
      blockerOf(page([node("textbox", "Security code", { secure: true, autocomplete: "cc-csc" })]))?.kind,
    ).toBe("card");
    expect(
      blockerOf(page([node("text", "We sent a code to your phone"), node("textbox", "Enter code")]))?.kind,
    ).toBe("code");
    expect(blockerOf(page([node("text", "Enter the characters you see below")]))?.kind).toBe("captcha");
    expect(blockerOf(dashdishCheckout())).toBeNull();
  });

  it("sees subscriptions switched on, and the No thanks of an upsell", () => {
    expect(
      subscriptionChosen(page([node("switch", "Try DashPass free for 30 days", { checked: true })])),
    ).toBeTruthy();
    expect(
      subscriptionChosen(page([node("switch", "Try DashPass free for 30 days", { checked: false })])),
    ).toBeUndefined();
    expect(subscriptionChosen(page([node("radio", "Subscribe & Save", { checked: true })]))).toBeTruthy();
    // "Prime rib" is food, not a membership.
    expect(subscriptionChosen(page([node("checkbox", "Prime rib", { checked: true })]))).toBeUndefined();
    const upsell = page([
      node("heading", "Get Uber One free for 4 weeks"),
      node("button", "Join"),
      node("button", "Not now"),
    ]);
    expect(upsellDecline(upsell)?.name).toBe("Not now");
    expect(upsellDecline(page([node("button", "No thanks")]))).toBeUndefined();
  });

  it("never clicks account, address, payment or membership controls", () => {
    for (const label of [
      "Sign in",
      "Change address",
      "Add a card",
      "Manage payment methods",
      "Try DashPass free",
      "Join Prime",
      "Subscribe & Save",
      "Account settings",
      "Start free trial",
    ])
      expect(neverClick(label), label).not.toBeNull();
    for (const label of ["Add to cart", "Chicken", "No thanks", "15%", "Place order"])
      expect(neverClick(label), label).toBeNull();
  });

  it("finds required choices with nothing chosen yet, and leaves add-ons alone", () => {
    const item = page([
      node("group", "Protein (required)"),
      node("radio", "Chicken"),
      node("radio", "Tofu"),
      node("combobox", "Spice level", { value: "Mild" }),
      node("group", "Add-ons"),
      node("checkbox", "Extra peanuts (+$0.75)"),
      node("button", "Add to cart · $13.50"),
    ]);
    expect(openChoices(item)).toEqual([
      expect.objectContaining({
        name: "Protein (required)",
        choices: [expect.objectContaining({ label: "Chicken" }), expect.objectContaining({ label: "Tofu" })],
      }),
    ]);
  });

  it("a confirmation counts only when it's new after the click; a changed total is seen", () => {
    const before = "Checkout\nOrder number will appear here\nPlace order";
    const placed = page([
      node("heading", "Thanks! Your order is placed."),
      node("text", "Order number DD-1001."),
      node("text", "Arriving in about 25–35 min"),
    ]);
    expect(afterPlace(placed, before)).toEqual({
      kind: "placed",
      orderNumber: "DD-1001",
      eta: "Arriving in about 25–35 min",
      evidence: "Thanks! Your order is placed.",
    });
    // The same text that was already there before the click proves nothing.
    expect(afterPlace(placed, placed.text).kind).toBe("unknown");
    expect(afterPlace(page([node("heading", "Your total changed")]), before).kind).toBe("changed");
  });

  it("choosing in a list reads as the option chosen (a subscription option is a purchase)", () => {
    const sel = (option: string) =>
      classify({
        tier: "bridge",
        op: "bridge.select",
        target: { label: "Delivery frequency" },
        input: { option },
      });
    expect(sel("Medium").risk).toBe("reversible");
    expect(sel("Subscribe & Save").risk).toBe("consequential");
  });
});
