/**
 * A fake ordering site for the ordering pack's unit tests: DoorDash-like (food) or Amazon-like (shopping) pages as
 * the AGENCY Bridge would describe them (roles, names, link addresses, checked state). It is not DoorDash or
 * Amazon: real layouts differ and change. It records what the pack did (navigations, clicks, typing, orders), so
 * tests check outcomes from the site's side.
 */

import type { BridgeResult, BrowserBridge, PageNode, PageSnapshot } from "../../src/types";

export interface SiteFlags {
  /** Every page is a sign-in page. */
  loginWall?: boolean;
  /** Checkout shows a robot check. */
  captcha?: boolean;
  /** Checkout asks for the card's security code. */
  cvv?: boolean;
  /** Checkout has a membership trial switched on. */
  membershipOn?: boolean;
  /** The product page has Subscribe & Save chosen. */
  subscribeChosen?: boolean;
  /** After Add to cart, a protection-plan offer with "No thanks". */
  protectionUpsell?: boolean;
  /** The first Place order is rejected because the price went up. */
  priceUpOnPlace?: boolean;
  /** Place order shows nothing new. */
  silentPlace?: boolean;
  /** Item price in cents (default 1599 food, 1299 shopping). */
  priceCents?: number;
  /** A store link that points to another site. */
  offsiteStore?: boolean;
}

type Node = PageNode & { on?: () => void };

export class FakeOrderSite implements BrowserBridge {
  url: string;
  readonly origin: string;
  readonly navigations: string[] = [];
  readonly clicks: string[] = [];
  readonly typed: string[] = [];
  readonly orders: { totalCents: number; items: string[]; tipCents: number }[] = [];
  private cart: { name: string; options: string[]; cents: number }[] = [];
  private dialog: string | null = null;
  private protein: string | null = null;
  private subscribe: boolean;
  private upsellShown = false;
  private tipPercent = 15;
  private price: number;
  private nodes: Node[] = [];
  private seq = 0;
  private confirmed: string | null = null;
  private rejected = false;

  constructor(
    readonly kind: "food" | "shopping",
    readonly flags: SiteFlags = {},
    origin = kind === "food" ? "https://www.doordash.com" : "https://www.amazon.com",
    readonly simulated = false,
  ) {
    this.origin = origin;
    this.url = `${origin}/`;
    this.price = flags.priceCents ?? (kind === "food" ? 1599 : 1299);
    this.subscribe = flags.subscribeChosen === true;
  }

  // --- BrowserBridge ------------------------------------------------------------------------------

  async snapshot(): Promise<PageSnapshot> {
    this.nodes = this.render();
    const u = new URL(this.url);
    return {
      tabId: "1",
      url: this.url,
      origin: u.origin,
      title: this.title(),
      nodes: this.nodes.map(({ on: _on, ...n }) => n),
      text: this.nodes.map((n) => n.name).join("\n"),
      simulated: this.simulated,
    };
  }

  async click(ref: string, opts?: { approved?: boolean }): Promise<BridgeResult> {
    const n = this.nodes.find((x) => x.ref === ref);
    if (!n) return { ok: false, error: "no such element" };
    this.clicks.push(`${n.name}${opts?.approved ? " (approved)" : ""}`);
    if (/^place/i.test(n.name) && !opts?.approved) return { ok: false, error: "needs approval" };
    n.on?.();
    return { ok: true };
  }

  async type(ref: string, text: string): Promise<BridgeResult> {
    this.typed.push(`${ref}:${text}`);
    return { ok: true };
  }

  async navigate(url: string): Promise<BridgeResult> {
    this.navigations.push(url);
    this.url = url;
    this.dialog = null;
    this.confirmed = null;
    this.rejected = false;
    return { ok: true };
  }

  async select(): Promise<BridgeResult> {
    return { ok: true };
  }

  /** The price goes up, in the cart too (as a live checkout page would show at its next read). */
  raisePrice(cents: number): void {
    this.price += cents;
    this.cart = this.cart.map((l) => ({ ...l, cents: l.cents + cents }));
  }

  // --- Pages --------------------------------------------------------------------------------------

  /** Refs stay the same for the same element while the page stays the same, as the bridge's do. */
  private refs = new Map<string, string>();
  private n(role: string, name: string, extra: Partial<Node> = {}): Node {
    const key = `${this.url}|${role}|${name.replace(/\$[\d.]+/g, "")}`;
    let ref = this.refs.get(key);
    if (!ref) this.refs.set(key, (ref = `e${++this.seq}`));
    return { ref, role, name, ...extra };
  }

  private title(): string {
    return this.flags.loginWall ? "Sign In" : this.kind === "food" ? "DoorDash" : "Amazon.com";
  }

  private path(): string {
    return new URL(this.url).pathname;
  }

  private totals() {
    const subtotal = this.cart.reduce((a, l) => a + l.cents, 0);
    const fees =
      this.kind === "food"
        ? [
            { label: "Delivery Fee", cents: 299 },
            { label: "Service Fee", cents: Math.round(subtotal * 0.15) },
            { label: "Estimated Tax", cents: Math.round(subtotal * 0.0875) },
          ]
        : [
            { label: "Shipping & handling", cents: 0 },
            { label: "Estimated tax to be collected", cents: Math.round(subtotal * 0.0825) },
          ];
    const tip = this.kind === "food" ? Math.round((subtotal * this.tipPercent) / 100) : 0;
    return { subtotal, fees, tip, total: subtotal + fees.reduce((a, f) => a + f.cents, 0) + tip };
  }

  private render(): Node[] {
    if (this.flags.loginWall)
      return [
        this.n("heading", "Sign in"),
        this.n("textbox", "Email or mobile phone number"),
        this.n("textbox", "Password", { secure: true, autocomplete: "current-password" }),
        this.n("button", "Continue"),
      ];
    const p = this.path();
    if (this.kind === "food") return this.food(p);
    return this.shop(p);
  }

  private food(p: string): Node[] {
    if (p.startsWith("/search/store/")) {
      return [
        this.n("heading", "Results"),
        this.n("link", "Thai Basil Thai · 25 min · $0 delivery fee", {
          href: this.flags.offsiteStore
            ? "https://www.doordash.com.evil.example/store/x/"
            : `${this.origin}/store/thai-basil-1/`,
        }),
        this.n("heading", "Thai Basil"),
        this.n("link", "Bangkok Kitchen Thai · 35 min · $1.99 delivery fee", {
          href: `${this.origin}/store/bangkok-kitchen-2/`,
        }),
        this.n("heading", "Bangkok Kitchen"),
        this.n("link", "DashPass", { href: `${this.origin}/dashpass/` }),
      ];
    }
    if (p.startsWith("/store/")) {
      const out: Node[] = [
        this.n("heading", p.includes("thai-basil") ? "Thai Basil" : "Bangkok Kitchen"),
        this.n("button", `Pad Thai $${(this.price / 100).toFixed(2)} Rice noodles, egg, peanuts`, {
          on: () => (this.dialog = "Pad Thai"),
        }),
        this.n("button", "Pad See Ew $14.99 Wide noodles", { on: () => (this.dialog = "Pad See Ew") }),
        this.n("button", "Green Curry $16.49", { on: () => (this.dialog = "Green Curry") }),
        this.n("text", `Cart (${this.cart.length})`),
      ];
      if (this.dialog) {
        const name = this.dialog;
        out.push(
          this.n("dialog", name),
          this.n("radiogroup", "Choose a protein (Required)", { depth: 1 }),
          ...["Chicken", "Tofu", "Shrimp (+$2.00)"].map((label) =>
            this.n("radio", label, {
              depth: 2,
              checked: this.protein === label,
              on: () => (this.protein = label),
            }),
          ),
          this.n("button", `Add to cart - $${(this.price / 100).toFixed(2)}`, {
            depth: 1,
            on: () => {
              this.cart.push({ name, options: this.protein ? [this.protein] : [], cents: this.price });
              this.dialog = null;
            },
          }),
        );
      }
      if (this.cart.length && !this.dialog) out.push(this.n("text", "Item added to cart"));
      return out;
    }
    if (p.startsWith("/consumer/checkout")) return this.checkout();
    return [this.n("heading", "DoorDash"), this.n("link", "Sign In", { href: `${this.origin}/login` })];
  }

  private shop(p: string): Node[] {
    if (p === "/s") {
      return [
        this.n("link", "Bounty Paper Towels, 6 Double Rolls", {
          href: `${this.origin}/Bounty/dp/B000000001/ref=sr_1`,
        }),
        this.n("text", "4.8 out of 5 stars"),
        this.n("text", `$${(this.price / 100).toFixed(2)}`),
        this.n("link", "Bounty Paper Towels, 6 Double Rolls", {
          href: `${this.origin}/Bounty/dp/B000000001/ref=sr_2`,
        }),
        this.n("link", "Viva Paper Towels, 6 Big Rolls", {
          href: `${this.origin}/Viva/dp/B000000002/ref=sr_3`,
        }),
        this.n("text", "$11.49"),
        this.n("link", "Shower curtain", { href: `${this.origin}/x/dp/B000000003` }),
        this.n("text", "$9.99"),
      ];
    }
    if (p.includes("/dp/")) {
      if (this.cart.length && this.flags.protectionUpsell && !this.upsellShown)
        return [
          this.n("heading", "Add a protection plan?"),
          this.n("text", "2-Year Protection Plan $3.99"),
          this.n("button", "Add protection"),
          this.n("button", "No thanks", { on: () => (this.upsellShown = true) }),
        ];
      if (this.cart.length)
        return [this.n("heading", "Added to Cart"), this.n("text", "Cart subtotal (1 item)")];
      return [
        this.n("heading", "Bounty Paper Towels, 6 Double Rolls"),
        this.n("text", `$${(this.price / 100).toFixed(2)}`),
        this.n("radio", "Subscribe & Save: $11.69 (10% off)", {
          checked: this.subscribe,
          on: () => (this.subscribe = true),
        }),
        this.n("radio", "One-time purchase", {
          checked: !this.subscribe,
          on: () => (this.subscribe = false),
        }),
        this.n("button", this.subscribe ? "Subscribe Now" : "Add to Cart", {
          on: () => {
            if (this.subscribe) throw new Error("subscribed");
            this.cart.push({ name: "Bounty Paper Towels, 6 Double Rolls", options: [], cents: this.price });
          },
        }),
      ];
    }
    if (p.startsWith("/gp/buy/spc")) return this.checkout();
    return [this.n("heading", "Amazon")];
  }

  private checkout(): Node[] {
    if (this.confirmed) {
      return this.flags.silentPlace
        ? this.checkoutPage()
        : [
            this.n("heading", "Thank you, your order has been placed."),
            this.n("text", `Order # ${this.confirmed}`),
            this.n("text", this.kind === "food" ? "Estimated arrival 6:45 PM" : "Arriving tomorrow"),
          ];
    }
    if (this.rejected)
      return [this.n("heading", "Your total has changed"), this.n("text", "Please review your order again.")];
    return this.checkoutPage();
  }

  private checkoutPage(): Node[] {
    const t = this.totals();
    const out: Node[] = [this.n("heading", "Checkout")];
    if (this.flags.captcha)
      out.push(this.n("text", "Enter the characters you see below"), this.n("textbox", "Type characters"));
    out.push(
      this.n(
        "text",
        this.kind === "food"
          ? "Deliver to 12 Elm Street, Apt 3"
          : "Shipping to: Jane Doe, 12 Elm Street, Springfield",
      ),
    );
    out.push(this.n("text", "Visa ending in 4242"));
    if (this.flags.cvv)
      out.push(this.n("textbox", "Security code", { secure: true, autocomplete: "cc-csc" }));
    if (this.flags.membershipOn)
      out.push(this.n("switch", "Try DashPass free for 30 days", { checked: true }));
    for (const l of this.cart)
      out.push(
        this.n(
          "text",
          `1 x ${l.name}${l.options.length ? ` (${l.options.join(", ")})` : ""} - $${(l.cents / 100).toFixed(2)}`,
        ),
      );
    out.push(this.n("text", `Subtotal $${(t.subtotal / 100).toFixed(2)}`));
    for (const f of t.fees) out.push(this.n("text", `${f.label} $${(f.cents / 100).toFixed(2)}`));
    if (this.kind === "food") {
      out.push(this.n("heading", "Dasher Tip"));
      for (const pct of [10, 15, 20])
        out.push(
          this.n("radio", `${pct}%`, { checked: this.tipPercent === pct, on: () => (this.tipPercent = pct) }),
        );
      out.push(this.n("text", `Dasher Tip $${(t.tip / 100).toFixed(2)}`));
    }
    out.push(this.n("text", `Total $${(t.total / 100).toFixed(2)}`));
    out.push(
      this.n("button", this.kind === "food" ? "Place Order" : "Place your order", {
        on: () => {
          if (this.flags.priceUpOnPlace && !this.orders.length && !this.rejectedOnce) {
            this.rejectedOnce = true;
            this.cart = this.cart.map((l) => ({ ...l, cents: l.cents + 100 }));
            this.rejected = true;
            return;
          }
          const now = this.totals();
          this.orders.push({ totalCents: now.total, items: this.cart.map((l) => l.name), tipCents: now.tip });
          this.confirmed = this.kind === "food" ? "1234-5678" : "112-3456789-0001";
        },
      }),
    );
    return out;
  }

  private rejectedOnce = false;
}
