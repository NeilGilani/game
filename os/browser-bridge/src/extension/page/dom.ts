/**
 * Reading the page like an accessibility tree: roles, accessible names, values and states, stable element
 * references, and what is really visible (hidden text is a classic prompt-injection trick, so text the
 * person can't see is left out).
 */

import { isSecretField } from "../../policy.ts";
import type { NodeState, PageTree, TreeNode, ViewportRect } from "../../protocol.ts";

export const UI_HOST_ATTR = "data-agency-bridge-ui";

// ---------- Element references ----------

const docId = Math.random().toString(36).slice(2, 6);
let counter = 0;
const refOf = new WeakMap<Element, string>();
const byRef = new Map<string, WeakRef<Element>>();

export function refFor(el: Element): string {
  let r = refOf.get(el);
  if (!r) {
    r = `${docId}-${++counter}`;
    refOf.set(el, r);
    byRef.set(r, new WeakRef(el));
  }
  return r;
}

export function elementFor(ref: string): Element | null {
  const el = byRef.get(ref)?.deref();
  if (!el || !el.isConnected) return null;
  return el;
}

// ---------- Visibility ----------

const visCache = new WeakMap<Element, boolean>();

export function resetVisibilityCache(): void {
  // WeakMaps can't be cleared; callers make a new pass by bumping the generation.
  generation++;
}
let generation = 0;
const visGen = new WeakMap<Element, number>();

/** Visible to a sighted person: rendered, not transparent, not tiny, not off the page, not same-colour text. */
export function isVisible(el: Element): boolean {
  if (visGen.get(el) === generation) return visCache.get(el) ?? false;
  const v = computeVisible(el);
  visCache.set(el, v);
  visGen.set(el, generation);
  return v;
}

function computeVisible(el: Element): boolean {
  if (el.closest(`[${UI_HOST_ATTR}]`)) return false;
  if (el.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
  const check = (el as HTMLElement).checkVisibility;
  if (typeof check === "function" && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true }))
    return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    // display: contents and inline wrappers can be empty boxes with visible children.
    if (getComputedStyle(el).display !== "contents") return false;
  }
  const doc = el.ownerDocument;
  const pageW = Math.max(doc.documentElement.scrollWidth, innerWidth);
  if (rect.right + scrollX < 0 || rect.bottom + scrollY < 0 || rect.left + scrollX > pageW + 50) return false;
  const style = getComputedStyle(el);
  const clip = style.clipPath;
  if (clip && /inset\(\s*(50%|100%)/.test(clip)) return false;
  if (style.clip && /rect\(\s*0(px)?,?\s*0(px)?,?\s*0(px)?,?\s*0(px)?\s*\)/.test(style.clip)) return false;
  return true;
}

/** Text a person could actually read: skips tiny text and text the same colour as its background. */
export function isReadableTextIn(el: Element): boolean {
  const style = getComputedStyle(el);
  if (parseFloat(style.fontSize) < 5) return false;
  const fg = parseColor(style.color);
  if (!fg || fg[3] < 0.15) return false;
  const bg = backgroundOf(el);
  return contrast(fg, bg) >= 1.25;
}

type RGBA = [number, number, number, number];

function parseColor(c: string): RGBA | null {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m || !m[1]) return null;
  const p = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
}

function backgroundOf(el: Element): RGBA {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const c = parseColor(getComputedStyle(e).backgroundColor);
    if (c && c[3] > 0.5) return c;
  }
  return [255, 255, 255, 1];
}

function lum([r, g, b]: RGBA): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: RGBA, b: RGBA): number {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const BLOCK =
  /^(address|article|aside|blockquote|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tr|ul|br|caption|label|option|legend)$/i;
const CELL = /^(TD|TH)$/;

/** Visible, readable text under `root`, with line breaks between blocks. */
export function visibleText(root: Node, maxChars = 100_000): { text: string; truncated: boolean } {
  let out = "";
  let truncated = false;
  const walk = (node: Node): void => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (!parent || !isVisible(parent) || !isReadableTextIn(parent)) return;
      const t = (node.textContent ?? "").replace(/\s+/g, " ");
      if (t.trim()) {
        out += t;
        if (out.length > maxChars) {
          out = out.slice(0, maxChars);
          truncated = true;
        }
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "HEAD")
      return;
    if (el.hasAttribute(UI_HOST_ATTR)) return;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const block = BLOCK.test(tag);
    if (block && out && !out.endsWith("\n")) out += "\n";
    // Cells of a row stay on one line ("Total  $8.52"), separated by a tab.
    if (CELL.test(tag) && out && !out.endsWith("\n") && !out.endsWith("\t")) out += "\t";
    const kids = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
    for (const k of kids) walk(k);
    if (block && out && !out.endsWith("\n")) out += "\n";
  };
  walk(root);
  const text = out
    .split("\n")
    .map((l) =>
      l
        .split("\t")
        .map((c) => c.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("  "),
    )
    .filter(Boolean)
    .join("\n");
  return { text, truncated };
}

// ---------- Roles, names, values, states ----------

const INPUT_ROLES: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox",
  email: "textbox",
  tel: "textbox",
  url: "textbox",
  text: "textbox",
  password: "textbox",
  date: "textbox",
  "datetime-local": "textbox",
  time: "textbox",
  month: "textbox",
  week: "textbox",
  color: "button",
  file: "button",
};

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "gridcell",
  "clickable",
]);

const STRUCTURE_ROLES = new Set([
  "heading",
  "img",
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "form",
  "dialog",
  "alertdialog",
  "alert",
  "status",
  "table",
  "row",
  "list",
  "listitem",
  "region",
  "search",
  "tablist",
  "menu",
  "menubar",
  "group",
  "radiogroup",
]);

export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit && explicit !== "presentation" && explicit !== "none") return explicit;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a":
    case "area":
      return el.hasAttribute("href") ? "link" : null;
    case "button":
    case "summary":
      return "button";
    case "input": {
      const t = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (t === "hidden") return null;
      return INPUT_ROLES[t] ?? "textbox";
    }
    case "select":
      return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1
        ? "listbox"
        : "combobox";
    case "textarea":
      return "textbox";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "img":
      return el.getAttribute("alt") === "" ? null : "img";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "form":
      return "form";
    case "dialog":
      return "dialog";
    case "table":
      return "table";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listitem";
    case "fieldset":
      return "group";
    case "header":
      return el.closest("article, aside, main, nav, section") ? null : "banner";
    case "footer":
      return el.closest("article, aside, main, nav, section") ? null : "contentinfo";
    case "section":
      return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
  }
  if ((el as HTMLElement).isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
  return null;
}

/** Plain elements that behave like buttons (a pointer cursor and focusable or clickable) but have no role. */
export function looksClickable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest("a[href], button, input, select, textarea, summary, [role]")) return false;
  const tab = el.getAttribute("tabindex");
  if (el.hasAttribute("onclick") || (tab !== null && Number(tab) >= 0)) return true;
  if (getComputedStyle(el).cursor !== "pointer") return false;
  // Only the outermost element with the pointer cursor, not each of its children.
  const p = el.parentElement;
  return !(p && getComputedStyle(p).cursor === "pointer");
}

function textById(ids: string, doc: Document): string {
  return ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id))
    .filter((e): e is HTMLElement => !!e)
    .map((e) => visibleText(e, 300).text)
    .join(" ");
}

function clean(s: string, max = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function labelsOf(el: Element): string {
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) return Array.from(labels, (l) => visibleText(l, 300).text).join(" ");
  return "";
}

export function nameOf(el: Element): string {
  const doc = el.ownerDocument;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = textById(by, doc);
    if (t.trim()) return clean(t);
  }
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return clean(aria);
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    const t = ((el as HTMLInputElement).type || "").toLowerCase();
    if (t === "submit" || t === "button" || t === "reset") return clean((el as HTMLInputElement).value || t);
    if (t === "image") return clean(el.getAttribute("alt") ?? "Submit");
    const l = labelsOf(el);
    if (l.trim()) return clean(l);
    const ph = el.getAttribute("placeholder");
    if (ph?.trim()) return clean(ph);
  }
  if (tag === "img" || tag === "area") return clean(el.getAttribute("alt") ?? el.getAttribute("title") ?? "");
  if (tag === "fieldset") {
    const legend = el.querySelector(":scope > legend");
    if (legend) return clean(visibleText(legend, 300).text);
  }
  if (tag === "table") {
    const cap = (el as HTMLTableElement).caption;
    if (cap) return clean(visibleText(cap, 300).text);
  }
  const role = roleOf(el);
  if (
    role &&
    /^(button|link|heading|tab|menuitem|option|listitem|checkbox|radio|switch|treeitem|gridcell|clickable|cell|alert|status)/.test(
      role,
    )
  ) {
    let t = visibleText(el, 400).text;
    if (!t.trim())
      t = Array.from(el.querySelectorAll("img[alt]"), (i) => i.getAttribute("alt") ?? "").join(" ");
    if (t.trim()) return clean(t);
  }
  return clean(el.getAttribute("title") ?? "");
}

export function isSecure(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea") return false;
  const i = el as HTMLInputElement;
  return isSecretField({
    tag,
    type: i.type,
    autocomplete: i.getAttribute("autocomplete"),
    name: i.name,
    id: i.id,
    label: labelsOf(el) || i.getAttribute("aria-label") || i.placeholder,
    inputmode: i.getAttribute("inputmode"),
  });
}

export function valueOf(el: Element): string | undefined {
  if (isSecure(el)) return undefined;
  const tag = el.tagName.toLowerCase();
  if (tag === "select") {
    const s = el as HTMLSelectElement;
    return Array.from(s.selectedOptions, (o) => o.label || o.text).join(", ");
  }
  if (tag === "textarea") return (el as HTMLTextAreaElement).value.slice(0, 2000);
  if (tag === "input") {
    const i = el as HTMLInputElement;
    if (["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden"].includes(i.type))
      return undefined;
    return i.value.slice(0, 500);
  }
  if ((el as HTMLElement).isContentEditable) return visibleText(el, 2000).text;
  const now = el.getAttribute("aria-valuenow") ?? el.getAttribute("aria-valuetext");
  return now ?? undefined;
}

export function stateOf(el: Element): NodeState {
  const s: NodeState = {};
  const aria = (n: string) => el.getAttribute(`aria-${n}`);
  const i = el as HTMLInputElement;
  if (el.tagName === "INPUT" && (i.type === "checkbox" || i.type === "radio"))
    s.checked = i.indeterminate ? "mixed" : i.checked;
  else if (aria("checked") !== null)
    s.checked = aria("checked") === "mixed" ? "mixed" : aria("checked") === "true";
  if (aria("pressed") !== null) s.checked = aria("pressed") === "true";
  if (aria("selected") === "true" || (el.tagName === "OPTION" && (el as HTMLOptionElement).selected))
    s.selected = true;
  if ((el as HTMLButtonElement).disabled || aria("disabled") === "true") s.disabled = true;
  if (aria("expanded") !== null) s.expanded = aria("expanded") === "true";
  if (el.tagName === "DETAILS" || el.tagName === "SUMMARY") {
    const d = el.tagName === "DETAILS" ? el : el.parentElement;
    if (d && d.tagName === "DETAILS") s.expanded = (d as HTMLDetailsElement).open;
  }
  if ((el as HTMLInputElement).required || aria("required") === "true") s.required = true;
  if (aria("invalid") === "true" || (el.matches("input, select, textarea") && el.matches(":user-invalid")))
    s.invalid = true;
  if ((el as HTMLInputElement).readOnly || aria("readonly") === "true") s.readonly = true;
  if (el.ownerDocument.activeElement === el) s.focused = true;
  if (isSecure(el)) s.secure = true;
  return s;
}

export function rectOf(el: Element): ViewportRect {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

export function inViewport(r: ViewportRect): boolean {
  return r.x + r.width > 0 && r.y + r.height > 0 && r.x < innerWidth && r.y < innerHeight;
}

const TEXT_TAGS =
  /^(P|LI|TD|TH|DT|DD|LABEL|SPAN|STRONG|EM|B|SMALL|DIV|BLOCKQUOTE|FIGCAPTION|CAPTION|PRE|CODE|LEGEND|TIME|ADDRESS|OUTPUT)$/;

function ownText(el: Element): string {
  let t = "";
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent ?? "";
  return t.replace(/\s+/g, " ").trim();
}

/** The page as a flat list of nodes in document order, with depth from structural ancestors. */
export function buildTree(maxNodes: number): PageTree {
  resetVisibilityCache();
  const nodes: TreeNode[] = [];
  let truncated = false;

  const visit = (el: Element, depth: number, insideInteractive: boolean): void => {
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "HEAD")
      return;
    if (el.hasAttribute(UI_HOST_ATTR)) return;
    if (!isVisible(el) && getComputedStyle(el).display !== "contents") {
      // A hidden <select>'s options and closed <details> contents are invisible too; skip the subtree.
      return;
    }
    let role = roleOf(el);
    if (!role && !insideInteractive && looksClickable(el)) role = "clickable";
    let childDepth = depth;
    let childInside = insideInteractive;
    if (role && (INTERACTIVE_ROLES.has(role) || STRUCTURE_ROLES.has(role))) {
      const interactive = INTERACTIVE_ROLES.has(role);
      const name = nameOf(el);
      // Unnamed structure (a bare list or group) adds depth but no node.
      if (
        interactive ||
        name ||
        role === "main" ||
        role === "form" ||
        role === "dialog" ||
        role === "table"
      ) {
        const rect = rectOf(el);
        const node: TreeNode = {
          ref: refFor(el),
          role,
          name,
          state: stateOf(el),
          rect,
          depth,
          inView: inViewport(rect),
        };
        const value = valueOf(el);
        if (value !== undefined && value !== "") node.value = value;
        if (role === "heading")
          node.level = Number(el.getAttribute("aria-level") ?? el.tagName.slice(1)) || 2;
        if (role === "link") node.href = (el as HTMLAnchorElement).href;
        if (el.tagName === "SELECT")
          node.options = Array.from((el as HTMLSelectElement).options, (o) => o.label || o.text).slice(0, 50);
        nodes.push(node);
      }
      if (!interactive) childDepth = depth + 1;
      if (interactive) childInside = true;
      // The insides of a select are its options, already listed; a textbox's insides are its value.
      if (el.tagName === "SELECT" || el.tagName === "TEXTAREA") return;
    } else if (
      !insideInteractive &&
      TEXT_TAGS.test(tag) &&
      !(tag === "LABEL" && (el as HTMLLabelElement).control)
    ) {
      // (A label that names a field is already the field's name.)
      const t = ownText(el);
      if (t.length >= 2 && isReadableTextIn(el)) {
        const rect = rectOf(el);
        nodes.push({
          ref: refFor(el),
          role: "text",
          name: clean(t, 300),
          state: {},
          rect,
          depth,
          inView: inViewport(rect),
        });
      }
    }
    const kids = el.shadowRoot ? el.shadowRoot.children : el.children;
    for (const k of kids) visit(k, childDepth, childInside);
  };

  if (document.body) visit(document.body, 0, false);
  const se = document.scrollingElement ?? document.documentElement;
  return {
    url: location.href,
    title: document.title,
    nodes,
    truncated,
    scroll: { y: Math.round(se.scrollTop), maxY: Math.max(0, Math.round(se.scrollHeight - innerHeight)) },
  };
}

/** Interactive elements on screen now, for eye-control targets. */
export function interactiveInView(
  max: number,
): Array<{ el: Element; role: string; name: string; rect: ViewportRect }> {
  resetVisibilityCache();
  const out: Array<{ el: Element; role: string; name: string; rect: ViewportRect }> = [];
  const sel =
    "a[href], area[href], button, input:not([type=hidden]), select, textarea, summary, [role], [tabindex], [onclick], [contenteditable=''], [contenteditable=true]";
  const candidates = new Set<Element>(document.querySelectorAll(sel));
  // Pointer-cursor elements without semantics: a bounded scan of the body's descendants.
  const all = document.body?.getElementsByTagName("*") ?? [];
  for (let i = 0; i < all.length && i < 6000; i++) {
    const el = all[i];
    if (
      el &&
      !candidates.has(el) &&
      (el.tagName === "DIV" || el.tagName === "SPAN" || el.tagName === "LI" || el.tagName === "IMG")
    )
      if (looksClickable(el)) candidates.add(el);
  }
  for (const el of candidates) {
    if (out.length >= max) break;
    let role = roleOf(el);
    if (!role && looksClickable(el)) role = "clickable";
    if (!role || !INTERACTIVE_ROLES.has(role)) continue;
    const rect = rectOf(el);
    if (!inViewport(rect) || !isVisible(el)) continue;
    // Skip elements covered by something else at their centre (menus, modals, cookie banners).
    const cx = Math.min(innerWidth - 1, Math.max(0, rect.x + rect.width / 2));
    const cy = Math.min(innerHeight - 1, Math.max(0, rect.y + rect.height / 2));
    const top = document.elementFromPoint(cx, cy);
    // (Elements under AGENCY's own banner are covered too: a look there lands on the banner.)
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      const label = (top as Element).closest("label");
      if (!label || !label.contains(el)) continue;
    }
    out.push({ el, role, name: nameOf(el) || role, rect });
  }
  return out;
}
