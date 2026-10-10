/**
 * The extension's service worker: holds the native messaging connection to AGENCY, checks every command's
 * signature, enforces the safety policy, and carries out commands with the tabs API and the content script.
 */

import type { Target, TargetSnapshot } from "../../../contracts/src/index.ts";
import {
  SignedChannel,
  hmacKey,
  hmacVerify,
  hmac,
  randomHex,
  readyText,
  sha256Hex,
  tokenFingerprint,
  welcomeText,
} from "../auth.ts";
import { contentOrigin, toScreenRect } from "../geometry.ts";
import { detectInjection } from "../injection.ts";
import { classifyUrl, isOpenableUrl, originOf } from "../policy.ts";
import {
  BRIDGE_METHODS,
  BRIDGE_PROTOCOL_VERSION,
  NATIVE_HOST_NAME,
  UNTRUSTED_NOTICE,
  type ActionDescription,
  type BridgeError,
  type BridgeEvent,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
  type HostMessage,
  type PageTree,
  type ProtectedInfo,
  type TabInfo,
  type Untrusted,
  type WireMessage,
} from "../protocol.ts";
import type { ActionMaterial } from "./page/actions.ts";
import type { ContentReply, FromContent, ToContent } from "./content.ts";

const VERSION = chrome.runtime.getManifest().version;

class Fail extends Error {
  constructor(readonly error: BridgeError) {
    super(error.message);
  }
}
const fail = (code: BridgeError["code"], message: string, extra: Partial<BridgeError> = {}): never => {
  throw new Fail({ code, message, ...extra });
};

// ---------- Persistent state (survives the service worker being restarted) ----------

interface SessionState {
  stopped: boolean;
  sessions: Record<string, string>; // tabId -> taskId
  allowed: string[]; // origins the person allowed this browser session
  reading: Record<string, boolean>; // tabId -> on
  targets: boolean;
}

let state: SessionState = { stopped: false, sessions: {}, allowed: [], reading: {}, targets: true };
const loaded = chrome.storage.session.get("bridge").then((r) => {
  if (r.bridge) state = { ...state, ...(r.bridge as SessionState) };
});
async function save(): Promise<void> {
  await chrome.storage.session.set({ bridge: state });
}

async function extraProtectedHosts(): Promise<string[]> {
  const r = await chrome.storage.local.get("extraProtected");
  return Array.isArray(r.extraProtected) ? (r.extraProtected as string[]) : [];
}

// ---------- Native messaging and pairing ----------

type LinkState = "disconnected" | "waiting-for-agency" | "handshake" | "ready" | "mismatch" | "unpaired";
let port: chrome.runtime.Port | null = null;
let linkState: LinkState = "disconnected";
let channel: SignedChannel | null = null;
let pendingHello: { extNonce: string; key: CryptoKey } | null = null;
let backoff = 1000;

async function pairing(): Promise<{ token: string; fingerprint: string } | null> {
  const r = await chrome.storage.local.get("pairing");
  return (r.pairing as { token: string; fingerprint: string } | undefined) ?? null;
}

function setLink(s: LinkState): void {
  linkState = s;
  const badge = s === "ready" ? "" : s === "mismatch" || s === "unpaired" ? "!" : "…";
  chrome.action.setBadgeText({ text: badge }).catch(() => undefined);
  chrome.action
    .setBadgeBackgroundColor({ color: s === "mismatch" ? "#b00020" : "#14213d" })
    .catch(() => undefined);
  chrome.runtime.sendMessage({ kind: "link-state", state: s }).catch(() => undefined);
}

function connect(): void {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch {
    scheduleReconnect();
    return;
  }
  setLink("waiting-for-agency");
  port.onMessage.addListener((m: HostMessage | WireMessage) => {
    onHostMessage(m).catch((e) => console.warn("AGENCY Bridge:", e));
  });
  port.onDisconnect.addListener(() => {
    port = null;
    channel = null;
    pendingHello = null;
    if (linkState !== "mismatch") setLink("disconnected");
    scheduleReconnect();
  });
  backoff = 1000;
  pairing().then((p) => {
    if (!p) post({ k: "pair.request" });
  });
}

function scheduleReconnect(): void {
  setTimeout(connect, backoff);
  backoff = Math.min(30_000, backoff * 2);
}

function post(m: unknown): void {
  try {
    port?.postMessage(m);
  } catch {
    /* the disconnect handler reconnects */
  }
}

async function onHostMessage(m: HostMessage | WireMessage): Promise<void> {
  await loaded;
  switch (m.k) {
    case "host.pairing": {
      const existing = await pairing();
      if (!existing) {
        // Trust on first use: the host is launched by Chrome only for this extension, from the manifest
        // AGENCY installed. Later changes of token need the person to pair again in the options page.
        await chrome.storage.local.set({
          pairing: { token: m.token, fingerprint: await tokenFingerprint(m.token) },
        });
        setLink("waiting-for-agency");
      } else if (existing.token !== m.token) {
        setLink("mismatch");
      }
      return;
    }
    case "host.status":
      channel = null;
      if (m.agency === "connected") await startHandshake();
      else if (linkState !== "mismatch") setLink("waiting-for-agency");
      return;
    case "host.error":
      console.warn("AGENCY Bridge host:", m.message);
      return;
    case "welcome": {
      const hello = pendingHello;
      pendingHello = null;
      if (!hello) return;
      if (!(await hmacVerify(hello.key, welcomeText(hello.extNonce, m.appNonce), m.mac))) {
        // Someone without our token answered. Refuse everything until the person pairs again.
        setLink("mismatch");
        return;
      }
      const session = `${hello.extNonce}.${m.appNonce}`;
      channel = new SignedChannel(hello.key, session, ["res", "evt"]);
      post({ k: "ready", mac: await hmac(hello.key, readyText(session)) });
      setLink("ready");
      return;
    }
    case "cmd": {
      const ch = channel;
      if (!ch) return;
      const req = (await ch.open(m)) as BridgeRequest | null;
      if (!req) return; // forged, replayed or out of order: dropped without a reply
      const res = await handle(req);
      if (channel === ch) post(await ch.seal("res", res));
      return;
    }
    default:
      return;
  }
}

async function startHandshake(): Promise<void> {
  const p = await pairing();
  if (!p) {
    setLink("unpaired");
    post({ k: "pair.request" });
    return;
  }
  if (linkState === "mismatch") return;
  const extNonce = randomHex(16);
  pendingHello = { extNonce, key: await hmacKey(p.token) };
  setLink("handshake");
  post({ k: "hello", extNonce, protocol: BRIDGE_PROTOCOL_VERSION, extensionVersion: VERSION });
}

async function emit(ev: BridgeEvent): Promise<void> {
  const ch = channel;
  if (!ch) return;
  post(await ch.seal("evt", ev));
}

// ---------- Commands ----------

async function handle(req: BridgeRequest): Promise<BridgeResponse> {
  try {
    if (!BRIDGE_METHODS.includes(req.method)) fail("unknown-method", `Unknown method ${String(req.method)}.`);
    const params = (req.params && typeof req.params === "object" ? req.params : {}) as Record<
      string,
      unknown
    >;
    const result = await run(req.method, params);
    return { id: req.id, ok: true, result };
  } catch (e) {
    if (e instanceof Fail) return { id: req.id, ok: false, error: e.error };
    const message = e instanceof Error ? e.message : String(e);
    return { id: req.id, ok: false, error: { code: "internal", message } };
  }
}

const NEEDS_NOT_STOPPED = new Set<BridgeMethod>([
  "tabs.open",
  "tabs.activate",
  "tabs.navigate",
  "session.start",
  "page.tree",
  "page.describeAction",
  "page.click",
  "page.type",
  "page.select",
  "page.scroll",
  "page.waitFor",
  "page.extractText",
  "page.extractTables",
  "page.capture",
  "policy.requestAllowance",
]);

function num(p: Record<string, unknown>, k: string): number {
  const v = p[k];
  if (typeof v !== "number" || !Number.isInteger(v)) fail("bad-request", `${k} must be a whole number.`);
  return v as number;
}
function str(p: Record<string, unknown>, k: string): string {
  const v = p[k];
  if (typeof v !== "string") fail("bad-request", `${k} must be text.`);
  return v as string;
}
const optStr = (p: Record<string, unknown>, k: string): string | undefined =>
  typeof p[k] === "string" ? (p[k] as string) : undefined;

async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return fail("no-tab", `Tab ${tabId} is closed.`);
  }
}

async function protectedInfo(url: string): Promise<ProtectedInfo | null> {
  const c = classifyUrl(url, await extraProtectedHosts());
  if (!c) return null;
  return {
    category: c.category,
    allowed: c.category !== "browser-internal" && state.allowed.includes(originOf(url)),
  };
}

/** Refuses page access on protected sites the person hasn't allowed. */
async function guardTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await getTab(tabId);
  const url = tab.url ?? tab.pendingUrl ?? "";
  const info = await protectedInfo(url);
  if (info && !info.allowed) {
    fail(
      "protected-site",
      info.category === "browser-internal"
        ? "AGENCY can't work on browser pages."
        : `This is a protected site (${info.category}). Ask the person with policy.requestAllowance first.`,
      { category: info.category },
    );
  }
  return tab;
}

function untrusted<T>(url: string, data: T, scanText: string): Untrusted<T> {
  return {
    untrusted: true,
    notice: UNTRUSTED_NOTICE,
    origin: originOf(url),
    url,
    data,
    suspectedInjection: detectInjection(scanText),
  };
}

async function toContent(tabId: number, msg: ToContent): Promise<unknown> {
  const sendOnce = () =>
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }) as Promise<ContentReply | undefined>;
  let reply: ContentReply | undefined;
  try {
    reply = await sendOnce();
  } catch {
    // Pages opened before the extension was installed have no content script yet.
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] });
      reply = await sendOnce();
    } catch (e) {
      fail(
        "page-unavailable",
        `The page isn't ready or can't be used: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (!reply) return fail("page-unavailable", "The page didn't answer (it may be navigating).");
  if (!reply.ok) fail(reply.code as BridgeError["code"], reply.message);
  return (reply as { ok: true; result: unknown }).result;
}

const page = (tabId: number, method: string, params: Record<string, unknown> = {}) =>
  toContent(tabId, { kind: "page", method, params });

async function ensureSession(tabId: number, taskId = "agent"): Promise<void> {
  if (state.sessions[String(tabId)] === undefined) {
    state.sessions[String(tabId)] = taskId;
    await save();
  }
  await toContent(tabId, { kind: "banner", state: "on" }).catch(() => undefined);
}

async function describe(
  tabId: number,
  ref: string,
  action: "click" | "submit",
): Promise<{ desc: ActionDescription; key: string; url: string }> {
  const tab = await guardTab(tabId);
  const { material, key } = (await page(tabId, "describe", { ref, action })) as {
    material: ActionMaterial;
    key: string;
  };
  const fingerprint = await sha256Hex(`agency-bridge-action|${key}`);
  const details: Record<string, string> = {
    Site: material.origin,
    Page: material.path,
    Button: material.name || material.role,
  };
  for (const [k, v] of material.fields) details[`Field: ${k}`] = v;
  material.amounts.forEach((a, i) => (details[`Amount ${i + 1}`] = a));
  const host = new URL(material.origin).host;
  const verb = material.action === "submit" ? "Submit the form" : `Press “${material.name || material.role}”`;
  return {
    desc: {
      action: material.action,
      ref,
      consequential: material.consequential,
      summary: `${verb} on ${host}.`,
      details,
      fingerprint,
    },
    key,
    url: tab.url ?? "",
  };
}

/** Requires an approval bound to the exact action when it is consequential. Returns the key to re-check. */
async function approvalGate(
  tabId: number,
  ref: string,
  action: "click" | "submit",
  approved: string | undefined,
): Promise<string | undefined> {
  const { desc, key } = await describe(tabId, ref, action);
  if (!desc.consequential) return undefined;
  if (!approved)
    fail("approval-required", `${desc.summary} This needs the person's approval.`, { action: desc });
  if (approved !== desc.fingerprint)
    fail("approval-mismatch", "The page changed since the approval. Ask the person again.", { action: desc });
  return key;
}

function waitForNavigation(
  tabId: number,
  startedWithin: number,
  timeoutMs: number,
): Promise<{ navigated: boolean }> {
  return new Promise((resolve) => {
    let started = false;
    const done = (navigated: boolean) => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(t1);
      clearTimeout(t2);
      resolve({ navigated });
    };
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id !== tabId) return;
      if (info.status === "loading") started = true;
      if (started && info.status === "complete") done(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const t1 = setTimeout(() => {
      if (!started) done(false);
    }, startedWithin);
    const t2 = setTimeout(() => done(started), timeoutMs);
  });
}

async function run(method: BridgeMethod, p: Record<string, unknown>): Promise<unknown> {
  await loaded;
  if (state.stopped && NEEDS_NOT_STOPPED.has(method))
    fail(
      "stopped",
      "The person pressed Stop. Nothing more happens until they start a new task (session.reset).",
    );

  switch (method) {
    case "bridge.status":
      return {
        protocol: BRIDGE_PROTOCOL_VERSION,
        extensionVersion: VERSION,
        stopped: state.stopped,
        sessions: Object.entries(state.sessions).map(([tabId, taskId]) => ({ tabId: Number(tabId), taskId })),
        targetsEnabled: state.targets,
      };

    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      const out: TabInfo[] = [];
      for (const t of tabs) {
        if (t.id === undefined) continue;
        const url = t.url ?? t.pendingUrl ?? "";
        const prot = await protectedInfo(url);
        out.push({
          tabId: t.id,
          windowId: t.windowId,
          url: prot && !prot.allowed ? originOf(url) : url,
          title: prot && !prot.allowed ? "(protected site)" : (t.title ?? ""),
          active: !!t.active,
          protected: prot,
        });
      }
      return untrusted("about:tabs", out, out.map((t) => t.title).join("\n"));
    }

    case "tabs.open": {
      const url = str(p, "url");
      if (!isOpenableUrl(url)) fail("disallowed-url", "Only http and https pages can be opened.");
      const t = await chrome.tabs.create({ url, active: p.active !== false });
      if (t.id === undefined) fail("internal", "Chrome didn't open the tab.");
      await waitForNavigation(t.id!, 3000, 30_000);
      return { tabId: t.id };
    }

    case "tabs.activate": {
      const tabId = num(p, "tabId");
      const t = await getTab(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return { tabId };
    }

    case "tabs.navigate": {
      const tabId = num(p, "tabId");
      const url = str(p, "url");
      if (!isOpenableUrl(url)) fail("disallowed-url", "Only http and https pages can be opened.");
      await getTab(tabId);
      const nav = waitForNavigation(tabId, 3000, 30_000);
      await chrome.tabs.update(tabId, { url });
      await nav;
      const t = await getTab(tabId);
      return { tabId, url: t.url ?? url };
    }

    case "session.start": {
      const tabId = num(p, "tabId");
      await getTab(tabId);
      state.sessions[String(tabId)] = str(p, "taskId");
      await save();
      await toContent(tabId, { kind: "banner", state: "on" }).catch(() => undefined);
      return { tabId };
    }

    case "session.end": {
      const tabId = num(p, "tabId");
      delete state.sessions[String(tabId)];
      await save();
      await toContent(tabId, { kind: "banner", state: "off" }).catch(() => undefined);
      return { tabId };
    }

    case "session.reset": {
      state.stopped = false;
      await save();
      for (const tabId of Object.keys(state.sessions))
        await toContent(Number(tabId), { kind: "banner", state: "off" }).catch(() => undefined);
      state.sessions = {};
      await save();
      return { stopped: false };
    }

    case "page.tree": {
      const tabId = num(p, "tabId");
      const tab = await guardTab(tabId);
      await ensureSession(tabId);
      const tree = (await page(tabId, "tree", { maxNodes: p.maxNodes })) as PageTree;
      return untrusted(
        tab.url ?? tree.url,
        tree,
        tree.title + "\n" + tree.nodes.map((n) => n.name + " " + (n.value ?? "")).join("\n"),
      );
    }

    case "page.describeAction": {
      const tabId = num(p, "tabId");
      const { desc, url } = await describe(tabId, str(p, "ref"), p.action === "submit" ? "submit" : "click");
      return untrusted(url, desc, Object.values(desc.details).join("\n"));
    }

    case "page.click": {
      const tabId = num(p, "tabId");
      const ref = str(p, "ref");
      await guardTab(tabId);
      await ensureSession(tabId);
      const expectKey = await approvalGate(tabId, ref, "click", optStr(p, "approvedFingerprint"));
      const nav = waitForNavigation(tabId, 600, 30_000);
      await page(tabId, "click", { ref, expectKey });
      const { navigated } = await nav;
      const t = await getTab(tabId);
      return { done: true, navigated, url: t.url ?? "" };
    }

    case "page.type": {
      const tabId = num(p, "tabId");
      const ref = str(p, "ref");
      await guardTab(tabId);
      await ensureSession(tabId);
      const pressEnter = p.pressEnter === true;
      let expectKey: string | undefined;
      if (pressEnter) {
        // Enter submits the form as it will be after typing; only empty text can be bound in advance.
        if (str(p, "text") !== "")
          fail(
            "bad-request",
            "Type the text first without pressEnter, then describe the submit, get approval, and press Enter with empty text.",
          );
        expectKey = await approvalGate(tabId, ref, "submit", optStr(p, "approvedFingerprint"));
      }
      const nav = pressEnter ? waitForNavigation(tabId, 600, 30_000) : null;
      const r = (await page(tabId, "type", {
        ref,
        text: str(p, "text"),
        clear: p.clear !== false,
        pressEnter,
        expectKey,
      })) as {
        value: string;
      };
      await nav;
      return { done: true, value: r.value };
    }

    case "page.select": {
      const tabId = num(p, "tabId");
      await guardTab(tabId);
      await ensureSession(tabId);
      return page(tabId, "select", { ref: str(p, "ref"), option: str(p, "option") });
    }

    case "page.scroll": {
      const tabId = num(p, "tabId");
      await guardTab(tabId);
      await ensureSession(tabId);
      return page(tabId, "scroll", { ref: optStr(p, "ref"), direction: p.direction, pages: p.pages });
    }

    case "page.waitFor": {
      const tabId = num(p, "tabId");
      const timeoutMs = Math.max(
        0,
        Math.min(120_000, typeof p.timeoutMs === "number" ? p.timeoutMs : 10_000),
      );
      const cond = p.condition as { kind?: string } | undefined;
      if (!cond || typeof cond.kind !== "string") fail("bad-request", "condition is required.");
      await guardTab(tabId);
      if (cond!.kind === "navigation") {
        const r = await waitForNavigation(tabId, timeoutMs, timeoutMs);
        const t = await getTab(tabId);
        return { met: r.navigated, url: t.url ?? "" };
      }
      const deadline = Date.now() + timeoutMs;
      // The content script restarts on navigation, so retry until the deadline.
      for (;;) {
        try {
          const r = (await page(tabId, "waitFor", {
            condition: cond,
            timeoutMs: Math.max(0, deadline - Date.now()),
          })) as { met: boolean; ref?: string };
          const t = await getTab(tabId);
          return { ...r, url: t.url ?? "" };
        } catch (e) {
          if (!(e instanceof Fail) || e.error.code !== "page-unavailable" || Date.now() > deadline) throw e;
          if (state.stopped) fail("stopped", "Stopped while waiting.");
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }

    case "page.extractText": {
      const tabId = num(p, "tabId");
      const tab = await guardTab(tabId);
      await ensureSession(tabId);
      const r = (await page(tabId, "extractText", { ref: optStr(p, "ref"), maxChars: p.maxChars })) as {
        text: string;
        truncated: boolean;
      };
      return untrusted(tab.url ?? "", r, r.text);
    }

    case "page.extractTables": {
      const tabId = num(p, "tabId");
      const tab = await guardTab(tabId);
      await ensureSession(tabId);
      const r = (await page(tabId, "extractTables")) as Array<{
        caption: string;
        headers: string[];
        rows: string[][];
      }>;
      return untrusted(
        tab.url ?? "",
        r,
        r.map((t) => [t.caption, ...t.headers, ...t.rows.flat()].join(" ")).join("\n"),
      );
    }

    case "page.capture": {
      const tabId = num(p, "tabId");
      const tab = await guardTab(tabId);
      await ensureSession(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await new Promise((r) => setTimeout(r, 150));
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return untrusted(tab.url ?? "", { dataUrl }, "");
    }

    case "policy.check":
      return { protected: await protectedInfo(str(p, "url")) };

    case "policy.requestAllowance": {
      const tabId = num(p, "tabId");
      const tab = await getTab(tabId);
      const url = tab.url ?? "";
      const info = await protectedInfo(url);
      const origin = originOf(url);
      if (!info) return { allowed: true, origin };
      if (info.category === "browser-internal")
        fail("protected-site", "Browser pages can't be allowed.", { category: info.category });
      if (info.allowed) return { allowed: true, origin };
      const allowed = await askPerson(origin, info.category);
      if (allowed && !state.allowed.includes(origin)) state.allowed.push(origin);
      await save();
      await emit({ type: "allowance", origin, allowed });
      return { allowed, origin };
    }

    case "reading.set": {
      const tabId = num(p, "tabId");
      const on = p.on === true;
      await getTab(tabId);
      state.reading[String(tabId)] = on;
      await save();
      await page(tabId, "reading", { on });
      return { on };
    }

    case "targets.config": {
      state.targets = p.enabled === true;
      await save();
      await broadcastTargets();
      return { enabled: state.targets };
    }

    case "stop.all":
      await stopAll(false);
      return { stopped: true };
  }
  return fail("unknown-method", `Unknown method ${String(method)}.`);
}

async function stopAll(byPerson: boolean, tabId: number | null = null): Promise<void> {
  state.stopped = true;
  await save();
  for (const id of Object.keys(state.sessions))
    await toContent(Number(id), { kind: "banner", state: "stopped" }).catch(() => undefined);
  if (byPerson) await emit({ type: "stopped", by: "person", tabId });
}

// ---------- Allowance for protected sites: asked in an extension window AGENCY can't script ----------

const pendingAsks = new Map<string, { resolve: (v: boolean) => void; windowId?: number }>();

async function askPerson(origin: string, category: string): Promise<boolean> {
  const req = randomHex(8);
  const url = chrome.runtime.getURL(
    `allow.html?req=${req}&origin=${encodeURIComponent(origin)}&category=${encodeURIComponent(category)}`,
  );
  return new Promise((resolve) => {
    pendingAsks.set(req, { resolve });
    chrome.windows
      .create({ url, type: "popup", width: 760, height: 620, focused: true })
      .then((w) => {
        const p = pendingAsks.get(req);
        if (p && w?.id !== undefined) p.windowId = w.id;
      })
      .catch(() => {
        pendingAsks.delete(req);
        resolve(false);
      });
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [req, p] of pendingAsks)
    if (p.windowId === windowId) {
      pendingAsks.delete(req);
      p.resolve(false);
    }
});

// ---------- Messages from content scripts and extension pages ----------

chrome.runtime.onMessage.addListener(
  (msg: FromContent | { kind: string; [k: string]: unknown }, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    const fromExtensionPage =
      sender.url?.startsWith(chrome.runtime.getURL("")) && !sender.tab?.url?.startsWith("http");

    if (
      msg.kind === "allowance-answer" &&
      fromExtensionPage &&
      sender.url?.startsWith(chrome.runtime.getURL("allow.html"))
    ) {
      const m = msg as unknown as { req: string; allowed: boolean; trusted: boolean };
      const p = pendingAsks.get(m.req);
      if (p) {
        pendingAsks.delete(m.req);
        p.resolve(m.allowed === true && m.trusted === true);
        if (p.windowId !== undefined) chrome.windows.remove(p.windowId).catch(() => undefined);
      }
      return false;
    }

    if (msg.kind === "options-status" && fromExtensionPage) {
      pairing().then(async (pr) =>
        reply({
          link: linkState,
          paired: !!pr,
          fingerprint: pr?.fingerprint ?? null,
          extraProtected: await extraProtectedHosts(),
        }),
      );
      return true;
    }

    if (msg.kind === "options-forget-pairing" && fromExtensionPage) {
      chrome.storage.local.remove("pairing").then(() => {
        channel = null;
        setLink("unpaired");
        port?.disconnect();
        port = null;
        connect();
        reply({ ok: true });
      });
      return true;
    }

    const tabId = sender.tab?.id;
    if (tabId === undefined) return false;

    if (msg.kind === "hello-content") {
      loaded.then(() => {
        const inSession = state.sessions[String(tabId)] !== undefined;
        reply({
          targets: state.targets,
          banner: inSession ? (state.stopped ? "stopped" : "on") : "off",
          reading: !!state.reading[String(tabId)],
        });
      });
      return true;
    }

    if (msg.kind === "stop") {
      loaded.then(() => stopAll(true, tabId));
      return false;
    }

    if (msg.kind === "reading") {
      state.reading[String(tabId)] = (msg as { on: boolean }).on;
      save().then(() => emit({ type: "reading", tabId, on: (msg as { on: boolean }).on }));
      return false;
    }

    if (msg.kind === "targets" && sender.tab && sender.frameId === 0) {
      publishTargets(sender.tab, msg as Extract<FromContent, { kind: "targets" }>).catch(() => undefined);
      return false;
    }
    return false;
  },
);

async function publishTargets(
  tab: chrome.tabs.Tab,
  m: Extract<FromContent, { kind: "targets" }>,
): Promise<void> {
  await loaded;
  if (!state.targets || !tab.active || tab.id === undefined || !channel) return;
  const win = await chrome.windows.get(tab.windowId);
  if (
    win.state === "minimized" ||
    win.left === undefined ||
    win.top === undefined ||
    win.width === undefined ||
    win.height === undefined
  )
    return;
  const zoom = await chrome.tabs.getZoom(tab.id);
  const origin = contentOrigin(
    { left: win.left, top: win.top, width: win.width, height: win.height },
    m.viewport,
    zoom,
  );
  const owner = originOf(m.url);
  const targets: Target[] = [];
  for (const it of m.items) {
    const rect = toScreenRect(it.rect, origin, m.viewport);
    if (!rect) continue;
    const t: Target = {
      id: `web:${tab.id}:${it.ref}`,
      rect,
      role: it.role,
      label: it.name,
      source: "web",
      owner,
    };
    if (it.secure) t.secure = true;
    if (it.protected) t.protected = true;
    targets.push(t);
  }
  const snapshot: TargetSnapshot = { t: Date.now(), owner, targets, truncated: m.items.length >= 300 };
  await emit({ type: "targets", snapshot, tabId: tab.id });
}

async function broadcastTargets(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true });
  for (const t of tabs)
    if (t.id !== undefined)
      await toContent(t.id, { kind: "targets", enabled: state.targets }).catch(() => undefined);
}

// Window moves, tab switches and zoom changes all move targets on screen.
chrome.windows.onBoundsChanged.addListener(() => void broadcastTargets());
chrome.tabs.onActivated.addListener(() => void broadcastTargets());
chrome.tabs.onZoomChange.addListener(() => void broadcastTargets());
chrome.windows.onFocusChanged.addListener(() => void broadcastTargets());

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" || info.status === "complete") {
    void emit({ type: "tab.updated", tabId, url: tab.url ?? "", status: info.status });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  loaded.then(() => {
    delete state.sessions[String(tabId)];
    delete state.reading[String(tabId)];
    return save();
  });
});

// The toolbar button toggles reading mode for the person.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  const id = tab.id;
  loaded
    .then(() => {
      const on = !state.reading[String(id)];
      state.reading[String(id)] = on;
      return save().then(() => page(id, "reading", { on }));
    })
    .catch(() => undefined);
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
