/**
 * The assistant's browser tools on AGENCY Browser: the same `bridge` rpc the agent uses for Chrome (snapshot, click,
 * type, navigate, select; os/agent/src/types.ts BrowserBridge, served for Chrome by BridgeHost.agentCall in
 * ../bridge.ts), so the agent's guard, approvals, secret rules, spending limits, Stop and timeouts apply unchanged.
 *
 * Like the Chrome bridge, this side has its own second line of defence, which can only make things stricter:
 * - a click the page reading finds consequential (pay, send, delete, sign in...) needs the guard's approval;
 * - on sensitive sites (banks, health records, government, password managers, account security) the assistant
 *   only reads and opens pages: every click needs the person's approval, and it never types or chooses there;
 * - at a robot check (captcha) it stops and asks for a helper;
 * - after Stop it does nothing at all until the person starts a new task.
 * Errors go back to the agent (and so to the model) in plain words with no page text in them.
 */

import { isSandboxOrigin } from "@agency/browser-bridge";
import type { ConsequentialKind, SensitiveKind } from "@agency/contracts";
import { decideNavigation, SENSITIVE_WORDS, sensitiveKind, siteLabel } from "./policy";

/** The page tree from the page (os/browser-bridge PageTree), as much of it as the agent needs. */
interface TreeNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  state: { secure?: boolean; disabled?: boolean; checked?: boolean | "mixed" };
  depth?: number;
  href?: string;
  options?: string[];
}
interface PageTree {
  url: string;
  title: string;
  nodes: TreeNode[];
}
interface Description {
  name: string;
  role: string;
  consequential: ConsequentialKind | null;
  key: string;
}

/** One tab the assistant works in. */
export interface AgentTab {
  id: number;
  url(): string;
  call<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** Open a checked address and wait for it to load (bounded). */
  load(url: string, timeoutMs: number): Promise<void>;
  /** After a click: wait for a page load it started, if one did (bounded). */
  settle(timeoutMs: number): Promise<void>;
}

export interface AgentBrowserDeps {
  /** The tab the assistant works in, made if there is none yet. */
  tab(): Promise<AgentTab>;
  internalOrigins(): readonly string[];
  /** Shown to the person while it happens ("Pressing “Add to cart”"); null when done. */
  acting?(what: string | null, tabId: number): void;
  helperNeeded?(why: string, tabId: number): void;
}

export class AgentBrowserError extends Error {}

const SIGN_IN =
  /\b(sign ?in|log ?in|log ?on|sign ?on|continue with (google|apple|facebook|microsoft|amazon|email)|use (a )?passkey)\b/i;

/** A link's address for the agent: plain http(s) only (never javascript:, data: or the like). */
function webHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

/**
 * Does this click need the person's approval, by this side's reading? The page reading (the bridge's own rules),
 * then signing in, then any click at all on a sensitive site. Pure, for tests.
 */
export function approvalKind(
  d: { name: string; role: string; consequential: ConsequentialKind | null },
  sensitive: SensitiveKind | null,
): ConsequentialKind | null {
  if (d.consequential) return d.consequential;
  if (SIGN_IN.test(d.name)) return "account-or-settings";
  if (sensitive === "bank" || sensitive === "passwords" || sensitive === "account") return "account-or-settings";
  if (sensitive) return "submit";
  return null;
}

/** Only a fixed word goes back to the agent, never page text. */
function safeKind(kind: string): string {
  return /^[a-z-]{1,40}$/.test(kind) ? kind : "consequential";
}

export class AgentBrowser {
  private stopped = false;

  constructor(private readonly deps: AgentBrowserDeps) {}

  /** Stop: nothing more until the person starts a new task. */
  stop(): void {
    this.stopped = true;
  }

  /** The person started a new task: the assistant may act again. */
  newTask(): void {
    this.stopped = false;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private running(): void {
    if (this.stopped)
      throw new AgentBrowserError("The person pressed Stop. Nothing more happens until they start a new task.");
  }

  async call(method: string, params: unknown): Promise<unknown> {
    this.running();
    const p = (params ?? {}) as { ref?: unknown; text?: unknown; url?: unknown; option?: unknown; approved?: unknown };
    switch (method) {
      case "snapshot":
        return this.snapshot();
      case "click":
        return this.click(String(p.ref ?? ""), p.approved === true);
      case "type":
        return this.type(String(p.ref ?? ""), String(p.text ?? ""));
      case "navigate":
        return this.navigate(String(p.url ?? ""));
      case "select":
        return this.select(String(p.ref ?? ""), String(p.option ?? ""));
      default:
        throw new AgentBrowserError(`Unknown browser method ${method}`);
    }
  }

  async snapshot(): Promise<unknown> {
    const tab = await this.deps.tab();
    const url = tab.url();
    if (!/^https?:/.test(url)) {
      return { tabId: String(tab.id), url, origin: "null", title: "New tab", nodes: [], text: "", simulated: false };
    }
    const tree = await tab.call<PageTree>("agent.tree", { maxNodes: 600 }, 10_000);
    this.running();
    const origin = originOf(tree.url);
    return {
      tabId: String(tab.id),
      url: tree.url,
      origin,
      title: tree.title,
      nodes: tree.nodes.map((n) => ({
        ref: n.ref,
        role: n.role,
        name: n.name,
        ...(n.value !== undefined && !n.state.secure ? { value: n.value } : {}),
        ...(n.state.secure ? { secure: true } : {}),
        ...(n.state.disabled ? { disabled: true } : {}),
        ...(typeof n.state.checked === "boolean" ? { checked: n.state.checked } : {}),
        ...(typeof n.depth === "number" ? { depth: n.depth } : {}),
        ...(webHref(n.href) ? { href: webHref(n.href) } : {}),
        ...(Array.isArray(n.options) ? { options: n.options.slice(0, 50) } : {}),
      })),
      text: tree.nodes
        .map((n) => n.name)
        .filter(Boolean)
        .join("\n"),
      simulated: isSandboxOrigin(origin),
    };
  }

  /** Robot checks stop the assistant: a helper does those. */
  private async noCaptcha(tab: AgentTab): Promise<void> {
    const captcha = await tab.call<boolean>("agent.captcha", {}, 5_000).catch(() => false);
    if (!captcha) return;
    const why = "This page shows a robot check (a captcha). AGENCY stops here: a helper needs to do it.";
    this.deps.helperNeeded?.(why, tab.id);
    throw new AgentBrowserError(why);
  }

  private readOnly(tab: AgentTab, what: string): void {
    const s = sensitiveKind(tab.url());
    if (!s) return;
    throw new AgentBrowserError(
      `${siteLabel(tab.url())} is ${SENSITIVE_WORDS[s]}, where AGENCY only reads and opens pages. It doesn't ${what} ` +
        "there: the person or a helper can.",
    );
  }

  async click(ref: string, approved: boolean): Promise<{ ok: true }> {
    const tab = await this.deps.tab();
    await this.noCaptcha(tab);
    const d = await tab.call<Description>("agent.describe", { ref }, 10_000);
    const kind = approvalKind(d, sensitiveKind(tab.url()));
    if (kind && !approved) {
      const k = safeKind(kind);
      throw new AgentBrowserError(
        `AGENCY Browser reads this click as "${k}", so the person has to approve it first. Nothing was clicked. ` +
          `Click it again marked with kind "${k}" so they can approve it.`,
      );
    }
    this.running();
    this.deps.acting?.(`Pressing “${d.name.slice(0, 60) || d.role}”`, tab.id);
    try {
      if (kind && !d.consequential) {
        // Approved by this side's reading only (signing in, a sensitive site): the page must not have changed.
        const again = await tab.call<Description>("agent.describe", { ref }, 10_000);
        if (again.key !== d.key)
          throw new AgentBrowserError("The page changed since the person approved. Read it again and ask again.");
      }
      // For the page's own reading, the page checks again right before the click: if the page changed since the
      // person approved (a different total), the click doesn't happen.
      await tab.call("agent.click", { ref, key: d.consequential ? d.key : undefined }, 20_000);
      await tab.settle(15_000);
    } finally {
      this.deps.acting?.(null, tab.id);
    }
    return { ok: true };
  }

  async type(ref: string, text: string): Promise<{ ok: true }> {
    const tab = await this.deps.tab();
    this.readOnly(tab, "type");
    await this.noCaptcha(tab);
    this.deps.acting?.("Typing", tab.id);
    try {
      await tab.call("agent.type", { ref, text }, 20_000);
    } finally {
      this.deps.acting?.(null, tab.id);
    }
    return { ok: true };
  }

  async select(ref: string, option: string): Promise<{ ok: true }> {
    const tab = await this.deps.tab();
    this.readOnly(tab, "choose from lists");
    await this.noCaptcha(tab);
    this.deps.acting?.(`Choosing “${option.slice(0, 40)}”`, tab.id);
    try {
      await tab.call("agent.select", { ref, option }, 20_000);
    } finally {
      this.deps.acting?.(null, tab.id);
    }
    return { ok: true };
  }

  async navigate(url: string): Promise<{ ok: true }> {
    const d = decideNavigation(url, this.deps.internalOrigins());
    if (!d.ok) throw new AgentBrowserError(d.reason);
    const tab = await this.deps.tab();
    this.deps.acting?.(`Opening ${siteLabel(d.url)}`, tab.id);
    try {
      await tab.load(d.url, 20_000);
    } finally {
      this.deps.acting?.(null, tab.id);
    }
    this.running();
    return { ok: true };
  }
}
