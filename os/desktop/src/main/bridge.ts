/**
 * The AGENCY Bridge (os/browser-bridge, Instance 5) in the main process: pairing, the Chrome native-messaging host
 * install, the local socket server, web targets for the overlay, Stop in both directions, and the agent's
 * `bridge` rpc (snapshot, click, type, navigate) mapped onto the bridge's methods.
 */

import { BridgeServer, ensurePairing, installNativeHost, isSandboxOrigin } from "@agency/browser-bridge";
import type { TargetSnapshot } from "@agency/contracts";
import type { Logger } from "./log";

export interface BridgeHostOptions {
  dir: string;
  hostScript: string | null;
  runtime: string;
  /** Write Chrome's NativeMessagingHosts manifest (off in tests, so they never touch the real profile). */
  install: boolean;
  log: Logger;
  onTargets: (snapshot: TargetSnapshot) => void;
  onStopped: () => void;
}

interface Untrusted<T> {
  data: T;
  origin: string;
  url: string;
  suspectedInjection: string[];
}
interface TreeNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  state: { secure?: boolean; disabled?: boolean };
}

export class BridgeHost {
  private server: BridgeServer | null = null;
  fingerprint: string | null = null;

  constructor(private readonly opts: BridgeHostOptions) {}

  get connection(): string {
    return this.server?.connection ?? "off";
  }

  async start(): Promise<void> {
    const pairing = ensurePairing({ dir: this.opts.dir });
    if (this.opts.install && this.opts.hostScript) {
      const res = installNativeHost({
        configPath: pairing.configPath,
        hostScript: this.opts.hostScript,
        runtime: this.opts.runtime,
        runAsNode: true,
      });
      this.opts.log.info(`bridge host installed for ${res.manifests.length} browser(s)`);
    }
    const server = new BridgeServer({
      socketPath: pairing.socketPath,
      token: pairing.token,
      log: (m) => this.opts.log.raw(m),
    });
    this.attach(server);
    await server.start();
  }

  /** Listens to the server's events and connection; it is the server from now on. */
  private attach(server: BridgeServer): void {
    server.onEvent((e) => {
      if (e.type === "targets") this.opts.onTargets(e.snapshot);
      if (e.type === "stopped") this.opts.onStopped();
    });
    server.onConnection((c) => {
      this.opts.log.info(`bridge: ${c}`);
      if (c === "ready" && this.rearmWanted) this.newTask();
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = null;
  }

  /** Global Stop: tell the extension too. Never throws. */
  stopAll(): void {
    // A Stop always wins over a re-arm still under way or waiting for the extension to connect.
    this.rearmWanted = false;
    this.stops += 1;
    this.server?.call("stop.all", {}).catch(() => undefined);
  }

  /** Set when the person started a task while the extension wasn't connected: re-arm it once it is. */
  private rearmWanted = false;
  private rearming: Promise<void> | null = null;
  private stops = 0;

  /**
   * The person started a new task. After a Stop the extension refuses all page work "until they start a new task"
   * (its Stop latch, kept across Chrome restarts; session.reset in os/browser-bridge/src/protocol.ts): this is that
   * moment, so lift it. Only a task the person starts does this, never the agent, and a Stop in the meantime wins.
   */
  newTask(): void {
    const s = this.server;
    if (!s || s.connection !== "ready") {
      this.rearmWanted = true;
      return;
    }
    this.rearmWanted = false;
    const stopsBefore = this.stops;
    const run = s
      .call("bridge.status", {})
      .then(async (status) => {
        // Not latched: nothing to lift (and a running task's tab sessions stay as they are).
        if (!(status as { stopped?: boolean }).stopped) return;
        if (this.stops !== stopsBefore) return; // Stop was pressed again meanwhile: it stays stopped
        await s.call("session.reset", {});
        this.opts.log.info("bridge: re-armed for the new task");
      })
      .then(
        () => undefined,
        (err: Error) => this.opts.log.warn(`bridge: could not re-arm after Stop: ${err.message}`),
      )
      .finally(() => {
        if (this.rearming === run) this.rearming = null;
      });
    this.rearming = run;
  }

  private async activeTab(): Promise<number> {
    const s = this.requireServer();
    const tabs = (await s.call("tabs.list", {})) as Untrusted<{ tabId: number; active: boolean }[]>;
    const tab = tabs.data.find((t) => t.active) ?? tabs.data[0];
    if (!tab) throw new Error("No Chrome tab is open.");
    return tab.tabId;
  }

  private requireServer(): BridgeServer {
    if (!this.server || this.server.connection !== "ready")
      throw new Error("The AGENCY Bridge is not connected.");
    return this.server;
  }

  /** The agent's BrowserBridge interface (os/agent/src/types.ts), over the bridge protocol. */
  async agentCall(method: string, params: unknown): Promise<unknown> {
    // The task's first page read must not race the re-arm that its own start triggered.
    if (this.rearming) await this.rearming;
    const s = this.requireServer();
    const p = (params ?? {}) as { ref?: string; text?: string; url?: string; approved?: unknown };
    const tabId = await this.activeTab();
    switch (method) {
      case "snapshot": {
        const tree = (await s.call("page.tree", { tabId })) as Untrusted<{
          url: string;
          title: string;
          nodes: TreeNode[];
        }>;
        return {
          tabId: String(tabId),
          url: tree.url,
          origin: tree.origin,
          title: tree.data.title,
          nodes: tree.data.nodes.map((n) => ({
            ref: n.ref,
            role: n.role,
            name: n.name,
            ...(n.value !== undefined && !n.state.secure ? { value: n.value } : {}),
            ...(n.state.secure ? { secure: true } : {}),
            ...(n.state.disabled ? { disabled: true } : {}),
          })),
          text: tree.data.nodes
            .map((n) => n.name)
            .filter(Boolean)
            .join("\n"),
          simulated: isSandboxOrigin(tree.origin),
        };
      }
      case "click": {
        // The bridge re-describes the live element. When by its own reading the click is consequential, it goes
        // through only if the agent's guard got the person's approval for it (`approved`), and then the bridge's own
        // fingerprint check also passes only for the same page state. Main never approves on the person's behalf a
        // click the agent's guard thought harmless (a "Continue" button that actually submits a payment form).
        const d = (await s.call("page.describeAction", { tabId, ref: String(p.ref) })) as Untrusted<{
          fingerprint: string;
          consequential: string | null;
        }>;
        if (d.data.consequential && p.approved !== true) {
          // Only the kind goes back (a fixed word), never page text: this message reaches the model.
          const kind = /^[a-z-]{1,40}$/.test(d.data.consequential) ? d.data.consequential : "consequential";
          throw new Error(
            `The AGENCY Bridge reads this click as "${kind}", so the person has to approve it first. ` +
              `Nothing was clicked. Click it again marked with kind "${kind}" so they can approve it.`,
          );
        }
        await s.call("page.click", {
          tabId,
          ref: String(p.ref),
          ...(d.data.consequential ? { approvedFingerprint: d.data.fingerprint } : {}),
        });
        return { ok: true };
      }
      case "type":
        await s.call("page.type", { tabId, ref: String(p.ref), text: String(p.text ?? "") });
        return { ok: true };
      case "navigate":
        await s.call("tabs.navigate", { tabId, url: String(p.url) });
        return { ok: true };
      default:
        throw new Error(`Unknown bridge method ${method}`);
    }
  }
}
