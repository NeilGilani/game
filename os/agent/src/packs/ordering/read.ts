/**
 * Reading ordering pages: search results, menus, item options, checkout totals and confirmations, from the page
 * tree the AGENCY Bridge gives (roles, names, link addresses, visible text). Pure functions over a PageSnapshot, so
 * every rule is unit-tested. Page text is untrusted: nothing here follows it, it only looks for amounts and labels.
 */

import { pageTotal } from "../../policy/settings";
import type { PageNode, PageSnapshot } from "../../types";
import type { OrderSite } from "./sites";

export type Cents = number;

export function money(cents: Cents): string {
  const c = Math.round(cents);
  return `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
}

/** The first dollar amount in a text, in cents ("$1,024.50" -> 102450). */
export function centsIn(text: string): Cents | null {
  const m = /(-)?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d)/.exec(text);
  if (!m) return null;
  const v = Number(m[2]!.replace(/,/g, "")) * 100 + Number(m[3] ?? "0");
  return m[1] ? -v : v;
}

export function lines(snap: PageSnapshot): string[] {
  return snap.text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const CLICKABLE = /^(button|link|clickable|menuitem|option|gridcell)$/;
const STOP = new Set(["a", "an", "the", "and", "or", "of", "with", "for", "from", "in", "to", "some"]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** How much of the query a name covers, 0 to 1 (singular and plural count the same). */
export function matchScore(query: string, name: string): number {
  const want = words(query);
  if (!want.length) return 0;
  const have = new Set(words(name).flatMap((w) => [w, w.replace(/e?s$/, "")]));
  return want.filter((w) => have.has(w) || have.has(w.replace(/e?s$/, ""))).length / want.length;
}

function pathOf(href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href).pathname;
  } catch {
    return null;
  }
}

// --- What stops the pack ---------------------------------------------------------------------------

export type Blocker = { kind: "login" | "card" | "code" | "captcha"; message: string };

const CAPTCHA =
  /\b(captcha|are you a (human|robot)|verify (that )?you('| a)re (a )?human|i'?m not a robot|enter the characters you see|press (and|&) hold|unusual traffic|bot check)\b/i;
const CODE =
  /\b((verification|security|one[- ]time|sign[- ]in|login) code|two[- ]step|2[- ]step|two[- ]factor|2fa|we (just )?(sent|texted|emailed) (you )?a code|enter the code)\b/i;
const LOGIN_PATH = /\/(ap\/signin|ap\/mfa|login|log-in|signin|sign-in|sign_in|identity|auth)(\/|$|\?)/i;
const LOGIN_TITLE =
  /^(sign in|log in|sign in or create (an )?account|welcome back|continue with (email|phone)|sign in to continue)\b/i;
const NEW_CARD =
  /\b(add (a )?(new )?(credit|debit|payment) ?(card|method)|enter (your )?card|card number|re-?enter (your )?(card|cvv|security code)|verify your card|confirm (your )?(card|cvv))\b/i;

/**
 * A page the pack must not go on with: a sign-in, a card or security-code field, a verification code, a robot
 * check. The pack never types any of those; it stops and asks for a helper.
 */
export function blockerOf(snap: PageSnapshot): Blocker | null {
  const text = snap.text;
  if (CAPTCHA.test(text))
    return {
      kind: "captcha",
      message: `${snap.title ? "The site" : "This page"} wants to check that a person is there (a robot check). I can't do that part.`,
    };
  // Only a field that takes typing can ask for a secret (a bridge may flag a "One-time purchase" choice too).
  const secure = snap.nodes.filter(
    (n) => n.secure && /^(textbox|searchbox|spinbutton|combobox)$/.test(n.role),
  );
  const secureText = secure.map((n) => `${n.name} ${n.autocomplete ?? ""}`).join(" ");
  if (secure.length && /\b(cc-|card|cvv|cvc|csc|security code|expir)/i.test(secureText))
    return {
      kind: "card",
      message: "The site is asking for card details. I never type card numbers or codes.",
    };
  if (secure.length && /\b(one-time|otp|code|verification)/i.test(secureText))
    return { kind: "code", message: "The site is asking for a verification code. I never type codes." };
  if (secure.length || LOGIN_PATH.test(pathOf(snap.url) ?? "") || hasLoginTitle(snap))
    return { kind: "login", message: "The site wants you to sign in. I never type passwords." };
  if (CODE.test(text) && snap.nodes.some((n) => /^(textbox|spinbutton)$/.test(n.role)))
    return { kind: "code", message: "The site is asking for a verification code. I never type codes." };
  return null;
}

function hasLoginTitle(snap: PageSnapshot): boolean {
  if (LOGIN_TITLE.test(snap.title.trim())) return true;
  return snap.nodes.some((n) => n.role === "heading" && LOGIN_TITLE.test(n.name.trim()));
}

/** A payment form in front of the order (add a card, confirm the security code) means stop. */
export function asksForNewCard(snap: PageSnapshot): boolean {
  return (
    snap.nodes.some((n) => n.role === "heading" && NEW_CARD.test(n.name)) ||
    snap.nodes.some((n) => /^(textbox|spinbutton)$/.test(n.role) && NEW_CARD.test(n.name))
  );
}

// --- Subscriptions and upsells -----------------------------------------------------------------------

/** Memberships, trials and repeat deliveries: the pack never signs anyone up for these. */
export const SUBSCRIPTION =
  /\b(subscribe|subscription|subscribe (&|and) save|auto-?ship|auto-?renew|auto-?deliver|recurring|membership|dashpass|uber one|(amazon |try |join )prime|prime (membership|member|trial|free|day)|instacart\+|instacart plus|free trial|start (your )?trial|try .{0,20} free|join .{0,20}(plus|pass|club)|plus member)/i;

const DECLINE =
  /^(no,? thanks?|no thank you|not now|skip( for now)?|maybe later|decline|continue without|i don'?t want|no,? (continue|keep shopping)|close|dismiss)\b/i;

const TOGGLE = /^(checkbox|switch|radio|menuitemcheckbox|menuitemradio)$/;

/** A subscription or membership that is switched on in front of the order, by name. */
export function subscriptionChosen(snap: PageSnapshot): PageNode | undefined {
  return snap.nodes.find((n) => TOGGLE.test(n.role) && n.checked === true && SUBSCRIPTION.test(n.name));
}

/** An upsell in the way (a membership, a trial, a protection plan) and the button that says no to it. */
export function upsellDecline(snap: PageSnapshot): PageNode | undefined {
  const upsell =
    SUBSCRIPTION.test(snap.text) ||
    /\b(protection plan|warranty|add coverage|you might also like)\b/i.test(snap.text);
  if (!upsell) return undefined;
  return snap.nodes.find(
    (n) => /^(button|link|clickable)$/.test(n.role) && !n.disabled && DECLINE.test(n.name.trim()),
  );
}

// --- Clicks the pack never makes --------------------------------------------------------------------

const NEVER =
  /\b(sign ?(in|up|out)|log ?(in|out)|register|create (an )?account|account|settings|profile|password|(edit|change|add|update|new|manage) (delivery |shipping )?address|(edit|change|add|update|new|manage) (payment|card|wallet)|payment method|add (a )?card|gift card|redeem|apply (a )?promo|upgrade|join|start (free )?trial|subscribe|subscription|membership|dashpass|uber one|(amazon |try |join )prime|prime (membership|member|trial|free)|instacart\+|auto-?ship)\b/i;

/** Why the pack must never click a control with this label (account, address, payment, sign-up), or null. */
export function neverClick(label: string): string | null {
  return NEVER.test(label)
    ? `"${label.slice(0, 60)}" changes an account, an address, a payment method or a membership. I never do that.`
    : null;
}

// --- Search results ---------------------------------------------------------------------------------

export interface Choice {
  ref: string;
  name: string;
  href?: string;
  priceCents: Cents | null;
  detail?: string;
}

/** Food: the restaurants in the search results (links to a store page), best match first, at most `max`. */
export function searchStores(snap: PageSnapshot, site: OrderSite, query: string, max = 4): Choice[] {
  const seen = new Map<string, Choice>();
  const nodes = snap.nodes;
  nodes.forEach((n, i) => {
    const path = pathOf(n.href);
    if (n.role !== "link" || !path || !site.storePath?.test(path) || site.itemPath?.test(path)) return;
    const key = path.replace(/\/$/, "");
    // A card link holds the restaurant's name as a heading, then its cuisine, time and fee.
    const heading = nodes
      .slice(i + 1, i + 3)
      .find((x) => x.role === "heading" && x.name && n.name.startsWith(x.name));
    const name = heading ? heading.name.slice(0, 100) : firstLine(n.name);
    const inLink = heading
      ? n.name
          .slice(heading.name.length)
          .replace(/^[\s·,-]+/, "")
          .trim()
      : "";
    if (!name || centsIn(name) === name.length) return;
    const prev = seen.get(key);
    if (prev && prev.name.length >= name.length) return;
    // A line or two after the link usually says the cuisine, the time and the fee.
    const detail = (
      inLink ||
      nodes
        .slice(i + 1, i + 4)
        .filter((x) => x.role === "text")
        .map((x) => x.name)
        .join(" · ")
    ).slice(0, 120);
    seen.set(key, { ref: n.ref, name, href: n.href!, priceCents: null, ...(detail ? { detail } : {}) });
  });
  return [...seen.values()]
    .map((c, i) => ({ c, i, s: matchScore(query, `${c.name} ${c.detail ?? ""}`) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, max)
    .map((x) => x.c);
}

/** Shopping: the products in the search results with their prices, best match first, at most `max`. */
export function searchProducts(snap: PageSnapshot, site: OrderSite, query: string, max = 4): Choice[] {
  const order: string[] = [];
  const found = new Map<string, Choice>();
  let current: string | null = null;
  for (const n of snap.nodes) {
    const path = n.role === "link" ? pathOf(n.href) : null;
    const m = path ? site.itemPath?.exec(path) : null;
    if (m) {
      const key = m[0];
      current = key;
      const name = firstLine(n.name);
      const prev = found.get(key);
      const useful = name && !/^\$|^\d(\.\d)? out of 5|stars?$|^(see|view|more) /i.test(name);
      if (!prev) {
        order.push(key);
        found.set(key, { ref: n.ref, name: useful ? name : "", href: n.href!, priceCents: centsIn(n.name) });
      } else if (useful && name.length > prev.name.length) {
        found.set(key, { ...prev, ref: n.ref, name, href: n.href! });
      }
      continue;
    }
    if (!current) continue;
    const c = found.get(current)!;
    if (c.priceCents === null) {
      const v = centsIn(n.name);
      if (v !== null && v > 0) c.priceCents = v;
    }
  }
  return order
    .map((k, i) => ({ c: found.get(k)!, i }))
    .filter((x) => x.c.name && x.c.priceCents !== null)
    .map((x) => ({ ...x, s: matchScore(query, x.c.name) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, max)
    .map((x) => x.c);
}

/** Food: the dishes on a restaurant's page that match what the person wants, with prices, best first. */
export function menuItems(snap: PageSnapshot, site: OrderSite, query: string, max = 4): Choice[] {
  const nodes = snap.nodes;
  const out: (Choice & { s: number; i: number })[] = [];
  nodes.forEach((n, i) => {
    if (!CLICKABLE.test(n.role) || n.disabled) return;
    const path = pathOf(n.href);
    const isItemLink = !!path && !!site.itemPath?.test(path);
    const own = centsIn(n.name);
    if (!isItemLink && own === null) return;
    const name = firstLine(n.name.replace(/^add\s+/i, "")).replace(/\s*[-–·]?\s*\$\s?[\d,.]+.*$/, "");
    if (!name || SUBSCRIPTION.test(name)) return;
    let price = own;
    for (let k = i - 1; price === null && k >= Math.max(0, i - 4); k--) {
      if (nodes[k]!.role !== "text") break;
      price = centsIn(nodes[k]!.name);
    }
    for (let k = i + 1; price === null && k <= Math.min(nodes.length - 1, i + 2); k++) {
      if (nodes[k]!.role !== "text") break;
      price = centsIn(nodes[k]!.name);
    }
    if (price === null) return;
    const s = matchScore(query, name);
    if (s === 0) return;
    out.push({ ref: n.ref, name, ...(n.href ? { href: n.href } : {}), priceCents: price, s, i });
  });
  const seen = new Set<string>();
  return out
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .filter((c) => !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase()))
    .slice(0, max)
    .map(({ ref, name, href, priceCents }) => ({ ref, name, priceCents, ...(href ? { href } : {}) }));
}

function firstLine(s: string): string {
  return s
    .split(/\n| · /)[0]!
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

// --- Item options ----------------------------------------------------------------------------------

export interface OptionGroup {
  name: string;
  required: boolean;
  choices: { ref: string; label: string; checked: boolean }[];
}

/**
 * Required choices on an item (protein, size): a group (fieldset or radiogroup) of radios with nothing chosen yet.
 * Checkbox add-ons are left alone (they cost extra); a required checkbox group asks for one.
 */
export function openChoices(snap: PageSnapshot): OptionGroup[] {
  const groups: OptionGroup[] = [];
  let cur: (OptionGroup & { depth?: number; radios: boolean }) | null = null;
  const close = () => {
    if (!cur) return;
    const anyChecked = cur.choices.some((c) => c.checked);
    const required = cur.radios || /\brequired\b|choose (1|one)|select (1|one)|pick (1|one)/i.test(cur.name);
    if (cur.choices.length && !anyChecked && required)
      groups.push({ name: cur.name, required: true, choices: cur.choices });
    cur = null;
  };
  for (const n of snap.nodes) {
    if (n.role === "group" || n.role === "radiogroup") {
      close();
      if (n.name) cur = { name: n.name, required: false, choices: [], radios: false, depth: n.depth };
      continue;
    }
    if (!cur) continue;
    const inside = cur.depth === undefined || n.depth === undefined || n.depth > cur.depth;
    if ((n.role === "radio" || n.role === "checkbox") && inside) {
      if (n.role === "radio") cur.radios = true;
      if (!n.disabled && !SUBSCRIPTION.test(n.name))
        cur.choices.push({ ref: n.ref, label: n.name, checked: n.checked === true });
      continue;
    }
    if (!inside || /^(button|combobox|listbox|textbox|link|heading)$/.test(n.role)) close();
  }
  close();
  return groups;
}

/** The "Add to cart" button of the item open now (never a "Subscribe" one). */
export function addButton(snap: PageSnapshot): PageNode | undefined {
  return snap.nodes.find(
    (n) =>
      /^(button|clickable)$/.test(n.role) &&
      !n.disabled &&
      /^(add to (cart|order|bag|basket)|add \d+ to (cart|order)|add item|add to my order)\b/i.test(
        n.name.trim(),
      ) &&
      !SUBSCRIPTION.test(n.name),
  );
}

/** Text that shows an item went into the cart. */
export const ADDED = /\b(added to (your )?(cart|order|bag|basket)|item added|in your cart|cart subtotal)\b/i;

// --- Checkout --------------------------------------------------------------------------------------

/** The button that places the order. Only this one is ever pressed as a purchase, and only with approval. */
export function placeButton(snap: PageSnapshot): PageNode | undefined {
  return snap.nodes.find(
    (n) =>
      /^(button|clickable)$/.test(n.role) &&
      !n.disabled &&
      /^(place (your )?order|place order|order now|submit order|confirm order|buy now|pay now|place (your )?order and pay)\b/i.test(
        n.name.trim(),
      ) &&
      !SUBSCRIPTION.test(n.name),
  );
}

export interface CheckoutLine {
  qty: number;
  name: string;
  cents: Cents | null;
}

export interface Checkout {
  items: CheckoutLine[];
  subtotalCents: Cents | null;
  fees: { label: string; cents: Cents }[];
  tipCents: Cents | null;
  totalCents: Cents;
  deliverTo: string;
  payWith: string;
}

export class CheckoutProblem extends Error {}

const ITEM_LINE = /^(\d{1,2})\s*[×x]\s+(.+?)(?:\s+[—–-]\s*(-?\$[\d,]+\.\d{2}))?$/;
const FEE =
  /\b(fee|fees|tax|taxes|shipping|delivery|service|bag|small order|handling|surcharge|regulatory|discount|promo|promotion|savings|credit|deposit)\b/i;
const ADDRESS_LABEL = /^(?:deliver(?:ing)? to|ship(?:ping)? to|delivery address|shipping address)\b:?\s*/i;

/**
 * The delivery address as the page shows it: a sentence like "Deliver to 12 Elm Street" first; else the chosen
 * (checked) address under a "Deliver to" heading; else the line right after that heading.
 */
function addressOf(snap: PageSnapshot, text: string[]): string | null {
  const clean = (s: string) =>
    s
      .split(/\.\s+(?:pay|payment)\b/i)[0]!
      .replace(/[.;,]\s*$/, "")
      .trim();
  for (const l of text) {
    const m = ADDRESS_LABEL.exec(l);
    if (m && l.length - m[0].length >= 4) return clean(l.slice(m[0].length));
  }
  const i = snap.nodes.findIndex((n) => ADDRESS_LABEL.test(n.name.trim()) && n.name.trim().length < 30);
  if (i < 0) return null;
  const after = snap.nodes.slice(i + 1, i + 12);
  const checked = after.find((n) => n.role === "radio" && n.checked === true);
  if (checked) return clean(checked.name);
  const next = after.find((n) => n.role === "text" && n.name.length >= 4);
  return next ? clean(next.name) : null;
}
const PAYMENT =
  /((?:visa|master ?card|amex|american express|discover|debit|credit|card|apple pay|google pay|paypal|gift card balance)[^\n]{0,40}?(?:ending(?: in)?|••+|\*{2,}|x{3,}|…)\s*\d{4}(?:\s*\([^)\n]{0,40}\))?)/i;

/** Pairs of a label and the amount next to it ("Delivery fee $2.99", or the label on one line, the amount on the next). */
export function amounts(text: string[]): { label: string; cents: Cents }[] {
  const out: { label: string; cents: Cents }[] = [];
  for (let i = 0; i < text.length; i++) {
    const line = text[i]!;
    if (ITEM_LINE.test(line)) continue;
    const m = /^(.*?)[\s:]*(-?\$\s?[\d,]+(?:\.\d{2})?)$/.exec(line);
    if (!m) continue;
    let label = m[1]!.trim();
    if (!label && i > 0 && centsIn(text[i - 1]!) === null) label = text[i - 1]!;
    if (!label) continue;
    out.push({ label: label.slice(0, 60), cents: centsIn(m[2]!)! });
  }
  return out;
}

/**
 * Everything the person must see before an order is placed, read from the checkout page as it is now. Throws a
 * CheckoutProblem when something needed isn't there or can't be read clearly; the pack then stops.
 */
export function readCheckout(snap: PageSnapshot, wanted: { item: string }): Checkout {
  const text = lines(snap);
  const pairs = amounts(text);
  const total = pageTotal(snap.text);
  if (total === null) throw new CheckoutProblem("I can't read the order total on the checkout page.");
  const totalCents = Math.round(total * 100);
  const labelledTotal = pairs.find((p) =>
    /^(order total|total|grand total|estimated total|total \(.{1,30}\)|you pay)$/i.test(p.label),
  );
  if (labelledTotal && labelledTotal.cents !== totalCents)
    throw new CheckoutProblem(
      "The checkout page shows more than one total, so I can't tell which one you'd pay.",
    );

  const items: CheckoutLine[] = [];
  for (const l of text) {
    const m = ITEM_LINE.exec(l);
    if (m) items.push({ qty: Number(m[1]), name: m[2]!.trim(), cents: m[3] ? centsIn(m[3]) : null });
  }
  if (!items.length) {
    // Some sites show the name and a quantity list instead of "2 × Name".
    const line = text.find((l) => matchScore(wanted.item, l) >= 0.99 && l.length < 200);
    const qtyNode = snap.nodes.find(
      (n) => /^(combobox|spinbutton|listbox)$/.test(n.role) && /\b(qty|quantity)\b/i.test(n.name),
    );
    const qty = Number(
      /\d+/.exec(qtyNode?.value ?? "")?.[0] ?? /\b(?:qty|quantity):?\s*(\d+)/i.exec(snap.text)?.[1] ?? "",
    );
    if (line && qty > 0) items.push({ qty, name: line.slice(0, 120), cents: null });
  }
  if (!items.length)
    throw new CheckoutProblem("I can't see the items and how many of each on the checkout page.");
  if (!items.some((i) => matchScore(wanted.item, i.name) >= 0.99))
    throw new CheckoutProblem(`I can't find ${wanted.item} in the order on the checkout page.`);

  const subtotal = pairs.find((p) =>
    /^(subtotal|items?( \(\d+\))?|item subtotal|items total)$/i.test(p.label),
  );
  const tip = pairs.find((p) => /\btip\b/i.test(p.label));
  const fees = pairs.filter(
    (p) =>
      p !== subtotal && p !== tip && p !== labelledTotal && FEE.test(p.label) && !/\btotal\b/i.test(p.label),
  );

  const address = addressOf(snap, text);
  if (!address) throw new CheckoutProblem("I can't see the delivery address on the checkout page.");
  const pay = PAYMENT.exec(snap.text)?.[1]?.trim();
  if (!pay)
    throw new CheckoutProblem(
      "I can't see a saved card on the checkout page. I never type card numbers; a helper can add one on the site.",
    );
  return {
    items,
    subtotalCents: subtotal?.cents ?? null,
    fees: fees.map((f) => ({ label: f.label, cents: f.cents })),
    tipCents: tip?.cents ?? null,
    totalCents,
    deliverTo: address.slice(0, 140),
    payWith: pay.slice(0, 80),
  };
}

/** Tip choices on the checkout page (radios or buttons in a group about the tip). */
export function tipChoices(snap: PageSnapshot): { ref: string; label: string; checked: boolean }[] {
  const out: { ref: string; label: string; checked: boolean }[] = [];
  let inTip = false;
  for (const n of snap.nodes) {
    if (n.role === "group" || n.role === "radiogroup" || n.role === "heading")
      inTip = /\btip\b/i.test(n.name);
    if (!inTip) continue;
    if (
      (n.role === "radio" || n.role === "button") &&
      /^(no tip|\d{1,2}%|\$\d+(\.\d{2})?)$/i.test(n.name.trim())
    )
      out.push({ ref: n.ref, label: n.name.trim(), checked: n.checked === true });
  }
  return out;
}

// --- After pressing Place order ----------------------------------------------------------------------

export const TOTAL_CHANGED =
  /\b((your )?total (has )?changed|price (has )?changed|prices? (have|has) (been )?updated|review your order again|items? in your (cart|order) (have|has) changed)\b/i;
const PLACED =
  /\b(order (is |was |has been )?(placed|confirmed|received)|thank(s| you)[^\n]{0,40}\border\b|order number|order #|your order is on (its|the) way)\b/i;
const ORDER_NO = /\border\s*(?:number|no\.?|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,30})\b/gi;
const CLOCK = String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm)`;
const DAY = String.raw`(?:today|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day(?:,?\s+[a-z]+\.? \d{1,2})?)`;
const ETA = new RegExp(
  String.raw`\b(?:arriv\w*|deliver\w*|estimated|eta|expected)\b[^\n]{0,40}?(?:` +
    String.raw`${DAY}(?:,?\s+(?:by|before|after|at|between)\s+${CLOCK}(?:\s*(?:–|-|to|and)\s*${CLOCK})?)?` +
    String.raw`|${CLOCK}(?:\s*(?:–|-|to)\s*${CLOCK})?` +
    String.raw`|\d+\s*(?:–|-|to)\s*\d+\s*min\w*|in (?:about )?\d+\s*min\w*)`,
  "i",
);

export type AfterPlace =
  | { kind: "placed"; orderNumber: string | null; eta: string | null; evidence: string }
  | { kind: "changed"; evidence: string }
  | { kind: "unknown" };

/**
 * What the page says after Place order. "Placed" needs confirmation text that was not on the checkout page before
 * the click, so a checkout page that happens to mention "order number" can't fake it.
 */
export function afterPlace(snap: PageSnapshot, before: string | null): AfterPlace {
  const fresh = lines(snap).filter((l) => !before || !before.includes(l));
  const freshText = fresh.join("\n");
  const changed = fresh.find((l) => TOTAL_CHANGED.test(l));
  if (changed) return { kind: "changed", evidence: changed.slice(0, 160) };
  const placed = fresh.find((l) => PLACED.test(l));
  if (!placed) return { kind: "unknown" };
  let orderNumber: string | null = null;
  for (const m of freshText.matchAll(ORDER_NO)) {
    if (/\d/.test(m[1]!)) {
      orderNumber = m[1]!;
      break;
    }
  }
  const eta = ETA.exec(freshText)?.[0]?.replace(/\s+/g, " ").trim().slice(0, 80) ?? null;
  return { kind: "placed", orderNumber, eta, evidence: placed.slice(0, 160) };
}
