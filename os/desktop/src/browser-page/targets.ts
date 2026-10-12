/**
 * What the person can choose on the page, and the text boxes the eye keyboard types into. Reuses the AGENCY
 * Bridge's page reader (roles, accessible names, what is really visible and not covered), so the eyes and the
 * assistant see the page the same way.
 */

import type { PageField, PageTarget, PageTargetKind } from "@agency/contracts";
import { classifyAction } from "../../../browser-bridge/src/policy.ts";
import {
  elementFor,
  interactiveInView,
  isSecure,
  isVisible,
  nameOf,
  refFor,
  roleOf,
} from "../../../browser-bridge/src/extension/page/dom.ts";

const MAX_TARGETS = 300;

export function kindOf(role: string, el: Element): PageTargetKind {
  if (el.tagName === "SELECT" || role === "combobox" || role === "listbox") return "list";
  if (role === "textbox" || role === "searchbox" || role === "spinbutton") return "field";
  if (role === "checkbox" || role === "radio" || role === "switch" || role === "option") return "choice";
  if (role === "link") return "link";
  if (role === "button" || role === "menuitem" || role === "tab" || role === "clickable") return "button";
  return "other";
}

/** Interactive things on screen now, in viewport CSS pixels, not covered by anything else. */
export function pageTargets(): { targets: PageTarget[]; truncated: boolean } {
  const items = interactiveInView(MAX_TARGETS + 1);
  const targets = items.slice(0, MAX_TARGETS).flatMap(({ el, role, name, rect }) => {
    if (rect.width < 3 || rect.height < 3) return [];
    const t: PageTarget = { ref: refFor(el), role, name: name.slice(0, 120), rect, kind: kindOf(role, el) };
    if (isSecure(el)) t.secure = true;
    return [t];
  });
  return { targets, truncated: items.length > MAX_TARGETS };
}

// ---------- Text boxes ----------

const TEXT_TYPES = new Set(["", "text", "search", "email", "tel", "url", "number", "password"]);

export type Typable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

/** A box AGENCY's keyboard can type into: text-like inputs, text areas and editable regions. */
export function typable(el: Element | null): el is Typable {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type) && !el.disabled;
  return el instanceof HTMLElement && el.isContentEditable;
}

function formOf(el: Element): HTMLFormElement | null {
  return (el as HTMLInputElement).form ?? el.closest("form");
}

/** The text boxes in the same form (or the page), in order, that a person can see. */
function siblingsOf(el: Element): Typable[] {
  const scope: ParentNode = formOf(el) ?? document;
  return [
    ...scope.querySelectorAll("input, textarea, [contenteditable='true'], [contenteditable='']"),
  ].filter(
    (f): f is Typable =>
      typable(f) && isVisible(f) && !(f as HTMLInputElement).readOnly && f.getClientRects().length > 0,
  );
}

function submitButton(form: HTMLFormElement): HTMLElement | null {
  return (
    form.querySelector<HTMLElement>("button[type=submit], input[type=submit], input[type=image]") ??
    form.querySelector<HTMLElement>("button:not([type=button]):not([type=reset])")
  );
}

function fieldType(el: Typable): PageField["type"] {
  if (el instanceof HTMLTextAreaElement || !(el instanceof HTMLInputElement)) return "multiline";
  const t = el.type.toLowerCase();
  if (t === "password") return "password";
  if (t === "email" || t === "tel" || t === "url" || t === "number" || t === "search") return t;
  if (t === "" || t === "text") return el.getAttribute("role") === "searchbox" ? "search" : "text";
  return "other";
}

function valueOfField(el: Typable): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return (el.innerText ?? "").replace(/\n$/, "");
}

export function fieldInfo(el: Typable): PageField {
  const secure = isSecure(el) || (el instanceof HTMLInputElement && el.type === "password");
  const all = siblingsOf(el);
  const i = all.indexOf(el);
  const form = formOf(el);
  let submitLabel: string | null = null;
  if (form) {
    const b = submitButton(form);
    submitLabel = (b && nameOf(b)) || "Submit";
  } else if (fieldType(el) === "search" || /search/i.test(nameOf(el))) submitLabel = "Search";
  else if (el instanceof HTMLInputElement) submitLabel = "Enter";
  const max = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.maxLength : -1;
  return {
    ref: refFor(el),
    label: (nameOf(el) || el.getAttribute("name") || "Text box").slice(0, 120),
    value: secure ? "" : valueOfField(el).slice(0, 5000),
    type: secure ? "password" : fieldType(el),
    secure,
    hasPrevious: i > 0,
    hasNext: i >= 0 && i < all.length - 1,
    submitLabel,
    maxLength: max > 0 ? max : null,
  };
}

/** Focus a box for typing (scrolled to the middle of the view). */
export function focusField(el: Typable): PageField {
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  el.focus({ preventScroll: true });
  return fieldInfo(el);
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/**
 * Put the person's words in the box, the way typing would: the page's own scripts (React and the like) see an
 * input event. Never for secure fields.
 */
export function setFieldValue(el: Typable, value: string): PageField {
  if (isSecure(el) || (el instanceof HTMLInputElement && el.type === "password"))
    throw new Error("AGENCY never types into password, code or card boxes.");
  if (document.activeElement !== el) el.focus({ preventScroll: true });
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const v = el.maxLength > 0 ? value.slice(0, el.maxLength) : value;
    setNativeValue(el, v);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    const sel = window.getSelection();
    sel?.selectAllChildren(el);
    document.execCommand("insertText", false, value);
  }
  return fieldInfo(el);
}

export function moveField(el: Typable, step: 1 | -1): Typable | null {
  const all = siblingsOf(el);
  const i = all.indexOf(el);
  return i < 0 ? null : (all[i + step] ?? null);
}

/** What submitting this box would press, for the "are you sure?" check. */
export function submitKind(el: Typable): ReturnType<typeof classifyAction> {
  const form = formOf(el);
  if (!form) return null;
  const b = submitButton(form);
  return classifyAction({
    role: "button",
    name: (b && nameOf(b)) || "Submit",
    submitsForm: true,
    formMethod: form.method,
  });
}

/** Submit the box's form (with its own submit button), or press Enter in a lone box. */
export function submitField(el: Typable): void {
  const form = formOf(el);
  if (form) {
    const b = submitButton(form);
    if (b && (b instanceof HTMLButtonElement || b instanceof HTMLInputElement)) form.requestSubmit(b);
    else form.requestSubmit();
    return;
  }
  const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keypress", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
}

// ---------- Choosing a target ----------

export type Inspection =
  | { kind: "gone" }
  | { kind: "field"; field: PageField }
  | { kind: "list"; label: string; options: string[]; selected: string | null }
  | {
      kind: "click";
      name: string;
      role: string;
      consequential: ReturnType<typeof classifyAction>;
      /** Where to click, in viewport CSS pixels, and whether that point really is the element. */
      x: number;
      y: number;
      hit: boolean;
    };

function submitsForm(el: Element): boolean {
  const form = formOf(el);
  if (!form) return false;
  if (el instanceof HTMLButtonElement) return (el.type || "submit") === "submit";
  if (el instanceof HTMLInputElement) return el.type === "submit" || el.type === "image";
  return false;
}

/** What choosing this element means: type into it, pick from a list, or click it (and where). */
export function inspect(ref: string): Inspection {
  const el = elementFor(ref);
  if (!el || !isVisible(el)) return { kind: "gone" };
  if (typable(el)) return { kind: "field", field: focusField(el) };
  if (el instanceof HTMLSelectElement) {
    const opts = [...el.options].filter((o) => !o.disabled && !o.hidden);
    return {
      kind: "list",
      label: nameOf(el) || "Choose one",
      options: opts.map((o) => (o.label || o.text).trim().slice(0, 100)).slice(0, 60),
      selected: el.selectedOptions[0]
        ? (el.selectedOptions[0].label || el.selectedOptions[0].text).trim()
        : null,
    };
  }
  const r0 = el.getBoundingClientRect();
  if (r0.top < 0 || r0.bottom > innerHeight || r0.left < 0 || r0.right > innerWidth)
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const x = Math.min(innerWidth - 2, Math.max(1, r.left + Math.min(r.width / 2, Math.max(4, r.width - 4))));
  const y = Math.min(innerHeight - 2, Math.max(1, r.top + r.height / 2));
  const top = document.elementFromPoint(x, y);
  const role = roleOf(el) ?? "clickable";
  const name = nameOf(el);
  return {
    kind: "click",
    name,
    role,
    consequential: classifyAction({
      role,
      name,
      submitsForm: submitsForm(el),
      formMethod: formOf(el)?.method,
    }),
    x,
    y,
    hit: !!top && (top === el || el.contains(top)),
  };
}

let awaited: { el: Element; landed: boolean } | null = null;

/** Main is about to send a real click at the element: note whether it lands there. */
export function expectClick(ref: string): boolean {
  const el = elementFor(ref);
  if (!el) return false;
  awaited = { el, landed: false };
  return true;
}

addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted || !awaited) return;
    const t = e.target as Node | null;
    if (t && (t === awaited.el || awaited.el.contains(t))) awaited.landed = true;
  },
  true,
);

/** After the real click: if it didn't reach the element (something moved), click the element itself. */
export async function settleClick(): Promise<"trusted" | "fallback" | "none"> {
  const a = awaited;
  if (!a) return "none";
  for (let i = 0; i < 6 && !a.landed; i++) await new Promise((r) => setTimeout(r, 50));
  awaited = null;
  if (a.landed) return "trusted";
  if (!a.el.isConnected) return "none";
  if (a.el instanceof HTMLElement) a.el.click();
  else a.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "fallback";
}

/** Choose an option of a list (select) by its label. */
export function chooseOption(ref: string, option: string): boolean {
  const el = elementFor(ref);
  if (!(el instanceof HTMLSelectElement)) return false;
  const want = option.trim().toLowerCase();
  const match = [...el.options].find((o) => (o.label || o.text).trim().toLowerCase() === want && !o.disabled);
  if (!match) return false;
  el.value = match.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

// ---------- The person clicked into a box on the page ----------

let lastTrustedPointer = 0;
addEventListener(
  "pointerdown",
  (e) => {
    if (e.isTrusted) lastTrustedPointer = Date.now();
  },
  true,
);

/** Calls `onField` when a person (not a script) puts the cursor in a text box. */
export function watchFieldFocus(onField: (field: PageField) => void): void {
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target as Element | null;
      if (!typable(el) || Date.now() - lastTrustedPointer > 1500) return;
      onField(fieldInfo(el));
    },
    true,
  );
}
