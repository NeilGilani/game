/**
 * Acting on the page by element reference: describe (for approvals), click, type, select, scroll, wait,
 * extract. Every action highlights its element first so the person can see what is happening.
 */

import { classifyAction, containsCardNumber } from "../../policy.ts";
import type { BridgeError, TableData, WaitCondition } from "../../protocol.ts";
import { elementFor, isSecure, isVisible, nameOf, roleOf, looksClickable, valueOf, visibleText, buildTree } from "./dom.ts";
import { highlight, hideHighlight } from "./ui.ts";

export class PageError extends Error {
  constructor(
    readonly code: BridgeError["code"],
    message: string,
  ) {
    super(message);
  }
}

/** How long the highlight shows before acting, so the person sees it. */
export const SHOW_MS = 350;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function need(ref: string): Element {
  const el = elementFor(ref);
  if (!el) throw new PageError("no-element", `Element ${ref} is no longer on the page. Read the page again.`);
  return el;
}

function roleName(el: Element): { role: string; name: string } {
  const role = roleOf(el) ?? (looksClickable(el) ? "clickable" : "generic");
  return { role, name: nameOf(el) };
}

// ---------- Describing actions for approval ----------

export interface ActionMaterial {
  action: "click" | "submit";
  ref: string;
  origin: string;
  path: string;
  role: string;
  name: string;
  submitsForm: boolean;
  formMethod: string | null;
  fields: Array<[string, string]>;
  amounts: string[];
  /** Visible text of the form (or main region) the action belongs to: what the person is agreeing to. */
  context: string;
  consequential: ReturnType<typeof classifyAction>;
}

function formOf(el: Element): HTMLFormElement | null {
  return (el as HTMLButtonElement).form ?? el.closest("form");
}

function submitsForm(el: Element, action: "click" | "submit"): boolean {
  if (action === "submit") return !!formOf(el);
  const tag = el.tagName;
  if (tag === "BUTTON") return ((el as HTMLButtonElement).type || "submit") === "submit" && !!formOf(el);
  if (tag === "INPUT") return ["submit", "image"].includes((el as HTMLInputElement).type) && !!formOf(el);
  return false;
}

function fieldLabel(el: Element): string {
  return nameOf(el) || el.getAttribute("name") || el.id || el.tagName.toLowerCase();
}

function formFields(form: HTMLFormElement): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const el of Array.from(form.elements)) {
    const i = el as HTMLInputElement;
    if (!i.name && !nameOf(el)) continue;
    if (["submit", "button", "reset", "image", "file"].includes(i.type)) continue;
    if (isSecure(el)) {
      out.push([fieldLabel(el), "(hidden: secret field)"]);
      continue;
    }
    if (i.type === "checkbox" || i.type === "radio") {
      if (i.checked) out.push([fieldLabel(el), i.type === "radio" ? i.value || "selected" : "checked"]);
      continue;
    }
    if (i.type === "hidden") {
      out.push([`${i.name} (hidden)`, i.value.slice(0, 200)]);
      continue;
    }
    const v = valueOf(el);
    if (v !== undefined) out.push([fieldLabel(el), v.slice(0, 300)]);
  }
  return out.slice(0, 40);
}

const MONEY = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP))/;

export function describeMaterial(ref: string, action: "click" | "submit"): ActionMaterial {
  const el = need(ref);
  const { role, name } = roleName(el);
  const form = formOf(el);
  const sub = submitsForm(el, action);
  const container = form ?? el.closest("main, [role=main], dialog, [role=dialog], section, article") ?? document.body;
  const context = visibleText(container, 4000).text;
  const amounts = context
    .split("\n")
    .filter((l) => MONEY.test(l))
    .map((l) => l.slice(0, 120))
    .slice(0, 20);
  return {
    action,
    ref,
    origin: location.origin,
    path: location.pathname + location.search,
    role,
    name,
    submitsForm: sub,
    formMethod: form?.method ?? null,
    fields: form ? formFields(form) : [],
    amounts,
    context,
    consequential: classifyAction({ role, name, submitsForm: sub, formMethod: form?.method ?? null }),
  };
}

/** The canonical string an approval binds to (hashed by the service worker). */
export function materialKey(m: ActionMaterial): string {
  return JSON.stringify([m.action, m.origin, m.path, m.role, m.name, m.submitsForm, m.fields, m.context]);
}

function checkApproval(ref: string, action: "click" | "submit", expectKey: string | undefined): void {
  const m = describeMaterial(ref, action);
  if (!m.consequential) return;
  if (expectKey === undefined)
    throw new PageError("approval-required", `“${m.name}” is a ${m.consequential} action and needs the person's approval.`);
  if (expectKey !== materialKey(m))
    throw new PageError("approval-mismatch", "The page changed since the person approved. Describe the action again and ask again.");
}

// ---------- Actions ----------

function actionable(el: Element): void {
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true")
    throw new PageError("bad-request", `“${nameOf(el)}” is disabled right now.`);
}

async function show(el: Element, verb: string): Promise<void> {
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const label = nameOf(el) || roleOf(el) || "this";
  highlight(el, `AGENCY: ${verb} “${label}”`);
  await sleep(SHOW_MS);
}

function fire(el: Element, type: string, init: MouseEventInit = {}): void {
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, ...init };
  const ev = type.startsWith("pointer") ? new PointerEvent(type, { ...opts, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, opts);
  el.dispatchEvent(ev);
}

export async function click(ref: string, expectKey: string | undefined, stoppedCheck: () => boolean): Promise<void> {
  const el = need(ref);
  actionable(el);
  checkApproval(ref, "click", expectKey);
  await show(el, "pressing");
  if (stoppedCheck()) throw new PageError("stopped", "The person pressed Stop.");
  // Re-check after the pause: the page may have changed while the highlight showed.
  checkApproval(ref, "click", expectKey);
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  fire(el, "pointerdown");
  fire(el, "mousedown");
  fire(el, "pointerup");
  fire(el, "mouseup");
  if (el instanceof HTMLElement) el.click();
  else fire(el, "click");
  hideHighlight();
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

export async function type(
  ref: string,
  text: string,
  clear: boolean,
  pressEnter: boolean,
  expectKey: string | undefined,
  stoppedCheck: () => boolean,
): Promise<string> {
  const el = need(ref);
  if (isSecure(el)) throw new PageError("secure-field", "This is a password, code or card field. AGENCY never types into those; the person or a helper must.");
  if (containsCardNumber(text)) throw new PageError("secret-in-text", "That text contains what looks like a card number. AGENCY never types card numbers.");
  actionable(el);
  // Enter in a form submits it: that approval binds to the form *after* typing, so it is checked below
  // (type first without Enter, describe the submit, get approval, then press Enter with empty text).
  await show(el, "typing in");
  if (stoppedCheck()) throw new PageError("stopped", "The person pressed Stop.");
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.readOnly) throw new PageError("bad-request", "This field is read-only.");
    setNativeValue(el, (clear ? "" : el.value) + text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    if (clear) document.execCommand("selectAll");
    document.execCommand("insertText", false, text);
  } else {
    throw new PageError("bad-request", "That element isn't a text field.");
  }
  if (pressEnter) {
    if (formOf(el)) checkApproval(ref, "submit", expectKey);
    const down = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    const proceed = el.dispatchEvent(down);
    el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    const form = formOf(el);
    if (proceed && form && el instanceof HTMLInputElement) form.requestSubmit();
  }
  hideHighlight();
  return valueOf(el) ?? "";
}

export async function select(ref: string, option: string, stoppedCheck: () => boolean): Promise<string> {
  const el = need(ref);
  if (!(el instanceof HTMLSelectElement)) throw new PageError("bad-request", "That element isn't a list to choose from. Click its options instead.");
  actionable(el);
  const want = option.trim().toLowerCase();
  const opts = Array.from(el.options);
  const match =
    opts.find((o) => o.value.toLowerCase() === want || (o.label || o.text).trim().toLowerCase() === want) ??
    opts.find((o) => (o.label || o.text).toLowerCase().includes(want));
  if (!match) throw new PageError("no-element", `No option “${option}”. Options: ${opts.map((o) => o.label || o.text).join(", ")}`);
  if (match.disabled) throw new PageError("bad-request", `“${match.label}” can't be chosen right now.`);
  await show(el, "choosing in");
  if (stoppedCheck()) throw new PageError("stopped", "The person pressed Stop.");
  el.focus({ preventScroll: true });
  el.value = match.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  hideHighlight();
  return match.label || match.text;
}

export function scrollState(): { y: number; maxY: number } {
  const se = document.scrollingElement ?? document.documentElement;
  return { y: Math.round(se.scrollTop), maxY: Math.max(0, Math.round(se.scrollHeight - innerHeight)) };
}

export async function scroll(ref: string | undefined, direction: "up" | "down" | undefined, pages: number): Promise<{ y: number; maxY: number }> {
  if (ref) {
    need(ref).scrollIntoView({ block: "center", behavior: "instant" });
  } else {
    const dy = Math.round(innerHeight * 0.85) * Math.max(1, Math.min(10, pages)) * (direction === "up" ? -1 : 1);
    window.scrollBy({ top: dy, behavior: "instant" });
  }
  await sleep(50);
  return scrollState();
}

function findElement(c: Extract<WaitCondition, { kind: "element" }>): string | undefined {
  const tree = buildTree(2000);
  const want = c.name?.trim().toLowerCase();
  const part = c.nameContains?.trim().toLowerCase();
  const hit = tree.nodes.find(
    (n) =>
      (!c.role || n.role === c.role) &&
      (!want || n.name.toLowerCase() === want) &&
      (!part || n.name.toLowerCase().includes(part)),
  );
  return hit?.ref;
}

export async function waitFor(c: WaitCondition, timeoutMs: number, cancelled: () => boolean): Promise<{ met: boolean; ref?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (c.kind === "element") {
      const ref = findElement(c);
      if (ref) return { met: true, ref };
    } else if (c.kind === "text") {
      if (visibleText(document.body, 200_000).text.toLowerCase().includes(c.text.toLowerCase())) return { met: true };
    } else if (c.kind === "gone") {
      const el = elementFor(c.ref);
      if (!el || !isVisible(el)) return { met: true };
    } else if (c.kind === "load") {
      if (document.readyState === "complete") return { met: true };
    }
    if (cancelled()) throw new PageError("stopped", "Stopped while waiting.");
    if (Date.now() >= deadline) return { met: false };
    await sleep(120);
  }
}

export function extractText(ref: string | undefined, maxChars: number): { text: string; truncated: boolean } {
  const root = ref ? need(ref) : document.body;
  return visibleText(root, maxChars);
}

export function extractTables(): TableData[] {
  const out: TableData[] = [];
  for (const t of Array.from(document.querySelectorAll("table"))) {
    if (!isVisible(t)) continue;
    const cell = (c: Element) => visibleText(c, 500).text.replace(/\n/g, " ");
    const rows = Array.from(t.rows).filter((r) => isVisible(r));
    let headers: string[] = [];
    const head = t.tHead?.rows[0] ?? (rows[0] && Array.from(rows[0].cells).every((c) => c.tagName === "TH") ? rows[0] : undefined);
    if (head) headers = Array.from(head.cells, cell);
    const body = rows.filter((r) => r !== head).map((r) => Array.from(r.cells, cell));
    out.push({ caption: t.caption ? cell(t.caption) : nameOf(t), headers, rows: body.slice(0, 500) });
    if (out.length >= 20) break;
  }
  return out;
}
