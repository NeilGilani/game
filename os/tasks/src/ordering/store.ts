/**
 * A store the ordering pack can shop at. The sandbox store (Instance 5's os/sandbox-web, or the
 * in-memory fake below until it lands) is the default; real sites go through the AGENCY
 * Bridge in the person's own signed-in Chrome. Payment is only ever a saved payment method on
 * the site: there is no way to pass a card number through this interface.
 */

import type { Cents } from "../policy/money";

export interface MenuItem {
  id: string;
  name: string;
  priceCents: Cents;
  description?: string;
  /** Choices such as spice level; at most one per group. */
  options?: { id: string; label: string; priceCents: Cents }[];
}

export interface CartLine {
  itemId: string;
  name: string;
  qty: number;
  options: string[];
  unitCents: Cents;
  lineCents: Cents;
}

export interface Cart {
  lines: CartLine[];
  subtotalCents: Cents;
  fees: { label: string; cents: Cents }[];
  tipCents: Cents;
  totalCents: Cents;
  deliverTo: string;
}

export interface SavedPaymentMethod {
  id: string;
  /** What the site shows, e.g. "Visa ending 4242". Never the number. */
  label: string;
}

export interface OrderStatus {
  orderId: string;
  status: "confirmed" | "preparing" | "on-the-way" | "delivered" | "cancelled";
  totalCents: Cents;
  lines: { name: string; qty: number; options: string[] }[];
  eta?: string;
}

export interface StoreClient {
  readonly kind: "sandbox" | "bridge";
  readonly storeId: string;
  readonly storeName: string;
  menu(): Promise<MenuItem[]>;
  clearCart(): Promise<void>;
  addToCart(itemId: string, qty: number, optionIds: string[]): Promise<void>;
  setTip(cents: Cents): Promise<void>;
  cart(): Promise<Cart>;
  savedPaymentMethods(): Promise<SavedPaymentMethod[]>;
  /** The store refuses if its total differs from expectedTotalCents. */
  placeOrder(input: { paymentMethodId: string; expectedTotalCents: Cents }): Promise<{ orderId: string }>;
  order(orderId: string): Promise<OrderStatus | null>;
}

export interface WantedItem {
  itemId: string;
  qty: number;
  optionIds: string[];
}

/** Items travel in TaskRequest selections as "pad-thai*1(mild);spring-rolls*2". */
export function encodeItems(items: readonly WantedItem[]): string {
  return items
    .map((i) => `${i.itemId}*${i.qty}${i.optionIds.length ? `(${i.optionIds.join("+")})` : ""}`)
    .join(";");
}

export function decodeItems(text: string): WantedItem[] {
  return text
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^([\w-]+)(?:\*(\d+))?(?:\(([\w+-]*)\))?$/.exec(part);
      if (!m) throw new Error(`Can't read item "${part}"`);
      const qty = Number(m[2] ?? "1");
      if (!Number.isInteger(qty) || qty < 1 || qty > 20)
        throw new Error(`Quantity out of range in "${part}"`);
      return { itemId: m[1]!, qty, optionIds: m[3] ? m[3].split("+").filter(Boolean) : [] };
    });
}

export interface FakeStoreOptions {
  /** Raise the delivery fee after the first cart read: tests that a changed total needs a new approval. */
  priceChangeAfterReview?: boolean;
  noSavedPayment?: boolean;
  deliverTo?: string;
}

export const THAI_BASIL_MENU: MenuItem[] = [
  {
    id: "pad-thai",
    name: "Pad thai",
    priceCents: 1450,
    options: [
      { id: "mild", label: "Mild", priceCents: 0 },
      { id: "medium", label: "Medium", priceCents: 0 },
      { id: "hot", label: "Hot", priceCents: 0 },
      { id: "tofu", label: "Tofu", priceCents: 0 },
      { id: "shrimp", label: "Shrimp", priceCents: 300 },
    ],
  },
  {
    id: "green-curry",
    name: "Green curry",
    priceCents: 1550,
    options: [{ id: "mild", label: "Mild", priceCents: 0 }],
  },
  { id: "spring-rolls", name: "Spring rolls (4)", priceCents: 650 },
  { id: "tom-yum", name: "Tom yum soup", priceCents: 900 },
  { id: "mango-rice", name: "Mango sticky rice", priceCents: 750 },
  { id: "thai-tea", name: "Thai iced tea", priceCents: 450 },
];

/** An in-memory sandbox store (Thai Basil). Simulated: no real restaurant, no real payment. */
export class FakeSandboxStore implements StoreClient {
  readonly kind = "sandbox" as const;
  readonly storeId = "thai-basil";
  readonly storeName = "Thai Basil (sandbox)";
  private lines: CartLine[] = [];
  private tip = 0;
  private reads = 0;
  readonly orders: (OrderStatus & { paymentMethodId: string })[] = [];

  constructor(private readonly options: FakeStoreOptions = {}) {}

  async menu(): Promise<MenuItem[]> {
    return THAI_BASIL_MENU;
  }
  async clearCart(): Promise<void> {
    this.lines = [];
    this.tip = 0;
  }
  async addToCart(itemId: string, qty: number, optionIds: string[]): Promise<void> {
    const item = THAI_BASIL_MENU.find((m) => m.id === itemId);
    if (!item) throw new Error(`The store has no item "${itemId}"`);
    const opts = optionIds.map((id) => {
      const o = item.options?.find((x) => x.id === id);
      if (!o) throw new Error(`"${item.name}" has no option "${id}"`);
      return o;
    });
    const unit = item.priceCents + opts.reduce((a, o) => a + o.priceCents, 0);
    this.lines.push({
      itemId,
      name: item.name,
      qty,
      options: opts.map((o) => o.label),
      unitCents: unit,
      lineCents: unit * qty,
    });
  }
  async setTip(cents: number): Promise<void> {
    this.tip = cents;
  }
  async cart(): Promise<Cart> {
    this.reads += 1;
    const subtotal = this.lines.reduce((a, l) => a + l.lineCents, 0);
    const delivery = this.options.priceChangeAfterReview && this.reads > 2 ? 499 : 299;
    const fees = [
      { label: "Delivery fee", cents: delivery },
      { label: "Service fee", cents: Math.round(subtotal * 0.05) },
      { label: "Tax", cents: Math.round(subtotal * 0.08) },
    ];
    return {
      lines: this.lines.map((l) => ({ ...l, options: [...l.options] })),
      subtotalCents: subtotal,
      fees,
      tipCents: this.tip,
      totalCents: subtotal + fees.reduce((a, f) => a + f.cents, 0) + this.tip,
      deliverTo: this.options.deliverTo ?? "Home: 12 Harbor Lane",
    };
  }
  async savedPaymentMethods(): Promise<SavedPaymentMethod[]> {
    return this.options.noSavedPayment ? [] : [{ id: "pm_sandbox_1", label: "Sandbox Visa ending 4242" }];
  }
  async placeOrder(input: {
    paymentMethodId: string;
    expectedTotalCents: number;
  }): Promise<{ orderId: string }> {
    const cart = await this.cart();
    if (cart.totalCents !== input.expectedTotalCents)
      throw new Error("The total changed. The order was not placed.");
    if (!(await this.savedPaymentMethods()).some((p) => p.id === input.paymentMethodId))
      throw new Error("Unknown payment method");
    const orderId = `TB-${1000 + this.orders.length + 1}`;
    this.orders.push({
      orderId,
      status: "confirmed",
      totalCents: cart.totalCents,
      lines: cart.lines.map((l) => ({ name: l.name, qty: l.qty, options: l.options })),
      eta: "35 to 45 minutes",
      paymentMethodId: input.paymentMethodId,
    });
    this.lines = [];
    return { orderId };
  }
  async order(orderId: string): Promise<OrderStatus | null> {
    const o = this.orders.find((x) => x.orderId === orderId);
    if (!o) return null;
    return {
      orderId: o.orderId,
      status: o.status,
      totalCents: o.totalCents,
      lines: o.lines,
      ...(o.eta ? { eta: o.eta } : {}),
    };
  }
}
