/**
 * AGENCY Browser in the main process: its own session, a WebContentsView per tab placed in the shell's content
 * area, navigation and request rules, permission and download prompts for the person, the page channel, and the
 * assistant's browser tools (agent.ts).
 *
 * Security, in one place:
 * - each tab: sandboxed, context isolation, no Node, web security on, no insecure content, no webviews, no dialogs,
 *   in the `persist:agency-browser` session (never AGENCY's own session, cookies or agency:// protocol);
 * - only http and https; never file:, chrome:, devtools:, javascript: or data: pages, never AGENCY's own services
 *   (the coordinator), not even as a page's background request;
 * - window.open becomes a tab here, never a new window; developer tools close as soon as they open;
 * - the camera is never a page's (it is the person's eyes); other permissions are asked per site, deny by default;
 * - downloads wait for the person's yes;
 * - pages talk only to main, through their preload, and main checks the sender and the frame of every message.
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
  type DownloadItem,
  type IpcMainEvent,
  type Rectangle,
  type Session,
  type WebContents,
} from "electron";
import {
  BROWSER_PARTITION,
  type ActivateResult,
  type ConsequentialKind,
  type BrowserEvent,
  type BrowserPrompt,
  type BrowserSettings,
  type BrowserState,
  type BrowserTab,
  type FieldOp,
  type FieldResult,
  type OpenResult,
  type PageField,
  type PageFrame,
  type PageTarget,
  type PopupInfo,
  type PromptAnswer,
  type ReaderArticle,
  type ScreenRect,
  type ScrollRequest,
  type SitePermission,
  type VideoCommand,
  type VideoState,
} from "@agency/contracts";
import type { Logger } from "../log";
import { isBlockedAd } from "./adblock";
import { AgentBrowser, PageMovedOn, type AgentTab } from "./agent";
import { writeWebSettings } from "./agentweb";
import { PageCallError, PageChannel, PageGone } from "./channel";
import {
  checkPermission,
  chromeUserAgent,
  decideNavigation,
  decideRequest,
  isProgram,
  loadError,
  routePermission,
  safeFilename,
  blockedLinkReason,
  securityOf,
  sensitiveKind,
  siteLabel,
  uniqueName,
} from "./policy";
import { BrowserStore } from "./store";

export const MAX_TABS = 12;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const PROMPT_TIMEOUT_MS = 120_000;

export interface BrowserHostOptions {
  userData: string;
  /** The page preload (out/browser-preload/index.cjs). */
  preload: string;
  log: Logger;
  /** AGENCY's own services (coordinator, dev shell): never reachable from a page. */
  internalOrigins: () => string[];
  emit: (event: BrowserEvent) => void;
  downloadsDir: () => string;
  /** The agent's settings file (agent-settings.json), where the assistant's web limits are written. */
  agentSettingsFile: string;
  /** Session to use (tests); default the persistent AGENCY Browser partition. */
  partition?: string;
}

interface Tab {
  id: number;
  view: WebContentsView | null;
  url: string;
  title: string;
  loading: boolean;
  error: BrowserTab["error"];
  video: VideoState | null;
  audible: boolean;
  zoom: number;
  thumb: string | null;
  /** Main-frame navigations so far, to tell whether a click opened a new page. */
  navs: number;
}

interface PendingPrompt {
  prompt: BrowserPrompt;
  settle: (answer: PromptAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BrowserHost {
  readonly store: BrowserStore;
  readonly session: Session;
  readonly channel = new PageChannel();
  readonly agent: AgentBrowser;
  private readonly tabs = new Map<number, Tab>();
  private readonly order: number[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private window: BrowserWindow | null = null;
  private bounds: Rectangle | null = null;
  private wantVisible = false;
  /** Lifeline is up: no page may be in front of it, whatever the shell asks. */
  private emergency = false;
  private bigScreen = false;
  private readonly prompts = new Map<string, PendingPrompt>();
  private promptSeq = 0;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private agentTabId: number | null = null;
  private agentWantsCurrent = false;
  private agentActive = false;
  /** Ids of every tab's webContents, so a message can be checked against them. */
  private readonly byContents = new Map<number, number>();

  constructor(private readonly opts: BrowserHostOptions) {
    this.store = new BrowserStore(join(opts.userData, "browser"));
    // Downloads nobody said yes to before AGENCY last quit.
    rmSync(this.pendingDir, { recursive: true, force: true });
    this.session = electronSession.fromPartition(opts.partition ?? BROWSER_PARTITION);
    this.configureSession();
    this.syncAgentSettings();
    this.agent = new AgentBrowser({
      tab: () => this.agentTab(),
      internalOrigins: () => this.opts.internalOrigins(),
      acting: (what, tabId) =>
        this.opts.emit({ type: "agent", tabId, active: true, acting: what ?? undefined }),
      helperNeeded: (why, tabId) => this.opts.emit({ type: "agent", tabId, active: true, helperNeeded: why }),
    });
    this.newTab();
  }

  // --------------------------------------------------------------------------------------------------
  // Session

  /** Is this one of AGENCY Browser's pages (its session)? Such contents get this file's rules, not the app's. */
  owns(contents: WebContents): boolean {
    return contents.session === this.session;
  }

  private configureSession(): void {
    const s = this.session;
    s.setUserAgent(chromeUserAgent(s.getUserAgent()));
    s.setSpellCheckerEnabled(false);
    s.setPermissionRequestHandler((contents, permission, callback, details) => {
      const mediaTypes = "mediaTypes" in details ? (details.mediaTypes as string[] | undefined) : undefined;
      void this.onPermission(contents, permission, mediaTypes, details.requestingUrl).then(callback, () =>
        callback(false),
      );
    });
    s.setPermissionCheckHandler((contents, permission, origin, details) => {
      if (!contents || !this.byContents.has(contents.id)) return false;
      const mediaType = (details as { mediaType?: string }).mediaType;
      const o = this.originOf(origin || details.requestingUrl || contents.getURL());
      return checkPermission(permission, mediaType, (p) => (o ? this.store.permission(o, p) : null));
    });
    s.setDevicePermissionHandler(() => false);
    s.on("select-hid-device", (e, _d, cb) => (e.preventDefault(), cb("")));
    s.on("select-serial-port", (e, _p, _w, cb) => (e.preventDefault(), cb("")));
    s.on("select-usb-device", (e, _d, cb) => (e.preventDefault(), cb()));
    s.webRequest.onBeforeRequest((details, callback) => {
      const internal = this.opts.internalOrigins();
      if (!decideRequest(details.url, internal)) return callback({ cancel: true });
      if (this.store.settings.blockAds) {
        const page =
          details.webContents && !details.webContents.isDestroyed() ? details.webContents.getURL() : null;
        if (isBlockedAd(details.url, page, details.resourceType)) return callback({ cancel: true });
      }
      callback({});
    });
    s.on("will-download", (_e, item, contents) => this.onDownload(item, contents));
  }

  private originOf(url: string | undefined): string | null {
    try {
      const u = new URL(url ?? "");
      return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------------------------------
  // Tabs and views

  private tabFor(id: number): Tab {
    const t = this.tabs.get(id);
    if (!t) throw new Error("That tab isn't open any more.");
    return t;
  }

  private contentsOf(tab: Tab): WebContents {
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) throw new PageGone("This tab has no page open.");
    return wc;
  }

  newTab(activate = true): number {
    if (this.tabs.size >= MAX_TABS) {
      this.notice(null, `You have ${MAX_TABS} tabs open. Close one first.`, "warn");
      return this.activeId ?? this.order[0]!;
    }
    const id = this.nextId++;
    this.tabs.set(id, {
      id,
      view: null,
      url: "",
      title: "New tab",
      loading: false,
      error: null,
      video: null,
      audible: false,
      zoom: 1,
      thumb: null,
      navs: 0,
    });
    this.order.push(id);
    if (activate || this.activeId === null) this.activateTab(id);
    else this.changed();
    return id;
  }

  private ensureView(tab: Tab): WebContents {
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view.webContents;
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        preload: this.opts.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
        safeDialogs: true,
        autoplayPolicy: "document-user-activation-required",
        enableWebSQL: false,
        experimentalFeatures: false,
      },
    });
    view.setBackgroundColor("#ffffff");
    tab.view = view;
    const wc = view.webContents;
    this.byContents.set(wc.id, tab.id);
    this.wire(tab, wc);
    return wc;
  }

  private wire(tab: Tab, wc: WebContents): void {
    const block = (url: string, kind: "navigation" | "redirect") => {
      const d = decideNavigation(url, this.opts.internalOrigins());
      if (d.ok) return false;
      this.opts.log.warn(`browser: blocked ${kind} (${d.kind})`);
      this.notice(tab.id, d.reason, "warn");
      return true;
    };
    wc.on("will-navigate", (e) => {
      if (block(e.url, "navigation")) e.preventDefault();
    });
    wc.on("will-redirect", (e) => {
      if (e.isMainFrame && block(e.url, "redirect")) e.preventDefault();
    });
    wc.on("will-frame-navigate", (e) => {
      // Frames inside a page follow the same scheme rules (no file:, no AGENCY services).
      if (!e.isMainFrame && !decideRequest(e.url, this.opts.internalOrigins())) e.preventDefault();
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      // A page's new window is a new tab here (without a link back to its opener), never an Electron window.
      const d = decideNavigation(url, this.opts.internalOrigins());
      if (!d.ok) {
        if (url && url !== "about:blank") this.notice(tab.id, d.reason, "warn");
        return { action: "deny" };
      }
      if (this.tabs.size >= MAX_TABS) {
        this.notice(tab.id, `That page wanted a new tab, but ${MAX_TABS} are open. Close one first.`, "warn");
        return { action: "deny" };
      }
      const id = this.newTab(disposition !== "background-tab");
      this.load(this.tabFor(id), d.url);
      return { action: "deny" };
    });
    wc.on("did-start-navigation", (e) => {
      if (!e.isMainFrame || e.isSameDocument) return;
      this.channel.dropFor(wc.id, true);
      tab.navs += 1;
    });
    wc.on("did-start-loading", () => {
      tab.loading = true;
      this.changed();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      this.changed();
    });
    wc.on("did-navigate", (_e, url) => {
      tab.url = url;
      tab.error = null;
      tab.video = null;
      tab.title = wc.getTitle() || siteLabel(url);
      this.store.addHistory(url, tab.title);
      if (this.bigScreen && tab.id === this.activeId) this.setBigScreen(false);
      this.attach();
      this.changed();
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      this.store.addHistory(url, wc.getTitle() || tab.title);
      this.changed();
    });
    wc.on("page-title-updated", (_e, title) => {
      tab.title = title.slice(0, 200);
      this.store.titleHistory(tab.url, tab.title);
      this.changed();
    });
    wc.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      const err = loadError(code);
      if (!err) return;
      tab.error = { ...err, url };
      tab.loading = false;
      this.attach();
      this.changed();
    });
    wc.on("render-process-gone", () => {
      this.channel.dropFor(wc.id);
      tab.error = {
        kind: "crashed",
        message: "This page stopped working. Reload it to try again.",
        url: tab.url,
      };
      this.attach();
      this.changed();
    });
    wc.on("enter-html-full-screen", () => {
      if (tab.id === this.activeId) this.setBigScreen(true);
    });
    wc.on("leave-html-full-screen", () => {
      if (tab.id === this.activeId) this.setBigScreen(false);
    });
    wc.on("audio-state-changed", (e) => {
      tab.audible = e.audible;
      this.changed();
    });
    wc.on("zoom-changed", (_e, dir) => void this.zoom(tab.id, dir));
    // Developer tools are off limits in AGENCY Browser.
    wc.on("devtools-opened", () => wc.closeDevTools());
    // "Leave this page?" never traps the person: leaving always works.
    wc.on("will-prevent-unload", (e) => e.preventDefault());
    wc.on("login", (e, _details, _info, callback) => {
      e.preventDefault();
      callback();
      this.notice(
        tab.id,
        "This site asks for a user name and password in a box AGENCY can't show. A helper can sign in for you.",
        "warn",
      );
    });
    wc.on("destroyed", () => {
      this.byContents.delete(wc.id);
      this.channel.dropFor(wc.id);
    });
  }

  /** Open a checked address in a tab. Never awaits the load (a failed load reports through did-fail-load). */
  private load(tab: Tab, url: string): void {
    const wc = this.ensureView(tab);
    tab.url = url;
    tab.title = siteLabel(url);
    tab.error = null;
    tab.loading = true;
    wc.setZoomFactor(tab.zoom);
    wc.loadURL(url).catch(() => undefined);
    this.attach();
    this.changed();
  }

  /** Only the active tab's view is in the window, where the shell said, and only when nothing may cover it. */
  private attach(): void {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    const children = win.contentView.children;
    const active = this.activeId === null ? null : this.tabs.get(this.activeId);
    for (const t of this.tabs.values()) {
      if (!t.view || t === active) continue;
      if (children.includes(t.view)) win.contentView.removeChildView(t.view);
    }
    if (!active?.view || active.view.webContents.isDestroyed()) return;
    const show = this.visibleNow(active);
    if (!children.includes(active.view)) win.contentView.addChildView(active.view);
    if (this.bounds) active.view.setBounds(this.bounds);
    active.view.setVisible(show);
  }

  private visibleNow(tab: Tab): boolean {
    return this.wantVisible && !this.emergency && !!this.bounds && tab.url !== "" && !tab.error;
  }

  /** The shell says where the page goes (its client coordinates) and whether it may show. */
  layout(sender: WebContents, rect: ScreenRect | null, visible: boolean): void {
    const win = BrowserWindow.fromWebContents(sender);
    if (win && win !== this.window) {
      this.window = win;
      win.once("closed", () => {
        if (this.window === win) this.window = null;
      });
    }
    const zoom = sender.getZoomFactor();
    const ok = rect && [rect.x, rect.y, rect.width, rect.height].every((n) => Number.isFinite(n));
    this.bounds =
      ok && rect.width >= 40 && rect.height >= 40
        ? {
            x: Math.round(rect.x * zoom),
            y: Math.round(rect.y * zoom),
            width: Math.round(rect.width * zoom),
            height: Math.round(rect.height * zoom),
          }
        : null;
    this.wantVisible = visible && !!this.bounds;
    this.attach();
  }

  /** Lifeline: hide every page now (main's own call, so no shell state can keep a page in front). */
  setEmergency(on: boolean): void {
    this.emergency = on;
    this.attach();
  }

  /** For tests: is a page showing now? */
  get pageShowing(): boolean {
    const t = this.activeId === null ? null : this.tabs.get(this.activeId);
    return !!t?.view && this.visibleNow(t) && !!this.window?.contentView.children.includes(t.view);
  }

  activateTab(id: number): void {
    const prev = this.activeId === null ? null : this.tabs.get(this.activeId);
    if (prev && prev.id !== id) void this.snapshotThumb(prev);
    this.tabFor(id);
    this.activeId = id;
    if (this.bigScreen) this.setBigScreen(false);
    this.attach();
    this.changed();
  }

  closeTab(id: number): void {
    const tab = this.tabFor(id);
    const i = this.order.indexOf(id);
    this.order.splice(i, 1);
    this.tabs.delete(id);
    if (this.agentTabId === id) this.agentTabId = null;
    if (tab.view) {
      const win = this.window;
      if (win && !win.isDestroyed() && win.contentView.children.includes(tab.view))
        win.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    for (const [pid, p] of this.prompts)
      if (p.prompt.tabId === id) this.settlePrompt(pid, p.prompt.type === "download" ? "cancel" : "deny");
    if (this.activeId === id) {
      this.activeId = null;
      const next = this.order[Math.min(i, this.order.length - 1)];
      if (next !== undefined) this.activateTab(next);
      else this.newTab();
    }
    this.changed();
  }

  // --------------------------------------------------------------------------------------------------
  // State

  private tabState(t: Tab): BrowserTab {
    const wc = t.view && !t.view.webContents.isDestroyed() ? t.view.webContents : null;
    let security: BrowserTab["security"] = "new";
    if (t.url) {
      try {
        security = securityOf(new URL(t.url));
      } catch {
        security = "insecure";
      }
    }
    return {
      id: t.id,
      url: t.url,
      title: t.title,
      loading: t.loading,
      canGoBack: !!wc?.navigationHistory.canGoBack() || (!t.url && !!wc && /^https?:/.test(wc.getURL())),
      canGoForward: !!wc?.navigationHistory.canGoForward(),
      security,
      zoom: t.zoom,
      error: t.error,
      video: t.video,
      agent: this.agentActive && this.agentTabId === t.id,
      audible: t.audible,
      sensitive: t.url ? sensitiveKind(t.url) : null,
    };
  }

  state(): BrowserState {
    return {
      tabs: this.order.map((id) => this.tabState(this.tabs.get(id)!)),
      activeId: this.activeId,
      bigScreen: this.bigScreen,
    };
  }

  private changed(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.opts.emit({ type: "state", state: this.state() });
    }, 40);
  }

  private notice(tabId: number | null, text: string, tone: "info" | "warn" | "danger"): void {
    this.opts.emit({ type: "notice", tabId, notice: { text, tone } });
  }

  // --------------------------------------------------------------------------------------------------
  // Navigation

  open(url: string, newTab = false): OpenResult {
    const d = decideNavigation(url, this.opts.internalOrigins());
    if (!d.ok) return { ok: false, error: d.reason };
    const active = this.activeId === null ? null : this.tabs.get(this.activeId);
    let tab: Tab;
    if (!newTab && active && active.url === "") tab = active;
    else {
      if (this.tabs.size >= MAX_TABS)
        return { ok: false, error: `You have ${MAX_TABS} tabs open. Close one first.` };
      tab = this.tabFor(this.newTab());
    }
    this.activateTab(tab.id);
    this.load(tab, d.url);
    return { ok: true, tabId: tab.id };
  }

  navigate(tabId: number, url: string): OpenResult {
    const d = decideNavigation(url, this.opts.internalOrigins());
    if (!d.ok) return { ok: false, error: d.reason };
    const tab = this.tabFor(tabId);
    this.load(tab, d.url);
    return { ok: true, tabId };
  }

  /** The start page in this tab; the page stays behind it, so Back brings it back. */
  start(tabId: number): void {
    const tab = this.tabFor(tabId);
    if (!tab.url) return;
    tab.url = "";
    tab.title = "New tab";
    tab.error = null;
    if (this.bigScreen) this.setBigScreen(false);
    this.attach();
    this.changed();
  }

  back(tabId: number): void {
    const tab = this.tabFor(tabId);
    const wc = tab.view?.webContents;
    if (!tab.url && wc && !wc.isDestroyed() && /^https?:/.test(wc.getURL())) {
      // From the start page back to the page behind it.
      tab.url = wc.getURL();
      tab.title = wc.getTitle() || siteLabel(tab.url);
      this.attach();
      this.changed();
      return;
    }
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) {
      tab.error = null;
      wc.navigationHistory.goBack();
    } else if (tab.url) {
      // Back from the first page goes to the start page.
      tab.url = "";
      tab.title = "New tab";
      tab.error = null;
      this.attach();
      this.changed();
    }
  }

  forward(tabId: number): void {
    const wc = this.tabFor(tabId).view?.webContents;
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(tabId: number): void {
    const tab = this.tabFor(tabId);
    if (!tab.url) return;
    if (!tab.view || tab.view.webContents.isDestroyed() || tab.error?.kind === "crashed") {
      if (tab.view) tab.view = null;
      this.load(tab, tab.url);
      return;
    }
    tab.error = null;
    tab.view.webContents.reload();
    this.attach();
    this.changed();
  }

  stopLoading(tabId: number): void {
    this.tabFor(tabId).view?.webContents.stop();
  }

  zoom(tabId: number, change: "in" | "out" | "reset"): number {
    const tab = this.tabFor(tabId);
    const i = ZOOM_STEPS.findIndex((z) => z >= tab.zoom - 0.001);
    const at = i < 0 ? ZOOM_STEPS.indexOf(1) : i;
    const next =
      change === "reset"
        ? 1
        : ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, at + (change === "in" ? 1 : -1)))]!;
    tab.zoom = next;
    const wc = tab.view?.webContents;
    if (wc && !wc.isDestroyed()) wc.setZoomFactor(next);
    this.changed();
    return next;
  }

  // --------------------------------------------------------------------------------------------------
  // Pictures

  private async capture(tab: Tab, maxWidth: number, quality: number): Promise<string | null> {
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed() || !tab.url || tab.error) return null;
    try {
      const img = await wc.capturePage();
      if (img.isEmpty()) return null;
      const size = img.getSize();
      const scaled = size.width > maxWidth ? img.resize({ width: maxWidth, quality: "good" }) : img;
      return `data:image/jpeg;base64,${scaled.toJPEG(quality).toString("base64")}`;
    } catch {
      return null;
    }
  }

  private async snapshotThumb(tab: Tab): Promise<void> {
    if (!tab.view || tab.id !== this.activeId || !this.pageShowing) return;
    tab.thumb = (await this.capture(tab, 480, 70)) ?? tab.thumb;
  }

  async thumbnails(): Promise<Record<number, string>> {
    const active = this.activeId === null ? null : this.tabs.get(this.activeId);
    if (active) await this.snapshotThumb(active);
    const out: Record<number, string> = {};
    for (const t of this.tabs.values()) if (t.thumb && t.url) out[t.id] = t.thumb;
    return out;
  }

  // --------------------------------------------------------------------------------------------------
  // The person choosing on the page

  call<T>(tab: Tab, method: string, params: Record<string, unknown> = {}, timeoutMs = 5_000): Promise<T> {
    return this.channel.call<T>(this.contentsOf(tab), method, params, timeoutMs);
  }

  /** The page held still: a picture of it and what can be chosen, in the view's own coordinates. */
  async frame(tabId: number): Promise<PageFrame | null> {
    const tab = this.tabFor(tabId);
    if (!tab.url || tab.error || !tab.view) return null;
    const scale = this.window && !this.window.isDestroyed() ? this.window.webContents.getZoomFactor() : 1;
    const width = Math.max(320, (this.bounds?.width ?? 1280) / scale);
    const [image, page] = await Promise.all([
      this.capture(tab, Math.round(width * 2), 82),
      this.call<{
        targets: PageTarget[];
        truncated: boolean;
        viewport: { width: number; height: number };
        scroll: { y: number; maxY: number };
      }>(tab, "targets", {}, 8_000),
    ]);
    const z = tab.zoom;
    const targets = (Array.isArray(page?.targets) ? page.targets : []).slice(0, 300).map((t) => ({
      ...t,
      ref: String(t.ref).slice(0, 40),
      name: String(t.name ?? "").slice(0, 120),
      rect: { x: t.rect.x * z, y: t.rect.y * z, width: t.rect.width * z, height: t.rect.height * z },
    }));
    return {
      tabId,
      image,
      targets,
      truncated: !!page.truncated,
      viewport: { width: page.viewport.width * z, height: page.viewport.height * z },
      scroll: page.scroll,
    };
  }

  /** Show the page now (a real click needs it on screen) and give it a frame to draw. */
  private async showForInput(tab: Tab): Promise<void> {
    if (tab.id !== this.activeId) this.activateTab(tab.id);
    if (this.pageShowing) return;
    this.wantVisible = !!this.bounds;
    this.attach();
    await sleep(60);
  }

  /** A real (trusted) left click at a point in the page, in CSS pixels. */
  private sendClick(wc: WebContents, x: number, y: number, zoom: number): void {
    const px = Math.round(x * zoom);
    const py = Math.round(y * zoom);
    wc.sendInputEvent({ type: "mouseMove", x: px, y: py });
    wc.sendInputEvent({ type: "mouseDown", x: px, y: py, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: px, y: py, button: "left", clickCount: 1 });
  }

  private async navigatedSince(tab: Tab, navs: number, waitMs: number): Promise<boolean> {
    for (let waited = 0; waited < waitMs && tab.navs === navs; waited += 50) await sleep(50);
    return tab.navs !== navs;
  }

  /** The person chose this on the page: type into it, choose from it, or click it (asking first if it pays, sends...). */
  async activate(tabId: number, ref: string, confirmed = false): Promise<ActivateResult> {
    const tab = this.tabFor(tabId);
    type Inspection =
      | { kind: "gone" }
      | { kind: "field"; field: PageField }
      | { kind: "list"; label: string; options: string[]; selected: string | null }
      | {
          kind: "click";
          name: string;
          consequential: ConsequentialKind | null;
          x: number;
          y: number;
          hit: boolean;
          href: string | null;
        };
    let ins: Inspection;
    try {
      ins = await this.call<Inspection>(tab, "inspect", { ref: String(ref).slice(0, 40) });
    } catch (e) {
      return e instanceof PageGone
        ? { kind: "gone" }
        : { kind: "error", message: "That didn't work. Try again." };
    }
    if (ins.kind === "gone") return { kind: "gone" };
    if (ins.kind === "field") return { kind: "field", field: ins.field };
    if (ins.kind === "list")
      return { kind: "list", ref, label: ins.label, options: ins.options, selected: ins.selected };
    // Chromium ignores these links without a word, so say why nothing happens, and don't click.
    const silent = ins.href ? blockedLinkReason(ins.href) : null;
    if (silent) {
      this.notice(tab.id, silent, "warn");
      return { kind: "done", navigated: false };
    }
    if (ins.consequential && !confirmed)
      return {
        kind: "confirm",
        action: ins.consequential,
        label: String(ins.name).slice(0, 80),
        origin: siteLabel(tab.url),
      };
    const wc = this.contentsOf(tab);
    const navs = tab.navs;
    await this.showForInput(tab);
    try {
      await this.call(tab, "expectClick", { ref });
      if (ins.hit) this.sendClick(wc, ins.x, ins.y, tab.zoom);
      await this.call(tab, "settleClick", {}, 2_000);
    } catch (e) {
      // A click that opened a new page takes the old page (and its answer) with it: that is success.
      if (!(e instanceof PageGone)) return { kind: "error", message: "That didn't work. Try again." };
    }
    return { kind: "done", navigated: await this.navigatedSince(tab, navs, 500) };
  }

  async field(tabId: number, ref: string, op: FieldOp): Promise<FieldResult> {
    const tab = this.tabFor(tabId);
    const r = String(ref).slice(0, 40);
    try {
      if (op.op === "set") {
        const value = typeof op.value === "string" ? op.value.slice(0, 5000) : "";
        return { kind: "field", field: await this.call<PageField>(tab, "field.set", { ref: r, value }) };
      }
      if (op.op === "show")
        return { kind: "field", field: await this.call<PageField>(tab, "field.focus", { ref: r }) };
      if (op.op === "next" || op.op === "previous") {
        const f = await this.call<PageField | null>(tab, "field.move", {
          ref: r,
          step: op.op === "next" ? 1 : -1,
        });
        return f
          ? { kind: "field", field: f }
          : { kind: "field", field: await this.call<PageField>(tab, "field.info", { ref: r }) };
      }
      const kind = await this.call<string | null>(tab, "field.submitKind", { ref: r });
      if (kind && !op.confirmed)
        return {
          kind: "confirm",
          action: kind as ConsequentialKind,
          label: "Submit",
          origin: siteLabel(tab.url),
        };
      const navs = tab.navs;
      await this.call(tab, "field.submit", { ref: r }).catch((e: unknown) => {
        if (!(e instanceof PageGone)) throw e;
      });
      return { kind: "done", navigated: await this.navigatedSince(tab, navs, 800) };
    } catch (e) {
      if (e instanceof PageGone) return { kind: "gone" };
      return {
        kind: "error",
        message: e instanceof PageCallError ? e.message : "That didn't work. Try again.",
      };
    }
  }

  async chooseOption(tabId: number, ref: string, option: string): Promise<boolean> {
    const tab = this.tabFor(tabId);
    return this.call<boolean>(tab, "chooseOption", {
      ref: String(ref).slice(0, 40),
      option: String(option).slice(0, 200),
    }).catch(() => false);
  }

  scroll(tabId: number, req: ScrollRequest): void {
    const tab = this.tabs.get(tabId);
    if (!tab?.view || !tab.url) return;
    const params: Record<string, unknown> =
      req.by === "px"
        ? { by: "px", amount: Number(req.amount) }
        : { by: req.by, direction: req.direction === -1 ? -1 : 1 };
    void this.call(tab, "scroll", params, 2_000).catch(() => undefined);
  }

  async reader(tabId: number): Promise<ReaderArticle | null> {
    const tab = this.tabFor(tabId);
    if (!tab.url || tab.error) return null;
    return this.call<ReaderArticle | null>(tab, "reader", {}, 15_000).catch(() => null);
  }

  async popup(tabId: number): Promise<PopupInfo | null> {
    const tab = this.tabFor(tabId);
    if (!tab.url || tab.error) return null;
    return this.call<PopupInfo | null>(tab, "popup", {}, 5_000).catch(() => null);
  }

  async closePopup(tabId: number, ref: string): Promise<boolean> {
    const tab = this.tabFor(tabId);
    if (ref === "hide") return this.call<boolean>(tab, "popup.hide", {}, 5_000).catch(() => false);
    const r = await this.activate(tabId, ref, true);
    return r.kind === "done";
  }

  // --------------------------------------------------------------------------------------------------
  // Video

  async video(tabId: number, command: VideoCommand): Promise<VideoState | null> {
    const tab = this.tabFor(tabId);
    if (!tab.url) return null;
    try {
      if (command === "play-pause") {
        const r = await this.call<string>(tab, "video.playPause");
        if (r === "blocked") {
          // The page plays only after a real click: click the video itself, then ask again if it is still paused.
          const at = await this.call<{ x: number; y: number } | null>(tab, "video.center");
          if (at) {
            await this.showForInput(tab);
            this.sendClick(this.contentsOf(tab), at.x, at.y, tab.zoom);
            await sleep(400);
            const s = await this.call<VideoState | null>(tab, "video.state");
            if (s && !s.playing) await this.call(tab, "video.playPause");
          }
        }
      } else if (command === "back" || command === "forward")
        await this.call(tab, "video.seek", { seconds: command === "back" ? -10 : 10 });
      else if (command === "captions") await this.call(tab, "video.captions");
      else if (command === "big-screen") this.setBigScreen(!this.bigScreen);
      await sleep(150);
      tab.video = await this.call<VideoState | null>(tab, "video.state");
      this.changed();
      return tab.video;
    } catch {
      return tab.video;
    }
  }

  setBigScreen(on: boolean): void {
    if (this.bigScreen === on) return;
    this.bigScreen = on;
    const tab = this.activeId === null ? null : this.tabs.get(this.activeId);
    if (tab?.view && tab.url) void this.call(tab, "video.fill", { on }).catch(() => undefined);
    this.changed();
  }

  // --------------------------------------------------------------------------------------------------
  // Messages from pages

  /** A reply or event from a page's preload: only from a tab's main frame. */
  onPageMessage(e: IpcMainEvent, kind: "reply" | "event", msg: unknown): void {
    const tabId = this.byContents.get(e.sender.id);
    if (tabId === undefined) return;
    const main = e.sender.mainFrame;
    const frame = e.senderFrame;
    if (!frame || frame.processId !== main.processId || frame.routingId !== main.routingId) return;
    if (kind === "reply") {
      this.channel.reply(e.sender.id, msg);
      return;
    }
    const tab = this.tabs.get(tabId);
    const m = (msg ?? {}) as { type?: unknown; field?: unknown; state?: unknown };
    if (!tab) return;
    if (m.type === "video") {
      const s = m.state as VideoState | null;
      tab.video =
        s && typeof s === "object" && typeof s.playing === "boolean"
          ? {
              playing: s.playing,
              time: Number(s.time) || 0,
              duration: Number(s.duration) || 0,
              captions: s.captions === "on" || s.captions === "off" ? s.captions : null,
            }
          : null;
      this.changed();
    } else if (m.type === "field" && m.field && typeof m.field === "object" && tabId === this.activeId) {
      const f = m.field as PageField;
      if (typeof f.ref !== "string" || typeof f.label !== "string") return;
      this.opts.emit({
        type: "field",
        tabId,
        field: {
          ...f,
          ref: f.ref.slice(0, 40),
          label: f.label.slice(0, 120),
          value: f.secure ? "" : String(f.value ?? "").slice(0, 5000),
        },
      });
    }
  }

  // --------------------------------------------------------------------------------------------------
  // Permissions and downloads

  private openPrompt(prompt: BrowserPrompt, onAnswer: (a: PromptAnswer) => void): void {
    const timer = setTimeout(
      () => this.settlePrompt(prompt.id, prompt.type === "download" ? "cancel" : "deny"),
      PROMPT_TIMEOUT_MS,
    );
    this.prompts.set(prompt.id, { prompt, settle: onAnswer, timer });
    this.opts.emit({ type: "prompt", prompt });
  }

  private settlePrompt(id: string, answer: PromptAnswer): void {
    const p = this.prompts.get(id);
    if (!p) return;
    this.prompts.delete(id);
    clearTimeout(p.timer);
    p.settle(answer);
    this.opts.emit({ type: "prompt.closed", id });
  }

  answer(id: string, answer: PromptAnswer): void {
    if (!["allow", "deny", "never", "save", "cancel"].includes(answer)) return;
    this.settlePrompt(String(id), answer);
  }

  get openPrompts(): BrowserPrompt[] {
    return [...this.prompts.values()].map((p) => p.prompt);
  }

  private async onPermission(
    contents: WebContents,
    permission: string,
    mediaTypes: string[] | undefined,
    requestingUrl: string | undefined,
  ): Promise<boolean> {
    const tabId = this.byContents.get(contents.id);
    if (tabId === undefined) return false;
    const route = routePermission(permission, mediaTypes);
    if (route.kind === "allow") return true;
    const origin = this.originOf(requestingUrl || contents.getURL());
    if (route.kind === "deny") {
      if (route.why === "camera")
        this.notice(
          tabId,
          `${origin ? siteLabel(origin) : "This page"} wanted the camera. AGENCY's camera follows your eyes, so pages can't use it.`,
          "info",
        );
      return false;
    }
    if (!origin) return false;
    const stored = this.store.permission(origin, route.permission);
    if (stored) return stored === "allow";
    // One question at a time per site and kind; a repeat while it is open is a no.
    if (
      [...this.prompts.values()].some(
        (p) =>
          p.prompt.type === "permission" &&
          p.prompt.origin === origin &&
          p.prompt.permission === route.permission,
      )
    )
      return false;
    return new Promise<boolean>((resolve) => {
      const id = `p${++this.promptSeq}`;
      this.openPrompt({ id, type: "permission", tabId, origin, permission: route.permission }, (a) => {
        if (a === "allow") this.store.setPermission(origin, route.permission, "allow");
        if (a === "never") this.store.setPermission(origin, route.permission, "deny");
        resolve(a === "allow");
      });
    });
  }

  /** Downloads wait here until the person says yes; only then do they move into Downloads. */
  private get pendingDir(): string {
    return join(this.opts.userData, "browser", "pending-downloads");
  }

  private onDownload(item: DownloadItem, contents: WebContents): void {
    const name = safeFilename(item.getFilename());
    const id = `d${++this.promptSeq}`;
    // A small file can finish before anyone is asked, so it never goes straight into Downloads.
    mkdirSync(this.pendingDir, { recursive: true, mode: 0o700 });
    const staged = join(this.pendingDir, `${id}-${name}`);
    item.setSavePath(staged);
    item.pause();
    const tabId = this.byContents.get(contents.id) ?? null;
    const total = item.getTotalBytes();
    const discard = () => rmSync(staged, { force: true });
    const keep = () => {
      try {
        const dir = this.opts.downloadsDir();
        mkdirSync(dir, { recursive: true });
        const final = uniqueName(name, (c) => existsSync(join(dir, c)));
        moveFile(staged, join(dir, final));
        this.notice(tabId, `Saved “${final}” in Downloads.`, "info");
      } catch {
        discard();
        this.notice(tabId, `“${name}” couldn't be saved in Downloads.`, "warn");
      }
    };
    this.openPrompt(
      {
        id,
        type: "download",
        tabId,
        origin: siteLabel(item.getURL()),
        filename: name,
        bytes: total > 0 ? total : null,
        program: isProgram(name),
      },
      (a) => {
        const state = item.getState();
        if (a !== "save" || state === "cancelled" || state === "interrupted") {
          if (state === "progressing") item.cancel();
          discard();
          if (a === "save") this.notice(tabId, `“${name}” didn't download.`, "warn");
          return;
        }
        if (state === "completed") return keep();
        item.once("done", (_e, done) => {
          if (done === "completed") keep();
          else {
            discard();
            this.notice(tabId, `“${name}” didn't download.`, "warn");
          }
        });
        item.resume();
      },
    );
  }

  // --------------------------------------------------------------------------------------------------
  // Settings, favourites, history

  get settings(): BrowserSettings {
    return this.store.settings;
  }

  setSettings(partial: unknown): BrowserSettings {
    const s = this.store.setSettings(partial);
    this.syncAgentSettings();
    return s;
  }

  /** The assistant's web limits follow these settings (agentweb.ts). */
  syncAgentSettings(): void {
    try {
      writeWebSettings(this.opts.agentSettingsFile, this.store.settings);
    } catch (e) {
      this.opts.log.error(`could not write the assistant's web settings: ${(e as Error).message}`);
    }
  }

  setFavourites(list: unknown) {
    return this.store.setFavourites(list, this.opts.internalOrigins());
  }

  async clearSiteData(): Promise<void> {
    await this.session.clearStorageData();
    await this.session.clearCache();
  }

  forgetSitePermission(origin: string, permission: SitePermission): void {
    this.store.forgetPermission(String(origin), permission);
  }

  flush(): void {
    this.store.flush();
  }

  // --------------------------------------------------------------------------------------------------
  // The assistant

  /** A task that may use the web is starting: AGENCY Browser is its browser. `current`: the page the person is on. */
  startAgentTask(current: boolean): void {
    this.agent.newTask();
    this.agentWantsCurrent = current;
    this.agentTabId = null;
    this.agentActive = false;
  }

  /** Stop: the assistant does nothing more in any tab until a new task. */
  stopAgent(): void {
    this.agent.stop();
    const tab = this.agentTabId === null ? null : this.tabs.get(this.agentTabId);
    if (tab?.view && !tab.view.webContents.isDestroyed())
      void this.call(tab, "agent.stop", { on: true }, 1_000).catch(() => undefined);
    this.agentEnded();
  }

  agentEnded(): void {
    if (!this.agentActive) return;
    this.agentActive = false;
    this.opts.emit({ type: "agent", tabId: this.agentTabId, active: false });
    this.changed();
  }

  agentCall(method: string, params: unknown): Promise<unknown> {
    return this.agent.call(method, params);
  }

  /** The tab the assistant works in: the person's current page, or a new tab it opens, and shows. */
  private async agentTab(): Promise<AgentTab> {
    let tab = this.agentTabId === null ? null : (this.tabs.get(this.agentTabId) ?? null);
    if (!tab) {
      const active = this.activeId === null ? null : this.tabs.get(this.activeId);
      if (active && (this.agentWantsCurrent || active.url === "")) tab = active;
      else {
        if (this.tabs.size >= MAX_TABS)
          throw new Error(`${MAX_TABS} tabs are open; close one so AGENCY can work.`);
        tab = this.tabFor(this.newTab());
      }
      this.agentTabId = tab.id;
      this.activateTab(tab.id);
      this.opts.emit({ type: "show" });
    }
    if (!this.agentActive) {
      this.agentActive = true;
      this.opts.emit({ type: "agent", tabId: tab.id, active: true });
      this.changed();
    }
    const t = tab;
    this.ensureView(t);
    if (!this.agent.isStopped) void this.call(t, "agent.stop", { on: false }, 1_000).catch(() => undefined);
    return {
      id: t.id,
      url: () => t.url,
      call: <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) =>
        this.call<T>(t, method, params ?? {}, timeoutMs).catch((e: unknown) => {
          // Page text never goes back to the agent: only these plain reasons.
          if (e instanceof PageCallError) throw new Error(e.message);
          if (e instanceof PageGone && e.navigated) throw new PageMovedOn();
          throw new Error(e instanceof PageGone ? e.message : "The page didn't answer.");
        }),
      load: async (url, timeoutMs) => {
        const navs = t.navs;
        this.load(t, url);
        await this.waitLoaded(t, navs, timeoutMs);
      },
      settle: async (timeoutMs) => {
        const navs = t.navs;
        if (await this.navigatedSince(t, navs, 400)) await this.waitLoaded(t, navs, timeoutMs);
        else await sleep(150);
      },
    };
  }

  private async waitLoaded(tab: Tab, navsBefore: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.agent.isStopped) return;
      if (tab.error) throw new Error(tab.error.message);
      if (tab.navs !== navsBefore && !tab.loading) {
        // The preload of the new page is ready once it answers.
        const ok = await this.call(tab, "ping", {}, 1_000).then(
          () => true,
          () => false,
        );
        if (ok) return;
      }
      await sleep(100);
    }
  }
}

/** Rename, or copy then remove when Downloads is on another disk. */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}
