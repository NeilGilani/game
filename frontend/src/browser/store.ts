/**
 * AGENCY Browser in the shell: the Mac app's `window.agency.browser` (os/contracts/src/browser.ts), and what it last
 * said (tabs, open questions, notices, the assistant), kept for whichever screen shows it. Outside the Mac app (the
 * web version, the web demo) there is no AGENCY Browser: web pages can't be shown inside a web page, so sites open
 * in a new tab of the person's browser instead.
 */
import { useSyncExternalStore } from "react";
import type {
  BrowserApi,
  BrowserEvent,
  BrowserNotice,
  BrowserPrompt,
  BrowserSettings,
  BrowserState,
  PageField,
} from "../../../os/contracts/src/browser";
import { fakeForced } from "../state/host";

export type * from "../../../os/contracts/src/browser";
export type { ConsequentialKind } from "../../../os/contracts/src/agent";

/** The Mac app's AGENCY Browser, or null (browser version, web demo, tests forcing it off, older Mac apps). */
export function browserApi(): BrowserApi | null {
  if (import.meta.env.VITE_WEB_DEMO === "1" || fakeForced("browser")) return null;
  const a = (window as unknown as { agency?: { role?: string; browser?: BrowserApi } }).agency;
  if (!a || a.role !== "shell" || !a.browser || typeof a.browser.open !== "function") return null;
  return a.browser;
}

export interface Notice extends BrowserNotice {
  id: number;
  tabId: number | null;
  at: number;
  /** The tab's page when it was said: a message about a page goes away when the tab moves on. */
  url: string | null;
}

export interface AgentActivity {
  active: boolean;
  tabId: number | null;
  acting: string | null;
  helperNeeded: string | null;
}

export interface BrowserSnapshot {
  state: BrowserState | null;
  prompts: BrowserPrompt[];
  notices: Notice[];
  agent: AgentActivity;
  /** The person clicked into a text box on the page (with a mouse): offer the eye keyboard. */
  field: { tabId: number; field: PageField; at: number } | null;
}

let snap: BrowserSnapshot = {
  state: null,
  prompts: [],
  notices: [],
  agent: { active: false, tabId: null, acting: null, helperNeeded: null },
  field: null,
};
const listeners = new Set<() => void>();
let noticeSeq = 0;
let started = false;
const showListeners = new Set<() => void>();

function set(next: Partial<BrowserSnapshot>): void {
  snap = { ...snap, ...next };
  for (const l of listeners) l();
}

function onEvent(e: BrowserEvent): void {
  switch (e.type) {
    case "state": {
      const urls = new Map(e.state.tabs.map((t) => [t.id, t.url]));
      set({
        state: e.state,
        notices: snap.notices.filter((n) => n.tabId === null || urls.get(n.tabId) === n.url),
      });
      return;
    }
    case "prompt":
      set({ prompts: [...snap.prompts.filter((p) => p.id !== e.prompt.id), e.prompt] });
      return;
    case "prompt.closed":
      set({ prompts: snap.prompts.filter((p) => p.id !== e.id) });
      return;
    case "notice":
      set({
        notices: [
          ...snap.notices,
          {
            ...e.notice,
            id: ++noticeSeq,
            tabId: e.tabId,
            at: Date.now(),
            url: e.tabId === null ? null : (snap.state?.tabs.find((t) => t.id === e.tabId)?.url ?? null),
          },
        ].slice(-4),
      });
      return;
    case "field":
      set({ field: { tabId: e.tabId, field: e.field, at: Date.now() } });
      return;
    case "agent":
      set({
        agent: {
          active: e.active,
          tabId: e.tabId,
          acting: e.active ? (e.acting ?? null) : null,
          helperNeeded: e.helperNeeded ?? (e.active ? snap.agent.helperNeeded : null),
        },
      });
      return;
    case "show":
      for (const l of showListeners) l();
      return;
  }
}

let settingsCache: BrowserSettings | null = null;

/** Where web tasks run, as far as the shell knows (main decides, with Chrome's bridge connection in mind). */
export function webTasksInBrowser(): boolean {
  return !!browserApi() && settingsCache?.agentBrowser !== "chrome";
}

export function rememberSettings(s: BrowserSettings): void {
  settingsCache = s;
}

/** Connects once (App mounts it): events from main, and the first state. */
export function startBrowserStore(): () => void {
  const api = browserApi();
  if (!api || started) return () => undefined;
  started = true;
  const off = api.onEvent(onEvent);
  void api.state().then(
    (state) => set({ state }),
    () => undefined,
  );
  void api.settings().then(rememberSettings, () => undefined);
  return () => {
    off();
    started = false;
  };
}

export function useBrowserSnapshot(): BrowserSnapshot {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snap,
  );
}

export function dismissNotice(id: number): void {
  set({ notices: snap.notices.filter((n) => n.id !== id) });
}

export function clearField(): void {
  if (snap.field) set({ field: null });
}

export function dropPrompt(id: string): void {
  set({ prompts: snap.prompts.filter((p) => p.id !== id) });
}

/** Main asked to bring the browser to the front (a task opened a page in it). */
export function onShowBrowser(listener: () => void): () => void {
  showListeners.add(listener);
  return () => showListeners.delete(listener);
}

/** For tests: the current snapshot. */
export function browserSnapshot(): BrowserSnapshot {
  return snap;
}
