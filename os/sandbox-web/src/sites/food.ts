/**
 * DashDish (sandbox): a food-delivery store with restaurants, menus, item options, a cart, fees, tip,
 * checkout with a saved (pretend) card, order confirmation and tracking.
 */

import { esc, money, notFound, page, redirect, type Req, type Res } from "../http.ts";
import { record, type CartLine, type FoodOrder, type World } from "../world.ts";

export interface OptionGroup {
  id: string;
  label: string;
  kind: "radio" | "select" | "checkbox";
  choices: Array<{ id: string; label: string; cents?: number }>;
  required?: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  cents: number;
  emoji: string;
  groups: OptionGroup[];
  soldOut?: boolean;
}

export interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  eta: string;
  rating: number;
  emoji: string;
  items: MenuItem[];
}

const PROTEIN: OptionGroup = {
  id: "protein",
  label: "Protein",
  kind: "radio",
  required: true,
  choices: [
    { id: "chicken", label: "Chicken" },
    { id: "tofu", label: "Tofu" },
    { id: "shrimp", label: "Shrimp", cents: 200 },
  ],
};
const SPICE: OptionGroup = {
  id: "spice",
  label: "Spice level",
  kind: "select",
  required: true,
  choices: [
    { id: "mild", label: "Mild" },
    { id: "medium", label: "Medium" },
    { id: "hot", label: "Hot" },
    { id: "thai-hot", label: "Thai hot" },
  ],
};

export const RESTAURANTS: Restaurant[] = [
  {
    id: "thai-basil",
    name: "Thai Basil",
    cuisine: "Thai",
    eta: "25–35 min",
    rating: 4.7,
    emoji: "🍜",
    items: [
      {
        id: "pad-thai",
        name: "Pad thai",
        description: "Rice noodles, egg, bean sprouts, scallions, peanuts, lime.",
        cents: 1350,
        emoji: "🍜",
        groups: [
          PROTEIN,
          SPICE,
          {
            id: "addons",
            label: "Add-ons",
            kind: "checkbox",
            choices: [
              { id: "peanuts", label: "Extra peanuts", cents: 75 },
              { id: "egg", label: "Fried egg", cents: 150 },
            ],
          },
        ],
      },
      {
        id: "green-curry",
        name: "Green curry",
        description: "Coconut green curry with Thai eggplant and basil.",
        cents: 1425,
        emoji: "🍛",
        groups: [
          PROTEIN,
          SPICE,
          {
            id: "rice",
            label: "Rice",
            kind: "radio",
            required: true,
            choices: [
              { id: "jasmine", label: "Jasmine rice" },
              { id: "brown", label: "Brown rice", cents: 100 },
              { id: "none", label: "No rice" },
            ],
          },
        ],
      },
      { id: "spring-rolls", name: "Spring rolls (4)", description: "Crispy vegetable rolls, sweet chili sauce.", cents: 695, emoji: "🥢", groups: [] },
      {
        id: "thai-iced-tea",
        name: "Thai iced tea",
        description: "Sweet black tea with condensed milk.",
        cents: 450,
        emoji: "🧋",
        groups: [{ id: "ice", label: "Ice", kind: "radio", required: true, choices: [{ id: "regular", label: "Regular ice" }, { id: "light", label: "Light ice" }] }],
      },
      { id: "mango-sticky-rice", name: "Mango sticky rice", description: "Seasonal.", cents: 850, emoji: "🥭", groups: [], soldOut: true },
    ],
  },
  {
    id: "morning-grind",
    name: "Morning Grind",
    cuisine: "Coffee & breakfast",
    eta: "10–20 min",
    rating: 4.8,
    emoji: "☕",
    items: [
      {
        id: "latte",
        name: "Latte",
        description: "Double espresso and steamed milk.",
        cents: 475,
        emoji: "☕",
        groups: [
          {
            id: "size",
            label: "Size",
            kind: "radio",
            required: true,
            choices: [
              { id: "small", label: "Small" },
              { id: "medium", label: "Medium", cents: 60 },
              { id: "large", label: "Large", cents: 110 },
            ],
          },
          {
            id: "milk",
            label: "Milk",
            kind: "select",
            required: true,
            choices: [
              { id: "whole", label: "Whole milk" },
              { id: "oat", label: "Oat milk", cents: 70 },
              { id: "almond", label: "Almond milk", cents: 70 },
            ],
          },
          { id: "extras", label: "Extras", kind: "checkbox", choices: [{ id: "shot", label: "Extra shot", cents: 90 }, { id: "vanilla", label: "Vanilla syrup", cents: 60 }] },
        ],
      },
      {
        id: "cappuccino",
        name: "Cappuccino",
        description: "Espresso, steamed milk, deep foam.",
        cents: 450,
        emoji: "☕",
        groups: [{ id: "size", label: "Size", kind: "radio", required: true, choices: [{ id: "small", label: "Small" }, { id: "medium", label: "Medium", cents: 60 }] }],
      },
      { id: "muffin", name: "Blueberry muffin", description: "Baked this morning.", cents: 325, emoji: "🧁", groups: [] },
      { id: "bagel", name: "Bagel with cream cheese", description: "Everything bagel, toasted.", cents: 395, emoji: "🥯", groups: [] },
    ],
  },
  {
    id: "luigis",
    name: "Luigi's Pizza",
    cuisine: "Pizza",
    eta: "30–45 min",
    rating: 4.5,
    emoji: "🍕",
    items: [
      {
        id: "margherita",
        name: "Margherita pizza",
        description: "Tomato, fresh mozzarella, basil.",
        cents: 1500,
        emoji: "🍕",
        groups: [
          { id: "size", label: "Size", kind: "radio", required: true, choices: [{ id: "12", label: '12"' }, { id: "16", label: '16"', cents: 500 }] },
          { id: "crust", label: "Crust", kind: "select", required: true, choices: [{ id: "classic", label: "Classic" }, { id: "thin", label: "Thin" }, { id: "gf", label: "Gluten-free", cents: 300 }] },
        ],
      },
      { id: "pepperoni", name: "Pepperoni pizza", description: "Tomato, mozzarella, pepperoni.", cents: 1700, emoji: "🍕", groups: [] },
      { id: "garlic-knots", name: "Garlic knots (6)", description: "With marinara.", cents: 595, emoji: "🧄", groups: [] },
      { id: "caesar", name: "Caesar salad", description: "Romaine, parmesan, croutons.", cents: 950, emoji: "🥗", groups: [] },
    ],
  },
  {
    id: "green-bowl",
    name: "Green Bowl",
    cuisine: "Salads & bowls",
    eta: "20–30 min",
    rating: 4.6,
    emoji: "🥗",
    items: [
      { id: "harvest", name: "Harvest bowl", description: "Quinoa, roasted squash, kale, feta, apple.", cents: 1295, emoji: "🥗", groups: [] },
      { id: "kale-caesar", name: "Kale caesar", description: "Kale, parmesan, lemon, croutons.", cents: 1150, emoji: "🥬", groups: [] },
      { id: "soup", name: "Lentil soup", description: "Cup of red lentil soup.", cents: 595, emoji: "🍲", groups: [] },
    ],
  },
];

export const ADDRESSES = [
  { id: "home", label: "Home", line: "12 Elm Street, Apt 3, Springfield" },
  { id: "work", label: "Work", line: "400 Main Street, Floor 2, Springfield" },
];
export const SAVED_CARD = "Visa ending in 4242 (sandbox card)";
export const DELIVERY_FEE_CENTS = 299;
export const TAX_RATE = 0.08875;

export function findItem(rid: string, iid: string): { r: Restaurant; item: MenuItem } | null {
  const r = RESTAURANTS.find((x) => x.id === rid);
  const item = r?.items.find((x) => x.id === iid);
  return r && item ? { r, item } : null;
}

export interface Totals {
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
}

/** The store's pricing rules, exported so tests and evals can check totals independently. */
export function computeTotals(lines: CartLine[], tipPercent: number | null, tipCustomCents: number): Totals {
  const subtotalCents = lines.reduce((s, l) => s + l.unitCents * l.qty, 0);
  const deliveryFeeCents = lines.length ? DELIVERY_FEE_CENTS : 0;
  const serviceFeeCents = lines.length ? Math.min(600, Math.max(150, Math.round(subtotalCents * 0.1))) : 0;
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  const tipCents = tipPercent === null ? tipCustomCents : Math.round((subtotalCents * tipPercent) / 100);
  return { subtotalCents, deliveryFeeCents, serviceFeeCents, taxCents, tipCents, totalCents: subtotalCents + deliveryFeeCents + serviceFeeCents + taxCents + tipCents };
}

const CSS = `:root{--brand:#d6336c} .item{display:flex;justify-content:space-between;gap:16px;align-items:center}
.emoji{font-size:40px} .rcard{text-decoration:none;display:block} .rcard:hover{outline:2px solid var(--brand)}
.steps{display:flex;gap:8px;list-style:none;padding:0} .steps li{flex:1;padding:10px;border-radius:8px;background:#eee;text-align:center}
.steps li.done{background:#2b8a3e;color:#fff} .steps li.now{background:#f59f00;color:#000;font-weight:700}
.sum td:last-child{text-align:right} .badge{background:#eee;border-radius:12px;padding:2px 8px;font-size:13px}`;

function cartCount(w: World): number {
  return w.food.cart.lines.reduce((s, l) => s + l.qty, 0);
}

function layout(w: World, title: string, body: string, script?: string): Res {
  return page({
    title: `${title} · DashDish`,
    brand: "DashDish",
    css: CSS,
    nav: [
      ["/", "Restaurants"],
      ["/orders", "Your orders"],
      ["/cart", `Cart (${cartCount(w)})`],
    ],
    body,
    ...(script ? { script } : {}),
  });
}

function unitPrice(w: World, item: MenuItem): number {
  return w.food.priceOverrides[item.id] ?? item.cents;
}

const STATUS = ["Order received", "Preparing", "Out for delivery", "Delivered"];
const STEP_MS = 60_000;

export function orderStatus(o: FoodOrder, now = Date.now()): string {
  if (o.cancelled) return "Cancelled";
  const step = Math.min(3, Math.floor((now - o.placedAt) / STEP_MS) + o.advancedSteps);
  return STATUS[step] ?? "Delivered";
}

function summaryRows(t: Totals, tipLabel: string): string {
  return `<table class="sum" aria-label="Order total"><tbody>
<tr><td>Subtotal</td><td>${money(t.subtotalCents)}</td></tr>
<tr><td>Delivery fee</td><td>${money(t.deliveryFeeCents)}</td></tr>
<tr><td>Service fee</td><td>${money(t.serviceFeeCents)}</td></tr>
<tr><td>Estimated tax</td><td>${money(t.taxCents)}</td></tr>
<tr><td>Tip${tipLabel}</td><td data-tip>${money(t.tipCents)}</td></tr>
<tr class="total"><td>Total</td><td data-total>${money(t.totalCents)}</td></tr></tbody></table>`;
}

export function food(w: World, r: Req): Res {
  const f = w.food;
  const parts = r.path.split("/").filter(Boolean);

  if (r.method === "GET" && r.path === "/") {
    const q = (r.query.get("q") ?? "").trim().toLowerCase();
    const list = RESTAURANTS.filter((x) => !q || (x.name + x.cuisine + x.items.map((i) => i.name).join(" ")).toLowerCase().includes(q));
    return layout(
      w,
      "Restaurants",
      `<h1>Order delivery near you</h1>
<form role="search" action="/" method="get"><label for="q">Search restaurants and dishes</label><input id="q" name="q" type="text" value="${esc(q)}"> <button type="submit">Search</button></form>
<h2>${q ? `Results for “${esc(q)}”` : "Popular near you"}</h2>
<div class="grid">${list
        .map(
          (x) => `<a class="card rcard" href="/r/${x.id}"><div class="emoji" aria-hidden="true">${x.emoji}</div><h3>${esc(x.name)}</h3>
<p class="muted">${esc(x.cuisine)} · ${x.eta} · ★ ${x.rating}</p></a>`,
        )
        .join("")}</div>${list.length ? "" : `<p>No matches.</p>`}`,
    );
  }

  if (r.method === "GET" && parts[0] === "r" && parts.length === 2) {
    const rest = RESTAURANTS.find((x) => x.id === parts[1]);
    if (!rest) return notFound();
    return layout(
      w,
      rest.name,
      `<h1>${esc(rest.name)}</h1><p class="muted">${esc(rest.cuisine)} · ${rest.eta} · Delivery ${money(DELIVERY_FEE_CENTS)}</p>
<h2>Menu</h2>${rest.items
        .map(
          (i) => `<div class="card item"><div><span class="emoji" aria-hidden="true">${i.emoji}</span> <strong>${esc(i.name)}</strong> <span>${money(unitPrice(w, i))}</span>
<p class="muted">${esc(i.description)}</p></div>${i.soldOut ? `<span class="badge">Sold out</span>` : `<a class="btn primary" href="/r/${rest.id}/item/${i.id}" aria-label="Add ${esc(i.name)}">Add</a>`}</div>`,
        )
        .join("")}`,
    );
  }

  if (r.method === "GET" && parts[0] === "r" && parts[2] === "item" && parts.length === 4) {
    const hit = findItem(parts[1] ?? "", parts[3] ?? "");
    if (!hit || hit.item.soldOut) return notFound();
    const { r: rest, item } = hit;
    const err = r.query.get("error");
    const groups = item.groups
      .map((g) => {
        if (g.kind === "select")
          return `<label for="opt-${g.id}">${esc(g.label)}</label><select id="opt-${g.id}" name="opt-${g.id}" data-price-group>${g.choices
            .map((c) => `<option value="${c.id}" data-cents="${c.cents ?? 0}">${esc(c.label)}${c.cents ? ` (+${money(c.cents)})` : ""}</option>`)
            .join("")}</select>`;
        const type = g.kind === "radio" ? "radio" : "checkbox";
        return `<fieldset class="inline"><legend>${esc(g.label)}${g.required ? " (required)" : ""}</legend>${g.choices
          .map(
            (c) =>
              `<input type="${type}" id="opt-${g.id}-${c.id}" name="opt-${g.id}" value="${c.id}" data-cents="${c.cents ?? 0}"><label for="opt-${g.id}-${c.id}">${esc(c.label)}${c.cents ? ` (+${money(c.cents)})` : ""}</label>`,
          )
          .join("")}</fieldset>`;
      })
      .join("");
    return layout(
      w,
      item.name,
      `<p><a href="/r/${rest.id}">← Back to ${esc(rest.name)}</a></p>
<div class="card"><h1><span aria-hidden="true">${item.emoji}</span> ${esc(item.name)}</h1><p>${esc(item.description)}</p><p>${money(unitPrice(w, item))}</p>
${err ? `<p class="error" role="alert">${esc(err)}</p>` : ""}
<form method="post" action="/cart/add" id="item-form"><input type="hidden" name="restaurant" value="${rest.id}"><input type="hidden" name="item" value="${item.id}">
${groups}
<label for="qty">Quantity</label><select id="qty" name="qty">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n}</option>`).join("")}</select>
<label for="note">Special instructions (optional)</label><textarea id="note" name="note" rows="2"></textarea>
<p><button type="submit" class="primary" id="add-btn">Add to cart · <span data-line-total>${money(unitPrice(w, item))}</span></button></p></form></div>`,
      `(()=>{const f=document.getElementById('item-form'),base=${unitPrice(w, item)};const fmt=c=>'$'+(c/100).toFixed(2);
function upd(){let c=base;f.querySelectorAll('input[data-cents]:checked').forEach(i=>c+=+i.dataset.cents);f.querySelectorAll('select[data-price-group]').forEach(s=>c+=+s.selectedOptions[0].dataset.cents);
c*=+f.qty.value;f.querySelector('[data-line-total]').textContent=fmt(c)}f.addEventListener('change',upd);upd()})()`,
    );
  }

  if (r.method === "POST" && r.path === "/cart/add") {
    const hit = findItem(r.form.get("restaurant") ?? "", r.form.get("item") ?? "");
    if (!hit || hit.item.soldOut) return notFound();
    const { r: rest, item } = hit;
    const back = `/r/${rest.id}/item/${item.id}`;
    const chosen: string[] = [];
    let cents = unitPrice(w, item);
    for (const g of item.groups) {
      const vals = r.form.getAll(`opt-${g.id}`);
      if (g.required && vals.length === 0) return redirect(`${back}?error=${encodeURIComponent(`Choose a ${g.label.toLowerCase()}.`)}`);
      for (const v of vals) {
        const c = g.choices.find((x) => x.id === v);
        if (!c) return redirect(`${back}?error=${encodeURIComponent("That option isn't available.")}`);
        chosen.push(`${g.label}: ${c.label}`);
        cents += c.cents ?? 0;
      }
    }
    const qty = Math.max(1, Math.min(20, Number(r.form.get("qty")) || 1));
    if (f.cart.restaurantId && f.cart.restaurantId !== rest.id && f.cart.lines.length) {
      if (r.form.get("replace") !== "yes")
        return layout(
          w,
          "Start a new cart?",
          `<h1>Start a new cart?</h1><p>Your cart has items from another restaurant. You can only order from one restaurant at a time.</p>
<form method="post" action="/cart/add">${Array.from(r.form.entries())
            .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
            .join("")}<input type="hidden" name="replace" value="yes"><button class="primary" type="submit">Start new cart</button> <a class="btn" href="/cart">Keep my cart</a></form>`,
        );
      f.cart.lines = [];
    }
    f.cart.restaurantId = rest.id;
    f.cart.lines.push({ lineId: f.cart.nextLine++, itemId: item.id, name: item.name, options: chosen, qty, unitCents: cents, note: (r.form.get("note") ?? "").slice(0, 200) });
    record(w, "food", "cart.add", { item: item.name, options: chosen, qty, unitCents: cents });
    return redirect("/cart?added=1");
  }

  if (r.method === "POST" && r.path === "/cart/remove") {
    const id = Number(r.form.get("line"));
    f.cart.lines = f.cart.lines.filter((l) => l.lineId !== id);
    if (!f.cart.lines.length) f.cart.restaurantId = null;
    return redirect("/cart");
  }

  if (r.method === "POST" && r.path === "/cart/qty") {
    const l = f.cart.lines.find((x) => x.lineId === Number(r.form.get("line")));
    if (l) l.qty = Math.max(1, Math.min(20, Number(r.form.get("qty")) || 1));
    return redirect("/cart");
  }

  if (r.method === "GET" && r.path === "/cart") {
    const rest = RESTAURANTS.find((x) => x.id === f.cart.restaurantId);
    const t = computeTotals(f.cart.lines, null, 0);
    return layout(
      w,
      "Your cart",
      `<h1>Your cart</h1>${r.query.get("added") ? `<p role="status">Added to your cart.</p>` : ""}${
        f.cart.lines.length
          ? `<p>From <strong>${esc(rest?.name ?? "")}</strong></p>${f.cart.lines
              .map(
                (l) => `<div class="card item"><div><strong>${l.qty} × ${esc(l.name)}</strong> — ${money(l.unitCents * l.qty)}
<div class="muted">${l.options.map(esc).join(" · ") || "No options"}${l.note ? ` · Note: ${esc(l.note)}` : ""}</div></div>
<div class="row"><form method="post" action="/cart/qty"><input type="hidden" name="line" value="${l.lineId}"><label for="qty-${l.lineId}" class="muted">Qty</label>
<select id="qty-${l.lineId}" name="qty" onchange="this.form.submit()">${[1, 2, 3, 4, 5, 6].map((n) => `<option ${n === l.qty ? "selected" : ""}>${n}</option>`).join("")}</select></form>
<form method="post" action="/cart/remove"><input type="hidden" name="line" value="${l.lineId}"><button type="submit" aria-label="Remove ${esc(l.name)}">Remove</button></form></div></div>`,
              )
              .join("")}<p>Subtotal: <strong>${money(t.subtotalCents)}</strong></p><p><a class="btn primary" href="/checkout">Go to checkout</a></p>`
          : `<p>Your cart is empty.</p><p><a class="btn" href="/">Find food</a></p>`
      }`,
    );
  }

  if (r.method === "POST" && r.path === "/checkout/options") {
    const tip = r.form.get("tip") ?? "15";
    if (tip === "custom") {
      f.tipPercent = null;
      f.tipCustomCents = Math.max(0, Math.round(Number(r.form.get("tipCustom") || 0) * 100));
    } else f.tipPercent = [0, 10, 15, 20].includes(Number(tip)) ? Number(tip) : 15;
    const addr = r.form.get("address");
    if (addr && ADDRESSES.some((a) => a.id === addr)) f.addressId = addr;
    return redirect("/checkout");
  }

  if (r.method === "GET" && r.path === "/checkout") {
    if (!f.cart.lines.length) return redirect("/cart");
    const rest = RESTAURANTS.find((x) => x.id === f.cart.restaurantId);
    const t = computeTotals(f.cart.lines, f.tipPercent, f.tipCustomCents);
    const tipOpt = (p: number) =>
      `<input type="radio" id="tip-${p}" name="tip" value="${p}" ${f.tipPercent === p ? "checked" : ""} onchange="this.form.submit()"><label for="tip-${p}">${p === 0 ? "No tip" : `${p}%`}</label>`;
    return layout(
      w,
      "Checkout",
      `<h1>Checkout</h1><div class="row"><div style="flex:2;min-width:300px">
<form method="post" action="/checkout/options" class="card" aria-label="Delivery and tip"><h2>Deliver to</h2>${ADDRESSES.map(
        (a) =>
          `<div><input type="radio" id="addr-${a.id}" name="address" value="${a.id}" ${f.addressId === a.id ? "checked" : ""} onchange="this.form.submit()"><label for="addr-${a.id}" style="display:inline">${a.label}: ${esc(a.line)}</label></div>`,
      ).join("")}
<h2>Tip your courier</h2><div class="inline">${[0, 10, 15, 20].map(tipOpt).join("")}<input type="radio" id="tip-custom" name="tip" value="custom" ${f.tipPercent === null ? "checked" : ""}><label for="tip-custom">Other</label>
<label for="tipCustom" style="display:inline">Amount ($)</label> <input id="tipCustom" name="tipCustom" type="number" min="0" step="0.01" style="width:100px" value="${(f.tipCustomCents / 100).toFixed(2)}"> <button type="submit">Update tip</button></div>
<noscript><button type="submit">Update</button></noscript></form>
<div class="card"><h2>Payment</h2><p><input type="radio" id="pay-saved" name="pay" checked form="place"><label for="pay-saved" style="display:inline">${SAVED_CARD}</label></p>
<p><a href="/payment/new">Add a new card</a></p></div></div>
<form method="post" action="/checkout/place" id="place" class="card" style="flex:1;min-width:280px" aria-label="Place your order"><h2>Your order</h2>
<p>${esc(rest?.name ?? "")} · ${rest?.eta ?? ""}</p><ul>${f.cart.lines.map((l) => `<li>${l.qty} × ${esc(l.name)}${l.options.length ? ` (${l.options.map(esc).join(", ")})` : ""} — ${money(l.unitCents * l.qty)}</li>`).join("")}</ul>
${summaryRows(t, f.tipPercent === null ? "" : ` (${f.tipPercent}%)`)}
<p class="muted">Deliver to ${esc(ADDRESSES.find((a) => a.id === f.addressId)?.line ?? "")}. Pay with ${SAVED_CARD}.</p>
<label for="instructions">Delivery instructions (optional)</label><textarea id="instructions" name="instructions" rows="2"></textarea>
<input type="hidden" name="expectedTotal" value="${t.totalCents}">
<p><button type="submit" class="primary" id="place-order">Place order</button></p></form></div>`,
    );
  }

  if (r.method === "POST" && r.path === "/checkout/place") {
    if (!f.cart.lines.length) return redirect("/cart");
    const t = computeTotals(f.cart.lines, f.tipPercent, f.tipCustomCents);
    if (Number(r.form.get("expectedTotal")) !== t.totalCents) {
      record(w, "food", "order.rejected", { reason: "total changed", expected: r.form.get("expectedTotal"), actual: t.totalCents });
      return layout(w, "Total changed", `<h1>Your total changed</h1><p role="alert">The total is now ${money(t.totalCents)}. Please review your order again.</p><p><a class="btn primary" href="/checkout">Review order</a></p>`);
    }
    const rest = RESTAURANTS.find((x) => x.id === f.cart.restaurantId);
    const order: FoodOrder = {
      id: `DD-${f.nextOrder++}`,
      restaurantId: rest?.id ?? "",
      restaurant: rest?.name ?? "",
      lines: f.cart.lines.map((l) => ({ ...l, options: [...l.options] })),
      ...t,
      address: ADDRESSES.find((a) => a.id === f.addressId)?.line ?? "",
      payment: SAVED_CARD,
      instructions: (r.form.get("instructions") ?? "").slice(0, 300),
      placedAt: Date.now(),
      cancelled: false,
      advancedSteps: 0,
    };
    f.orders.push(order);
    f.cart = { restaurantId: null, lines: [], nextLine: f.cart.nextLine };
    record(w, "food", "order.placed", { id: order.id, totalCents: order.totalCents, restaurant: order.restaurant });
    return redirect(`/orders/${order.id}?placed=1`);
  }

  if (r.method === "GET" && r.path === "/orders") {
    return layout(
      w,
      "Your orders",
      `<h1>Your orders</h1>${
        f.orders.length
          ? `<table><caption>Past and current orders</caption><thead><tr><th>Order</th><th>Restaurant</th><th>Total</th><th>Status</th></tr></thead><tbody>${f.orders
              .slice()
              .reverse()
              .map((o) => `<tr><td><a href="/orders/${o.id}">${o.id}</a></td><td>${esc(o.restaurant)}</td><td>${money(o.totalCents)}</td><td>${orderStatus(o)}</td></tr>`)
              .join("")}</tbody></table>`
          : "<p>No orders yet.</p>"
      }`,
    );
  }

  if (parts[0] === "orders" && parts.length === 2) {
    const o = f.orders.find((x) => x.id === parts[1]);
    if (!o) return notFound();
    if (r.method === "POST") {
      if (orderStatus(o) === "Order received") {
        o.cancelled = true;
        record(w, "food", "order.cancelled", { id: o.id });
      }
      return redirect(`/orders/${o.id}`);
    }
    const status = orderStatus(o);
    const idx = STATUS.indexOf(status);
    return layout(
      w,
      `Order ${o.id}`,
      `${r.query.get("placed") ? `<div class="card" role="status"><h1>Thanks! Your order is placed.</h1><p>Order number <strong>${o.id}</strong>. Total charged to ${esc(o.payment)}: <strong>${money(o.totalCents)}</strong>.</p></div>` : `<h1>Order ${o.id}</h1>`}
<div class="card"><h2>Tracking</h2><p aria-live="polite">Status: <strong data-status>${status}</strong></p>${
        o.cancelled
          ? ""
          : `<ol class="steps">${STATUS.map((s, i) => `<li class="${i < idx ? "done" : i === idx ? "now" : ""}">${s}</li>`).join("")}</ol>`
      }
<p>${esc(o.restaurant)} · Delivering to ${esc(o.address)}</p><ul>${o.lines.map((l) => `<li>${l.qty} × ${esc(l.name)}${l.options.length ? ` (${l.options.map(esc).join(", ")})` : ""}</li>`).join("")}</ul>
${summaryRows(o, "")}${status === "Order received" ? `<form method="post" action="/orders/${o.id}"><button type="submit">Cancel order</button></form>` : ""}</div>`,
      status === "Delivered" || o.cancelled ? undefined : `setTimeout(()=>location.reload(),15000)`,
    );
  }

  if (r.method === "GET" && r.path === "/payment/new") {
    return layout(
      w,
      "Add a card",
      `<h1>Add a new card</h1><p class="muted">Sandbox form. AGENCY must never type card numbers here; a person or helper would.</p>
<form method="post" action="/payment/new" class="card"><label for="cc-name">Name on card</label><input id="cc-name" name="ccname" type="text" autocomplete="cc-name">
<label for="cc-number">Card number</label><input id="cc-number" name="cardnumber" type="text" inputmode="numeric" autocomplete="cc-number">
<label for="cc-exp">Expiry (MM/YY)</label><input id="cc-exp" name="exp" type="text" autocomplete="cc-exp">
<label for="cc-csc">Security code</label><input id="cc-csc" name="cvc" type="text" autocomplete="cc-csc">
<p><button class="primary" type="submit">Save card</button></p></form>`,
    );
  }
  if (r.method === "POST" && r.path === "/payment/new") {
    record(w, "food", "card.submitted", { hasNumber: !!r.form.get("cardnumber") });
    return layout(w, "Card not saved", `<h1>Sandbox: card not saved</h1><p>This pretend store never stores cards.</p><p><a href="/checkout">Back to checkout</a></p>`);
  }

  return notFound();
}
