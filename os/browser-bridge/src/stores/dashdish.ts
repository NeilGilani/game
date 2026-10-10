/**
 * DashDishBridgeStore: Instance 8's StoreClient (os/tasks/src/ordering/store.ts) for the sandbox food
 * store, driven through the AGENCY Bridge exactly as on a real site: it reads the page tree, clicks and
 * types by reference, and parses what the page shows. It never sees the store's internals.
 *
 * Placing the order: the ordering pack has already shown the person the exact items and total and
 * received their approval (bound to those terms). Right before clicking "Place order", this adapter checks
 * that the page shows exactly the approved total and items, and only then passes the bridge's own
 * fingerprint for that exact page state. If anything differs, it refuses and nothing is paid.
 */

import type { BridgeApi } from "../app/server.ts";
import type { TreeNode } from "../protocol.ts";
import { isSandboxOrigin } from "../app/tools.ts";

// Structural copies of Instance 8's store types, so this package doesn't depend on os/tasks.
export type Cents = number;
export interface StoreMenuItem {
  id: string;
  name: string;
  priceCents: Cents;
  description?: string;
  options?: { id: string; label: string; priceCents: Cents }[];
}
export interface StoreCartLine {
  itemId: string;
  name: string;
  qty: number;
  options: string[];
  unitCents: Cents;
  lineCents: Cents;
}
export interface StoreCart {
  lines: StoreCartLine[];
  subtotalCents: Cents;
  fees: { label: string; cents: Cents }[];
  tipCents: Cents;
  totalCents: Cents;
  deliverTo: string;
}
export interface StoreOrderStatus {
  orderId: string;
  status: "confirmed" | "preparing" | "on-the-way" | "delivered" | "cancelled";
  totalCents: Cents;
  lines: { name: string; qty: number; options: string[] }[];
  eta?: string;
}
export interface StoreClientLike {
  readonly kind: "sandbox" | "bridge";
  readonly storeId: string;
  readonly storeName: string;
  menu(): Promise<StoreMenuItem[]>;
  clearCart(): Promise<void>;
  addToCart(itemId: string, qty: number, optionIds: string[]): Promise<void>;
  setTip(cents: Cents): Promise<void>;
  cart(): Promise<StoreCart>;
  savedPaymentMethods(): Promise<{ id: string; label: string }[]>;
  placeOrder(input: { paymentMethodId: string; expectedTotalCents: Cents }): Promise<{ orderId: string }>;
  order(orderId: string): Promise<StoreOrderStatus | null>;
}

export function parseMoney(s: string): Cents | null {
  const m = /-?\$\s?([\d,]+)\.(\d{2})/.exec(s);
  if (!m) return null;
  const v = Number(m[1]!.replace(/,/g, "")) * 100 + Number(m[2]);
  return s.trim().startsWith("-") ? -v : v;
}

export const formatCents = (c: Cents) => `$${(c / 100).toFixed(2)}`;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(\+\$[\d.,]+\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** "1 × Pad thai (Protein: Chicken, Spice level: Mild) — $13.50" */
export function parseLine(text: string): { qty: number; name: string; options: string[]; lineCents: Cents | null } | null {
  const m = /^(\d+) × (.+?)(?: \((.+)\))?(?: — (\$[\d,.]+))?$/.exec(text.trim());
  if (!m) return null;
  return { qty: Number(m[1]), name: m[2]!, options: m[3] ? m[3].split(", ") : [], lineCents: m[4] ? parseMoney(m[4]) : null };
}

interface ItemOptions {
  groups: Array<{ name: string; kind: "radio" | "checkbox" | "select"; required: boolean; choices: Array<{ id: string; label: string; cents: Cents }> }>;
}

export class DashDishBridgeStore implements StoreClientLike {
  /** "sandbox" when the store is the sandbox web world: the ordering pack labels its approvals simulated. */
  readonly kind: "sandbox" | "bridge";
  readonly storeName: string;
  private tabId: number | null = null;
  private menuCache: StoreMenuItem[] | null = null;
  private optionCache = new Map<string, ItemOptions>();

  constructor(
    private readonly bridge: BridgeApi,
    private readonly origin: string,
    readonly storeId = "thai-basil",
    storeName = "Thai Basil",
    private readonly taskId = "ordering",
  ) {
    this.kind = isSandboxOrigin(origin) ? "sandbox" : "bridge";
    this.storeName = `${storeName} on DashDish${this.kind === "sandbox" ? " (sandbox)" : ""}`;
  }

  private async go(path: string): Promise<number> {
    const url = this.origin + path;
    if (this.tabId === null) {
      this.tabId = (await this.bridge.call("tabs.open", { url })).tabId;
      await this.bridge.call("session.start", { tabId: this.tabId, taskId: this.taskId });
    } else {
      await this.bridge.call("tabs.navigate", { tabId: this.tabId, url });
    }
    return this.tabId;
  }

  private async nodes(): Promise<TreeNode[]> {
    return (await this.bridge.call("page.tree", { tabId: this.tabId!, maxNodes: 1500 })).data.nodes;
  }

  private async click(node: TreeNode): Promise<void> {
    await this.bridge.call("page.click", { tabId: this.tabId!, ref: node.ref });
  }

  private async itemOptions(itemId: string): Promise<{ options: ItemOptions; baseCents: Cents; name: string }> {
    await this.go(`/r/${this.storeId}/item/${itemId}`);
    const nodes = await this.nodes();
    const name = nodes.find((n) => n.role === "heading" && n.level === 1)?.name.trim() ?? itemId;
    const add = nodes.find((n) => n.role === "button" && n.name.startsWith("Add to cart"));
    const groups: ItemOptions["groups"] = [];
    let current: ItemOptions["groups"][number] | null = null;
    for (const n of nodes) {
      if (n.role === "group") {
        current = { name: n.name.replace(/ \(required\)$/, ""), kind: "radio", required: /\(required\)$/.test(n.name), choices: [] };
        groups.push(current);
      } else if ((n.role === "radio" || n.role === "checkbox") && current) {
        current.kind = n.role;
        current.choices.push({ id: slug(n.name), label: n.name.replace(/ \(\+\$[\d.,]+\)$/, ""), cents: parseMoney(n.name) ?? 0 });
      } else if (n.role === "combobox" && n.name !== "Quantity") {
        groups.push({
          name: n.name,
          kind: "select",
          required: true,
          choices: (n.options ?? []).map((o) => ({ id: slug(o), label: o.replace(/ \(\+\$[\d.,]+\)$/, ""), cents: parseMoney(o) ?? 0 })),
        });
        current = null;
      }
    }
    const options = { groups };
    this.optionCache.set(itemId, options);
    return { options, baseCents: parseMoney(add?.name ?? "") ?? 0, name };
  }

  async menu(): Promise<StoreMenuItem[]> {
    if (this.menuCache) return this.menuCache;
    await this.go(`/r/${this.storeId}`);
    const links = (await this.nodes()).filter((n) => n.role === "link" && n.name.startsWith("Add ") && n.href?.includes("/item/"));
    const items: StoreMenuItem[] = [];
    for (const l of links) {
      const itemId = l.href!.split("/item/")[1]!.split(/[?#]/)[0]!;
      const { options, baseCents, name } = await this.itemOptions(itemId);
      const opts = options.groups.flatMap((g) => g.choices.map((c) => ({ id: c.id, label: c.label, priceCents: c.cents })));
      items.push({ id: itemId, name, priceCents: baseCents, ...(opts.length ? { options: opts } : {}) });
    }
    this.menuCache = items;
    return items;
  }

  async clearCart(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await this.go("/cart");
      const remove = (await this.nodes()).find((n) => n.role === "button" && n.name.startsWith("Remove "));
      if (!remove) return;
      await this.click(remove);
    }
    throw new Error("The cart didn't empty.");
  }

  async addToCart(itemId: string, qty: number, optionIds: string[]): Promise<void> {
    await this.itemOptions(itemId);
    const groups = this.optionCache.get(itemId)?.groups ?? [];
    let nodes = await this.nodes();
    const unknown = optionIds.filter((id) => !groups.some((g) => g.choices.some((c) => c.id === id)));
    if (unknown.length) throw new Error(`The store has no option ${unknown.join(", ")} for ${itemId}.`);
    for (const g of groups) {
      const picked = g.choices.filter((c) => optionIds.includes(c.id));
      // A required choice the person didn't specify takes the store's first choice.
      const want = picked.length ? picked : g.required ? g.choices.slice(0, 1) : [];
      if (g.kind === "select") {
        const sel = nodes.find((n) => n.role === "combobox" && n.name === g.name);
        if (sel && want[0]) await this.bridge.call("page.select", { tabId: this.tabId!, ref: sel.ref, option: want[0].label });
        continue;
      }
      for (const c of want) {
        const box = nodes.find((n) => n.role === g.kind && n.name.replace(/ \(\+\$[\d.,]+\)$/, "") === c.label);
        if (box && !box.state.checked) await this.click(box);
      }
      nodes = await this.nodes();
    }
    const q = nodes.find((n) => n.role === "combobox" && n.name === "Quantity");
    if (q) await this.bridge.call("page.select", { tabId: this.tabId!, ref: q.ref, option: String(qty) });
    const add = (await this.nodes()).find((n) => n.role === "button" && n.name.startsWith("Add to cart"));
    if (!add) throw new Error("No Add to cart button.");
    await this.click(add);
    const after = await this.nodes();
    const replace = after.find((n) => n.role === "button" && n.name === "Start new cart");
    if (replace) await this.click(replace);
  }

  async setTip(cents: Cents): Promise<void> {
    await this.go("/checkout");
    let nodes = await this.nodes();
    const other = nodes.find((n) => n.role === "radio" && n.name === "Other");
    if (!other) throw new Error("No custom tip choice on the checkout page.");
    await this.click(other);
    nodes = await this.nodes();
    const amount = nodes.find((n) => n.role === "spinbutton" && /Amount/.test(n.name));
    const update = nodes.find((n) => n.role === "button" && n.name === "Update tip");
    if (!amount || !update) throw new Error("No tip amount field.");
    await this.bridge.call("page.type", { tabId: this.tabId!, ref: amount.ref, text: (cents / 100).toFixed(2) });
    await this.click(update);
  }

  private async readCheckout(): Promise<{ cart: StoreCart; place: TreeNode | null; payment: string | null }> {
    await this.go("/checkout");
    const page = await this.bridge.call("page.tree", { tabId: this.tabId!, maxNodes: 1500 });
    if (!page.data.url.includes("/checkout"))
      return { cart: { lines: [], subtotalCents: 0, fees: [], tipCents: 0, totalCents: 0, deliverTo: "" }, place: null, payment: null };
    const nodes = page.data.nodes;
    const tables = await this.bridge.call("page.extractTables", { tabId: this.tabId! });
    const sum = tables.data.find((t) => t.caption === "Order total") ?? tables.data[0];
    const rows = new Map((sum?.rows ?? []).map((r) => [r[0] ?? "", parseMoney(r[1] ?? "") ?? 0]));
    const menu = this.menuCache ?? [];
    const lines: StoreCartLine[] = [];
    for (const n of nodes.filter((x) => x.role === "listitem")) {
      const l = parseLine(n.name);
      if (!l || l.lineCents === null) continue;
      const itemId = menu.find((m) => m.name === l.name)?.id ?? slug(l.name);
      lines.push({ itemId, name: l.name, qty: l.qty, options: l.options, unitCents: Math.round(l.lineCents / l.qty), lineCents: l.lineCents });
    }
    const tipKey = [...rows.keys()].find((k) => k.startsWith("Tip")) ?? "Tip";
    const text = (await this.bridge.call("page.extractText", { tabId: this.tabId! })).data.text;
    const deliverTo = /Deliver to (.+?)\. Pay with/.exec(text)?.[1] ?? "";
    const payment = nodes.find((n) => n.role === "radio" && /ending in \d{4}/.test(n.name))?.name ?? null;
    return {
      cart: {
        lines,
        subtotalCents: rows.get("Subtotal") ?? 0,
        fees: ["Delivery fee", "Service fee", "Estimated tax"].filter((k) => rows.has(k)).map((k) => ({ label: k, cents: rows.get(k)! })),
        tipCents: rows.get(tipKey) ?? 0,
        totalCents: rows.get("Total") ?? 0,
        deliverTo,
      },
      place: nodes.find((n) => n.role === "button" && n.name === "Place order") ?? null,
      payment,
    };
  }

  async cart(): Promise<StoreCart> {
    if (!this.menuCache) await this.menu();
    return (await this.readCheckout()).cart;
  }

  async savedPaymentMethods(): Promise<{ id: string; label: string }[]> {
    const { payment } = await this.readCheckout();
    return payment ? [{ id: "saved-card", label: payment }] : [];
  }

  async placeOrder(input: { paymentMethodId: string; expectedTotalCents: Cents }): Promise<{ orderId: string }> {
    if (input.paymentMethodId !== "saved-card") throw new Error("Only the card saved on the site can be used.");
    const { cart, place } = await this.readCheckout();
    if (!place) throw new Error("The checkout page has no Place order button.");
    if (cart.totalCents !== input.expectedTotalCents)
      throw new Error(`The total changed (${formatCents(input.expectedTotalCents)} → ${formatCents(cart.totalCents)}). The order was not placed.`);
    const described = await this.bridge.call("page.describeAction", { tabId: this.tabId!, ref: place.ref });
    const shown = Object.values(described.data.details).join("\n");
    if (!new RegExp(`Total\\s+\\${formatCents(input.expectedTotalCents)}(\\D|$)`).test(shown))
      throw new Error("The page doesn't show the approved total next to Place order. The order was not placed.");
    const r = await this.bridge.call("page.click", { tabId: this.tabId!, ref: place.ref, approvedFingerprint: described.data.fingerprint });
    const id = /\/orders\/(DD-\d+)/.exec(r.url)?.[1];
    if (!id) throw new Error("The store didn't show an order confirmation.");
    return { orderId: id };
  }

  async order(orderId: string): Promise<StoreOrderStatus | null> {
    await this.go(`/orders/${encodeURIComponent(orderId)}`);
    const nodes = await this.nodes();
    const text = (await this.bridge.call("page.extractText", { tabId: this.tabId! })).data.text;
    const status = /Status: (Order received|Preparing|Out for delivery|Delivered|Cancelled)/.exec(text)?.[1];
    if (!status) return null;
    const map: Record<string, StoreOrderStatus["status"]> = {
      "Order received": "confirmed",
      Preparing: "preparing",
      "Out for delivery": "on-the-way",
      Delivered: "delivered",
      Cancelled: "cancelled",
    };
    const tables = await this.bridge.call("page.extractTables", { tabId: this.tabId! });
    const total = tables.data.find((t) => t.caption === "Order total")?.rows.find((r) => r[0] === "Total")?.[1] ?? "";
    const lines = nodes
      .filter((n) => n.role === "listitem")
      .map((n) => parseLine(n.name))
      .filter((l): l is NonNullable<typeof l> => !!l)
      .map(({ name, qty, options }) => ({ name, qty, options }));
    return { orderId, status: map[status]!, totalCents: parseMoney(total) ?? 0, lines };
  }

  /** Ends the visible session in the person's tab. */
  async finish(): Promise<void> {
    if (this.tabId !== null) await this.bridge.call("session.end", { tabId: this.tabId });
  }
}
