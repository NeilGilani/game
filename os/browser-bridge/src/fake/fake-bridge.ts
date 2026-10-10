/**
 * FakeBridge: an in-memory stand-in for the real bridge with the same BridgeApi and the same rules
 * (untrusted wrapping, approvals bound to fingerprints, Stop, protected sites, secret fields), over
 * scripted pages. Other instances use it to test the agent loop and task packs without Chrome.
 *
 *   const fake = new FakeBridge();                 // the built-in fake food store at food.fake
 *   const tools = new BrowserTools(fake);
 *   fake.orders                                    // what was "bought"
 *   fake.pressStop()                               // the person pressed Stop in Chrome
 */

import type { ConsequentialKind, TargetSnapshot } from "../../../contracts/src/index.ts";
import type { BridgeApi, BridgeConnection, CallOptions } from "../app/server.ts";
import { BridgeCallError } from "../app/server.ts";
import { sha256Hex } from "../auth.ts";
import { detectInjection } from "../injection.ts";
import { classifyUrl, containsCardNumber, isOpenableUrl } from "../policy.ts";
import {
  UNTRUSTED_NOTICE,
  type ActionDescription,
  type BridgeError,
  type BridgeEvent,
  type BridgeMethod,
  type ParamsOf,
  type ResultOf,
  type TabInfo,
  type TreeNode,
  type Untrusted,
} from "../protocol.ts";

export interface FakeNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  options?: string[];
  secure?: boolean;
  checked?: boolean;
  /** Clicking marks it consequential with this kind (the real bridge infers it from the page). */
  consequential?: ConsequentialKind;
  /** Runs on click/select/type; may return a new path to navigate to. */
  act?: (input: { text?: string; option?: string }) => string | void;
}

export interface FakePage {
  title: string;
  nodes: FakeNode[];
  /** Visible text (defaults to the node names). */
  text?: string;
}

export type FakeSite = (path: string) => FakePage | null;

export interface FakeOrder {
  id: string;
  items: string[];
  totalCents: number;
}

const fail = (code: BridgeError["code"], message: string, extra: Partial<BridgeError> = {}): never => {
  throw new BridgeCallError({ code, message, ...extra });
};

export class FakeBridge implements BridgeApi {
  readonly connection: BridgeConnection = "ready";
  readonly orders: FakeOrder[] = [];
  readonly calls: Array<{ method: BridgeMethod; params: unknown }> = [];
  private tabs = new Map<number, { url: string }>();
  private nextTab = 1;
  private stopped = false;
  private allowed = new Set<string>();
  private eventFns = new Set<(e: BridgeEvent) => void>();
  private sites = new Map<string, FakeSite>();
  /** The person's answer to policy.requestAllowance. */
  allowanceAnswer = false;

  constructor(sites?: Record<string, FakeSite>) {
    for (const [origin, site] of Object.entries(sites ?? { "http://food.fake": this.foodStore() }))
      this.sites.set(origin, site);
  }

  onEvent(fn: (e: BridgeEvent) => void): () => void {
    this.eventFns.add(fn);
    return () => this.eventFns.delete(fn);
  }
  onConnection(fn: (c: BridgeConnection) => void): () => void {
    fn("ready");
    return () => undefined;
  }

  /** The person pressed Stop in the page banner. */
  pressStop(tabId: number | null = null): void {
    this.stopped = true;
    this.emit({ type: "stopped", by: "person", tabId });
  }

  emitTargets(snapshot: TargetSnapshot, tabId = 1): void {
    this.emit({ type: "targets", snapshot, tabId });
  }

  private emit(e: BridgeEvent): void {
    for (const fn of this.eventFns) fn(e);
  }

  private page(tabId: number): { url: string; origin: string; page: FakePage } {
    const t = this.tabs.get(tabId) ?? fail("no-tab", `Tab ${tabId} is closed.`);
    const u = new URL(t.url);
    const site = this.sites.get(u.origin);
    const page = site?.(u.pathname + u.search) ?? { title: "Not found", nodes: [], text: "Not found" };
    return { url: t.url, origin: u.origin, page };
  }

  private guard(tabId: number): { url: string; origin: string; page: FakePage } {
    const p = this.page(tabId);
    const c = classifyUrl(p.url);
    if (c && !this.allowed.has(p.origin))
      fail("protected-site", `Protected site (${c.category}).`, { category: c.category });
    return p;
  }

  private untrusted<T>(url: string, data: T, text: string): Untrusted<T> {
    return {
      untrusted: true,
      notice: UNTRUSTED_NOTICE,
      origin: new URL(url).origin,
      url,
      data,
      suspectedInjection: detectInjection(text),
    };
  }

  private node(p: FakePage, ref: string): FakeNode {
    return (
      p.nodes.find((n) => n.ref === ref) ?? fail("no-element", `Element ${ref} is no longer on the page.`)
    );
  }

  private async describe(tabId: number, ref: string): Promise<ActionDescription> {
    const { url, page } = this.guard(tabId);
    const n = this.node(page, ref);
    const fingerprint = await sha256Hex(
      `fake|${url}|${ref}|${n.name}|${page.text ?? page.nodes.map((x) => `${x.name}=${x.value ?? ""}`).join(";")}`,
    );
    return {
      action: "click",
      ref,
      consequential: n.consequential ?? null,
      summary: `Press “${n.name}” on ${new URL(url).host}.`,
      details: { Site: new URL(url).origin, Button: n.name, ...(page.text ? { Page: page.text } : {}) },
      fingerprint,
    };
  }

  private go(tabId: number, path: string | void): boolean {
    if (!path) return false;
    const t = this.tabs.get(tabId)!;
    t.url = new URL(path, t.url).toString();
    this.emit({ type: "tab.updated", tabId, url: t.url, status: "complete" });
    return true;
  }

  async call<M extends BridgeMethod>(
    method: M,
    params: ParamsOf<M>,
    _opts?: CallOptions,
  ): Promise<ResultOf<M>> {
    this.calls.push({ method, params });
    const p = params as Record<string, unknown>;
    const tabId = p.tabId as number;
    const pageMethods = /^(page\.|tabs\.(open|navigate|activate)|policy\.requestAllowance)/;
    if (this.stopped && pageMethods.test(method)) fail("stopped", "The person pressed Stop.");
    const r = async (): Promise<unknown> => {
      switch (method) {
        case "bridge.status":
          return {
            protocol: 1,
            extensionVersion: "fake",
            stopped: this.stopped,
            sessions: [],
            targetsEnabled: true,
          };
        case "tabs.list": {
          const data: TabInfo[] = [...this.tabs].map(([id, t]) => {
            const c = classifyUrl(t.url);
            const allowed = c ? this.allowed.has(new URL(t.url).origin) : false;
            return {
              tabId: id,
              windowId: 1,
              url: t.url,
              title: c && !allowed ? "(protected site)" : this.page(id).page.title,
              active: true,
              protected: c ? { category: c.category, allowed } : null,
            };
          });
          return this.untrusted("http://tabs.fake", data, data.map((d) => d.title).join("\n"));
        }
        case "tabs.open": {
          const url = String(p.url);
          if (!isOpenableUrl(url)) fail("disallowed-url", "Only http and https pages can be opened.");
          const id = this.nextTab++;
          this.tabs.set(id, { url });
          return { tabId: id };
        }
        case "tabs.activate":
          this.page(tabId);
          return { tabId };
        case "tabs.navigate":
          this.page(tabId);
          this.tabs.get(tabId)!.url = String(p.url);
          return { tabId, url: String(p.url) };
        case "session.start":
        case "session.end":
          return { tabId };
        case "session.reset":
          this.stopped = false;
          return { stopped: false };
        case "stop.all":
          this.stopped = true;
          return { stopped: true };
        case "page.tree": {
          const { url, page } = this.guard(tabId);
          const nodes: TreeNode[] = page.nodes.map((n, i) => {
            const t: TreeNode = {
              ref: n.ref,
              role: n.role,
              name: n.name,
              state: {},
              rect: { x: 0, y: i * 40, width: 200, height: 32 },
              depth: 0,
              inView: true,
            };
            if (n.value !== undefined && !n.secure) t.value = n.value;
            if (n.secure) t.state.secure = true;
            if (n.checked !== undefined) t.state.checked = n.checked;
            if (n.options) t.options = n.options;
            return t;
          });
          return this.untrusted(
            url,
            { url, title: page.title, nodes, truncated: false, scroll: { y: 0, maxY: 0 } },
            page.title + "\n" + (page.text ?? ""),
          );
        }
        case "page.describeAction": {
          const d = await this.describe(tabId, String(p.ref));
          return this.untrusted(this.page(tabId).url, d, "");
        }
        case "page.click": {
          const { page } = this.guard(tabId);
          const n = this.node(page, String(p.ref));
          if (n.consequential) {
            const d = await this.describe(tabId, n.ref);
            if (!p.approvedFingerprint)
              fail("approval-required", `${d.summary} This needs the person's approval.`, { action: d });
            if (p.approvedFingerprint !== d.fingerprint)
              fail("approval-mismatch", "The page changed since the approval.", { action: d });
          }
          const navigated = this.go(tabId, n.act?.({}));
          return { done: true, navigated, url: this.page(tabId).url };
        }
        case "page.type": {
          const { page } = this.guard(tabId);
          const n = this.node(page, String(p.ref));
          if (n.secure) fail("secure-field", "AGENCY never types into password, code or card fields.");
          if (containsCardNumber(String(p.text))) fail("secret-in-text", "That text contains a card number.");
          n.value = (p.clear === false ? (n.value ?? "") : "") + String(p.text);
          n.act?.({ text: n.value });
          return { done: true, value: n.value };
        }
        case "page.select": {
          const { page } = this.guard(tabId);
          const n = this.node(page, String(p.ref));
          const opt =
            n.options?.find((o) => o.toLowerCase() === String(p.option).toLowerCase()) ??
            fail("no-element", `No option ${String(p.option)}.`);
          n.value = opt;
          n.act?.({ option: opt });
          return { done: true, value: opt };
        }
        case "page.scroll":
          this.guard(tabId);
          return { done: true, scroll: { y: 0, maxY: 0 } };
        case "page.waitFor":
          return { met: true, url: this.guard(tabId).url };
        case "page.extractText": {
          const { url, page } = this.guard(tabId);
          const text = page.text ?? page.nodes.map((n) => n.name).join("\n");
          return this.untrusted(url, { text, truncated: false }, text);
        }
        case "page.extractTables":
          return this.untrusted(this.guard(tabId).url, [], "");
        case "page.capture":
          return this.untrusted(this.guard(tabId).url, { dataUrl: "data:image/png;base64," }, "");
        case "policy.check": {
          const c = classifyUrl(String(p.url));
          return {
            protected: c
              ? { category: c.category, allowed: this.allowed.has(new URL(String(p.url)).origin) }
              : null,
          };
        }
        case "policy.requestAllowance": {
          const origin = new URL(this.page(tabId).url).origin;
          if (this.allowanceAnswer) this.allowed.add(origin);
          return { allowed: this.allowanceAnswer, origin };
        }
        case "reading.set":
          return { on: p.on === true };
        case "targets.config":
          return { enabled: p.enabled === true };
      }
      return fail("unknown-method", `Unknown method ${String(method)}.`);
    };
    return (await r()) as ResultOf<M>;
  }

  /** A tiny food store: one restaurant, one dish with a spice choice, cart, checkout and an order page. */
  foodStore(): FakeSite {
    const cart: string[] = [];
    let spice = "Mild";
    let tipPercent = 15;
    const PRICE = 1350;
    const totals = () => {
      const sub = cart.length * PRICE;
      const fees = cart.length ? 299 + Math.min(600, Math.max(150, Math.round(sub * 0.1))) : 0;
      const tax = Math.round(sub * 0.08875);
      const tip = Math.round((sub * tipPercent) / 100);
      return { sub, total: sub + fees + tax + tip };
    };
    const money = (c: number) => `$${(c / 100).toFixed(2)}`;
    return (path) => {
      if (path === "/")
        return {
          title: "Fake Food",
          nodes: [{ ref: "f1", role: "link", name: "Thai Basil", act: () => "/thai-basil" }],
        };
      if (path === "/thai-basil")
        return {
          title: "Thai Basil · Fake Food",
          nodes: [
            {
              ref: "t1",
              role: "combobox",
              name: "Spice level",
              value: spice,
              options: ["Mild", "Medium", "Hot"],
              act: ({ option }) => void (spice = option ?? spice),
            },
            {
              ref: "t2",
              role: "button",
              name: `Add Pad thai · ${money(PRICE)}`,
              act: () => (cart.push(`Pad thai (${spice})`), "/cart"),
            },
          ],
        };
      if (path === "/cart")
        return {
          title: "Cart · Fake Food",
          text: cart.join("\n"),
          nodes: [
            ...cart.map((c, i) => ({ ref: `c${i}`, role: "text", name: c })),
            { ref: "c-go", role: "link", name: "Go to checkout", act: () => "/checkout" },
          ],
        };
      if (path === "/checkout") {
        const t = totals();
        const text = `${cart.join("\n")}\nTip ${tipPercent}%\nTotal ${money(t.total)}`;
        return {
          title: "Checkout · Fake Food",
          text,
          nodes: [
            {
              ref: "k-tip20",
              role: "radio",
              name: "20%",
              checked: tipPercent === 20,
              act: () => void (tipPercent = 20),
            },
            { ref: "k-total", role: "text", name: `Total ${money(t.total)}` },
            { ref: "k-card", role: "textbox", name: "Card number", secure: true },
            {
              ref: "k-place",
              role: "button",
              name: "Place order",
              consequential: "purchase",
              act: () => {
                const id = `FAKE-${this.orders.length + 1}`;
                this.orders.push({ id, items: [...cart], totalCents: t.total });
                cart.length = 0;
                return `/orders/${id}`;
              },
            },
          ],
        };
      }
      const m = /^\/orders\/(FAKE-\d+)$/.exec(path);
      if (m) {
        const o = this.orders.find((x) => x.id === m[1]);
        return o
          ? {
              title: "Order placed",
              text: `Thanks! Order ${o.id}. Total ${money(o.totalCents)}.`,
              nodes: [{ ref: "o1", role: "heading", name: `Order ${o.id} placed` }],
            }
          : null;
      }
      return null;
    };
  }
}
