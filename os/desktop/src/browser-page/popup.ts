/**
 * Finds what is covering the page (a cookie banner, a sign-up pop-up, a dialog) and its own buttons, so the person
 * can answer it with big choices, or hide it. AGENCY never answers a pop-up on its own.
 */

import type { PopupInfo } from "@agency/contracts";
import {
  INTERACTIVE_ROLES,
  isVisible,
  nameOf,
  refFor,
  roleOf,
  visibleText,
} from "../../../browser-bridge/src/extension/page/dom.ts";
import { orderChoices, popupKind } from "./popupRules";

let found: Element | null = null;
let hidden: { el: HTMLElement; display: string; priority: string }[] = [];

function area(r: DOMRect): number {
  const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  return w * h;
}

function onTop(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
  const y = Math.min(innerHeight - 1, Math.max(0, r.top + Math.min(r.height / 2, 40)));
  const top = document.elementFromPoint(x, y);
  return !!top && (top === el || el.contains(top));
}

/** The pop-up most in the way: an open dialog, else the biggest fixed box on top. */
function findPopup(): { el: Element; dialog: boolean } | null {
  const dialogs = [
    ...document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]"),
  ].filter((d) => isVisible(d) && area(d.getBoundingClientRect()) > 2000);
  const topDialog = dialogs.filter(onTop).pop() ?? dialogs.pop();
  if (topDialog) return { el: topDialog, dialog: true };

  const view = innerWidth * innerHeight;
  let best: { el: Element; score: number } | null = null;
  const all = document.body?.getElementsByTagName("*") ?? [];
  for (let i = 0; i < all.length && i < 5000; i++) {
    const el = all[i]!;
    const pos = getComputedStyle(el).position;
    if (pos !== "fixed" && pos !== "sticky") continue;
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    const a = area(r);
    // A banner along an edge, or a box over a good part of the page; not a slim header or a small widget.
    const banner = r.width > innerWidth * 0.6 && r.height > 60 && (r.top < 10 || r.bottom > innerHeight - 10);
    if (a < view * 0.12 && !banner) continue;
    if (pos === "sticky" && !banner) continue;
    if (!el.querySelector("button, a[href], [role=button], input[type=submit], input[type=button]")) continue;
    if (!onTop(el)) continue;
    const score = a + (banner ? view * 0.2 : 0);
    if (!best || score > best.score) best = { el, score };
  }
  return best ? { el: best.el, dialog: false } : null;
}

export function popupInfo(): PopupInfo | null {
  const p = findPopup();
  found = p?.el ?? null;
  if (!p) return null;
  const buttons = [...p.el.querySelectorAll("*")]
    .filter((el) => {
      const role = roleOf(el);
      return !!role && INTERACTIVE_ROLES.has(role) && role !== "textbox" && isVisible(el);
    })
    .slice(0, 40)
    .map((el) => ({ ref: refFor(el), name: nameOf(el) }));
  // What it says, without its buttons' words (they are shown as the choices).
  let text = visibleText(p.el, 1200).text;
  for (const b of buttons) if (b.name) text = text.split(b.name).join(" ");
  text = text.replace(/\s+/g, " ").trim().slice(0, 300);
  return { kind: popupKind(text, p.dialog), text, choices: orderChoices(buttons) };
}

/** Hide the pop-up (and a dimmed backdrop behind it), and let the page scroll again. */
export function hidePopup(): boolean {
  const el = found && found.isConnected ? found : findPopup()?.el;
  if (!(el instanceof HTMLElement)) return false;
  const hide = (h: HTMLElement) => {
    hidden.push({
      el: h,
      display: h.style.getPropertyValue("display"),
      priority: h.style.getPropertyPriority("display"),
    });
    h.style.setProperty("display", "none", "important");
  };
  hide(el);
  // A full-page backdrop with nothing to read, right behind it.
  for (const sib of [...(el.parentElement?.children ?? [])]) {
    if (!(sib instanceof HTMLElement) || sib === el) continue;
    const cs = getComputedStyle(sib);
    const r = sib.getBoundingClientRect();
    if (cs.position === "fixed" && area(r) > innerWidth * innerHeight * 0.8 && !visibleText(sib, 20).text)
      hide(sib);
  }
  for (const root of [document.documentElement, document.body]) {
    if (root && getComputedStyle(root).overflow === "hidden") root.style.setProperty("overflow", "auto", "important");
  }
  found = null;
  return true;
}

/** New page: forget what was hidden on the old one. */
export function resetPopups(): void {
  hidden = [];
  found = null;
}
