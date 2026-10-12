/**
 * What AGENCY Browser keeps on this computer: its settings, the favourite sites on the start page, per-site
 * permission decisions (browser.json) and the history (history.json). Nothing here leaves the Mac. History keeps
 * addresses and titles only, never page content, and Clear history empties it.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BrowserSettings,
  Favourite,
  HistoryEntry,
  SitePermission,
  SitePermissionEntry,
} from "@agency/contracts";
import { decideNavigation } from "./policy";

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  searchEngine: "google",
  blockAds: true,
  agentBrowser: "agency",
  agentAnySite: true,
  realActions: false,
};

export const DEFAULT_FAVOURITES: Favourite[] = [
  { id: "google", title: "Google", url: "https://www.google.com/" },
  { id: "youtube", title: "YouTube", url: "https://www.youtube.com/" },
  { id: "wikipedia", title: "Wikipedia", url: "https://www.wikipedia.org/" },
  { id: "news", title: "News", url: "https://news.google.com/" },
  { id: "weather", title: "Weather", url: "https://weather.com/" },
  { id: "email", title: "Email", url: "https://mail.google.com/" },
];

export const MAX_FAVOURITES = 24;
export const MAX_HISTORY = 500;
const PERMISSIONS: readonly SitePermission[] = ["microphone", "camera", "location", "notifications", "clipboard"];

interface BrowserFile {
  settings: BrowserSettings;
  favourites: Favourite[];
  permissions: SitePermissionEntry[];
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/** Settings from anywhere (the file, the shell), checked field by field; anything odd keeps the current value. */
export function parseSettings(value: unknown, base: BrowserSettings = DEFAULT_BROWSER_SETTINGS): BrowserSettings {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const engine = v.searchEngine;
  return {
    searchEngine: engine === "google" || engine === "duckduckgo" || engine === "bing" ? engine : base.searchEngine,
    blockAds: typeof v.blockAds === "boolean" ? v.blockAds : base.blockAds,
    agentBrowser: v.agentBrowser === "agency" || v.agentBrowser === "chrome" ? v.agentBrowser : base.agentBrowser,
    agentAnySite: typeof v.agentAnySite === "boolean" ? v.agentAnySite : base.agentAnySite,
    realActions: typeof v.realActions === "boolean" ? v.realActions : base.realActions,
  };
}

/**
 * Favourites from the shell or the file: at most MAX_FAVOURITES, each a plain web address that a tab may open,
 * with a short title. Duplicates (same address) are dropped.
 */
export function parseFavourites(value: unknown, internalOrigins: readonly string[] = []): Favourite[] {
  if (!Array.isArray(value)) return [];
  const out: Favourite[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_FAVOURITES * 2)) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    if (typeof f.url !== "string" || typeof f.title !== "string") continue;
    const nav = decideNavigation(f.url.trim(), internalOrigins);
    if (!nav.ok || seen.has(nav.url)) continue;
    const title = f.title.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!title) continue;
    const id =
      typeof f.id === "string" && /^[\w-]{1,40}$/.test(f.id) ? f.id : `fav-${out.length}-${nav.url.length}`;
    seen.add(nav.url);
    out.push({ id, title, url: nav.url });
    if (out.length >= MAX_FAVOURITES) break;
  }
  return out;
}

function parsePermissions(value: unknown): SitePermissionEntry[] {
  if (!Array.isArray(value)) return [];
  const out: SitePermissionEntry[] = [];
  for (const raw of value.slice(0, 500)) {
    const p = raw as Partial<SitePermissionEntry> | null;
    if (!p || typeof p.origin !== "string" || !/^https?:\/\/[^/\s]+$/.test(p.origin)) continue;
    if (!PERMISSIONS.includes(p.permission as SitePermission)) continue;
    if (p.decision !== "allow" && p.decision !== "deny") continue;
    // The camera is AGENCY's: it is never stored as allowed for a page.
    if (p.permission === "camera" && p.decision === "allow") continue;
    out.push({ origin: p.origin, permission: p.permission as SitePermission, decision: p.decision });
  }
  return out;
}

function parseHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (h): h is HistoryEntry =>
        !!h &&
        typeof h === "object" &&
        typeof (h as HistoryEntry).url === "string" &&
        /^https?:\/\//.test((h as HistoryEntry).url) &&
        typeof (h as HistoryEntry).title === "string" &&
        typeof (h as HistoryEntry).at === "number",
    )
    .slice(0, MAX_HISTORY)
    .map((h) => ({ url: h.url.slice(0, 2000), title: h.title.slice(0, 200), at: h.at }));
}

export class BrowserStore {
  private readonly file: string;
  private readonly historyFile: string;
  private data: BrowserFile;
  private historyList: HistoryEntry[];
  private historyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dir: string) {
    this.file = join(dir, "browser.json");
    this.historyFile = join(dir, "history.json");
    const raw = (readJson(this.file) ?? {}) as Partial<Record<keyof BrowserFile, unknown>>;
    this.data = {
      settings: parseSettings(raw.settings),
      favourites: raw.favourites === undefined ? DEFAULT_FAVOURITES : parseFavourites(raw.favourites),
      permissions: parsePermissions(raw.permissions),
    };
    this.historyList = parseHistory(readJson(this.historyFile));
  }

  get settings(): BrowserSettings {
    return { ...this.data.settings };
  }

  setSettings(partial: unknown): BrowserSettings {
    this.data.settings = parseSettings(partial, this.data.settings);
    this.save();
    return this.settings;
  }

  get favourites(): Favourite[] {
    return this.data.favourites.map((f) => ({ ...f }));
  }

  setFavourites(list: unknown, internalOrigins: readonly string[]): Favourite[] {
    this.data.favourites = parseFavourites(list, internalOrigins);
    this.save();
    return this.favourites;
  }

  permission(origin: string, permission: SitePermission): "allow" | "deny" | null {
    return this.data.permissions.find((p) => p.origin === origin && p.permission === permission)?.decision ?? null;
  }

  setPermission(origin: string, permission: SitePermission, decision: "allow" | "deny"): void {
    if (permission === "camera" && decision === "allow") return;
    this.data.permissions = [
      ...this.data.permissions.filter((p) => !(p.origin === origin && p.permission === permission)),
      { origin, permission, decision },
    ];
    this.save();
  }

  forgetPermission(origin: string, permission: SitePermission): void {
    this.data.permissions = this.data.permissions.filter(
      (p) => !(p.origin === origin && p.permission === permission),
    );
    this.save();
  }

  get permissions(): SitePermissionEntry[] {
    return this.data.permissions.map((p) => ({ ...p }));
  }

  get history(): HistoryEntry[] {
    return this.historyList.map((h) => ({ ...h }));
  }

  /** A page the person visited (main frame, http or https). The same address again moves to the top. */
  addHistory(url: string, title: string, at = Date.now()): void {
    if (!/^https?:\/\//.test(url)) return;
    const entry = { url: url.slice(0, 2000), title: title.slice(0, 200), at };
    this.historyList = [entry, ...this.historyList.filter((h) => h.url !== entry.url)].slice(0, MAX_HISTORY);
    this.saveHistorySoon();
  }

  /** The title arrived after the page: update the newest entry for it. */
  titleHistory(url: string, title: string): void {
    const h = this.historyList.find((x) => x.url === url);
    if (!h || h.title === title) return;
    h.title = title.slice(0, 200);
    this.saveHistorySoon();
  }

  clearHistory(): void {
    this.historyList = [];
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    writeJson(this.historyFile, []);
  }

  flush(): void {
    if (this.historyTimer) {
      clearTimeout(this.historyTimer);
      this.historyTimer = null;
      writeJson(this.historyFile, this.historyList);
    }
  }

  private saveHistorySoon(): void {
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      writeJson(this.historyFile, this.historyList);
    }, 1_000);
  }

  private save(): void {
    writeJson(this.file, this.data);
  }
}
