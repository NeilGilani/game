/**
 * GuardedTools: the only handle runners and task packs get on the bridge and the native helper. Every call
 * with an effect goes through ActionGuard.run with an action resolved from a fresh read of the page or app.
 */

import type { ActionGuard, GuardContext, GuardOutcome } from "../guard";
import { pageTotal } from "../policy/settings";
import type { ActionClaim, AgentAction, BrowserBridge, NativeClient, PageNode, PageSnapshot } from "../types";

export class ToolError extends Error {}

/** A claim worked out from the live page and the element about to be clicked. */
export type LiveClaim = (snapshot: PageSnapshot, node: PageNode) => ActionClaim;

const DISCLOSURE =
  /\b(AI|artificial intelligence|AGENCY assistant|assistant helped|sent with (help from )?AGENCY|synthetic voice)\b/i;

export class GuardedTools {
  /** Text typed per origin during this task, for the AI-disclosure check on send and call. */
  private readonly typed = new Map<string, Map<string, string>>();
  /** Page text just before the last approved consequential click, so verification can require a change. */
  lastConsequentialBefore: string | null = null;

  constructor(
    private readonly guard: ActionGuard,
    private readonly ctx: GuardContext,
    readonly bridge: BrowserBridge | null,
    readonly native: NativeClient | null,
  ) {}

  setWhy(why: string | undefined): void {
    this.ctx.why = why;
  }

  // --- Bridge tier --------------------------------------------------------------------------------

  async readPage(): Promise<PageSnapshot> {
    return this.requireBridge().snapshot();
  }

  findByName(snapshot: PageSnapshot, name: RegExp | string, role?: string): PageNode | undefined {
    const match = (n: PageNode) =>
      typeof name === "string"
        ? n.name.trim().toLowerCase() === name.trim().toLowerCase()
        : name.test(n.name);
    return snapshot.nodes.find((n) => match(n) && (!role || n.role === role) && !n.disabled);
  }

  /**
   * `claim` may be worked out from the live page each time the guard reads it (before asking and again right before
   * clicking), so what the person approves always describes the page as it is now. It may throw a ToolError to
   * refuse (the page started asking for a card number, the total went over the cap).
   */
  async click(ref: string, claim?: ActionClaim | LiveClaim): Promise<GuardOutcome<string>> {
    const bridge = this.requireBridge();
    let before = "";
    const outcome = await this.guard.run(
      this.ctx,
      async () => {
        const snap = await bridge.snapshot();
        before = snap.text;
        const node = nodeOrThrow(snap, ref);
        const c = typeof claim === "function" ? claim(snap, node) : claim;
        return {
          ...this.webAction("bridge.click", snap, node, c),
          input: { submits: node.submits === true },
        };
      },
      async (action, approval) => {
        // Tell the bridge whether the person approved this click: its own reading may find it consequential.
        const r = await bridge.click(ref, { approved: approval !== undefined });
        if (!r.ok) throw new ToolError(r.error ?? `Clicking "${action.target?.label}" did not work.`);
        return `Clicked "${action.target?.label}".`;
      },
    );
    if (outcome.status === "done" && outcome.approvalId) this.lastConsequentialBefore = before;
    return outcome;
  }

  type(ref: string, text: string, claim?: ActionClaim): Promise<GuardOutcome<string>> {
    const bridge = this.requireBridge();
    return this.guard.run(
      this.ctx,
      async () => {
        const snap = await bridge.snapshot();
        const node = nodeOrThrow(snap, ref);
        return {
          ...this.webAction("bridge.type", snap, node, claim),
          input: { text, autocomplete: node.autocomplete },
        };
      },
      async (action) => {
        const r = await bridge.type(ref, text);
        if (!r.ok) throw new ToolError(r.error ?? "Typing did not work.");
        const origin = action.target?.origin ?? "";
        const fields = this.typed.get(origin) ?? new Map<string, string>();
        fields.set(ref, text);
        this.typed.set(origin, fields);
        return `Typed into "${action.target?.label}".`;
      },
    );
  }

  /** Choose an option in a list on the page, by its label. */
  select(ref: string, option: string, claim?: ActionClaim): Promise<GuardOutcome<string>> {
    const bridge = this.requireBridge();
    return this.guard.run(
      this.ctx,
      async () => {
        const snap = await bridge.snapshot();
        const node = nodeOrThrow(snap, ref);
        return { ...this.webAction("bridge.select", snap, node, claim), input: { option } };
      },
      async (action) => {
        if (!bridge.select) throw new ToolError("This version of the AGENCY Bridge can't choose from lists.");
        const r = await bridge.select(ref, option);
        if (!r.ok) throw new ToolError(r.error ?? `Choosing "${option}" did not work.`);
        return `Chose "${option}" in "${action.target?.label}".`;
      },
    );
  }

  navigate(url: string): Promise<GuardOutcome<string>> {
    const bridge = this.requireBridge();
    return this.guard.run(
      this.ctx,
      async () => {
        let parsed: URL | null = null;
        try {
          parsed = new URL(url);
        } catch {
          throw new ToolError(`"${url}" is not a web address.`);
        }
        return {
          tier: "bridge",
          op: "bridge.navigate",
          input: { url: parsed.href },
          target: { origin: parsed.origin, url: parsed.href },
        };
      },
      async () => {
        const r = await bridge.navigate(url);
        if (!r.ok) throw new ToolError(r.error ?? "The page did not open.");
        return `Opened ${url}.`;
      },
    );
  }

  // --- Native tier (agency-native through the main process) ---------------------------------------

  async readApp(maxCount = 200): Promise<{
    owner: string | null;
    targets: { id: string; role: string; label: string; secure?: boolean }[];
  }> {
    const snap = await this.requireNative().call("ax.targets", { maxCount });
    return {
      owner: snap.owner,
      targets: snap.targets.map((t) => ({ id: t.id, role: t.role, label: t.label, secure: t.secure })),
    };
  }

  press(targetId: string, claim?: ActionClaim): Promise<GuardOutcome<string>> {
    const native = this.requireNative();
    return this.guard.run(
      this.ctx,
      async () => {
        const snap = await native.call("ax.targets", { maxCount: 500 });
        const t = snap.targets.find((x) => x.id === targetId);
        if (!t) throw new ToolError("That control is no longer on screen. Read the app again.");
        return {
          tier: "native",
          op: "native.press",
          target: {
            ref: t.id,
            label: t.label,
            role: t.role,
            origin: t.owner ?? snap.owner ?? undefined,
            secure: t.secure,
            simulated: isSimulatedApp(t.owner ?? snap.owner),
          },
          claim,
        };
      },
      async (action) => {
        const r = await native.call("ax.press", { targetId });
        if (!r.ok) throw new ToolError(r.error ?? `Pressing "${action.target?.label}" did not work.`);
        return `Pressed "${action.target?.label}".`;
      },
    );
  }

  typeText(text: string, claim?: ActionClaim): Promise<GuardOutcome<string>> {
    const native = this.requireNative();
    return this.guard.run(
      this.ctx,
      async () => {
        const front = await native.call("apps.frontmost", {});
        return {
          tier: "native",
          op: "native.type",
          input: { text },
          target: { origin: front.app?.bundleId, simulated: isSimulatedApp(front.app?.bundleId) },
          claim,
        };
      },
      async () => {
        const r = await native.call("input.type", { text });
        if (!r.ok) throw new ToolError(r.error ?? "Typing did not work (the field may be a password field).");
        return "Typed.";
      },
    );
  }

  key(
    key: string,
    modifiers: ("cmd" | "ctrl" | "alt" | "shift" | "fn")[] = [],
    claim?: ActionClaim,
  ): Promise<GuardOutcome<string>> {
    const native = this.requireNative();
    const combo = [...modifiers, key].join("+");
    return this.guard.run(
      this.ctx,
      async () => {
        const front = await native.call("apps.frontmost", {});
        return {
          tier: "native",
          op: "native.key",
          input: { key: combo },
          target: { origin: front.app?.bundleId, simulated: isSimulatedApp(front.app?.bundleId) },
          claim,
        };
      },
      async () => {
        await native.call("input.key", { key, modifiers });
        return `Pressed ${combo}.`;
      },
    );
  }

  openApp(bundleId: string): Promise<GuardOutcome<string>> {
    const native = this.requireNative();
    return this.guard.run(
      this.ctx,
      async () => ({
        tier: "native",
        op: "native.launch",
        input: { bundleId },
        target: { origin: bundleId, simulated: isSimulatedApp(bundleId) },
      }),
      async () => {
        const r = await native.call("apps.launch", { bundleId });
        if (!r.ok) throw new ToolError(r.error ?? `Could not open ${bundleId}.`);
        return `Opened ${bundleId}.`;
      },
    );
  }

  /** Run an arbitrary already-resolved action through the guard (computer-use tier). */
  runAction<T>(
    resolve: () => Promise<AgentAction>,
    exec: (a: AgentAction, approval?: { approvalId: string }) => Promise<T>,
  ): Promise<GuardOutcome<T>> {
    return this.guard.run(this.ctx, resolve, exec);
  }

  private webAction(op: string, snap: PageSnapshot, node: PageNode, claim?: ActionClaim): AgentAction {
    const facts: Record<string, string> = {};
    const total = /\$\s?\d/.test(snap.text) ? pageTotal(snap.text) : null;
    if (total !== null && op === "bridge.click") facts["Total"] = `$${total.toFixed(2)}`;
    const typed = this.typed.get(snap.origin);
    if (op === "bridge.click" && typed?.size)
      facts["AI disclosure"] = [...typed.values()].some((t) => DISCLOSURE.test(t)) ? "included" : "missing";
    return {
      tier: "bridge",
      op,
      target: {
        ref: node.ref,
        label: node.name,
        role: node.role,
        origin: snap.origin,
        url: snap.url,
        secure: node.secure,
        riskHint: node.risk,
        simulated: snap.simulated,
      },
      claim,
      facts,
      preview: { kind: "text", data: snap.text.slice(0, 1500) },
    };
  }

  private requireBridge(): BrowserBridge {
    if (!this.bridge) throw new ToolError("The AGENCY Bridge for Chrome is not connected.");
    return this.bridge;
  }

  private requireNative(): NativeClient {
    if (!this.native) throw new ToolError("The macOS helper is not available.");
    return this.native;
  }
}

function nodeOrThrow(snap: PageSnapshot, ref: string): PageNode {
  const node = snap.nodes.find((n) => n.ref === ref);
  if (!node) throw new ToolError(`Element ${ref} is no longer on the page. Read the page again.`);
  if (node.disabled) throw new ToolError(`"${node.name}" is disabled right now.`);
  return node;
}

/** Fake and demo apps used in tests and the simulated home. */
export function isSimulatedApp(bundleId: string | null | undefined): boolean {
  return !!bundleId && /^(test\.agency\.|com\.agency\.sim\.|com\.agency\.demo\.)/.test(bundleId);
}
