/**
 * AGENCY Browser (added in v0, additive): a web browser inside the Mac app, built to be used with the eyes.
 *
 * The shell draws the browser's controls; main shows the page in a WebContentsView in the shell's content area,
 * in its own session (`BROWSER_PARTITION`). Pages never see `window.agency`, gaze data or AGENCY's state: they
 * talk only to main, through a small preload that main checks on every message.
 *
 * Coordinates in `PageTarget.rect` and `PageFrame` are the page view's own (CSS pixels times the page zoom), with
 * the origin at the view's top-left corner, so the shell can draw them over the view's area directly.
 */

import type { ConsequentialKind } from "./agent";
import type { Unsubscribe } from "./host";
import type { ScreenRect } from "./targets";

/** The browser's own persistent session: cookies and sign-ins there never mix with AGENCY's windows. */
export const BROWSER_PARTITION = "persist:agency-browser";

/** Sites where AGENCY's assistant only reads unless the person approves each step. */
export type SensitiveKind = "bank" | "health" | "government" | "passwords" | "account";

export interface BrowserError {
  kind: "blocked" | "load" | "certificate" | "crashed";
  /** Plain words for the person. */
  message: string;
  url: string;
}

export interface VideoState {
  playing: boolean;
  /** Seconds. */
  time: number;
  duration: number;
  /** null: the video has no captions AGENCY can switch. */
  captions: "on" | "off" | null;
}

export interface BrowserTab {
  id: number;
  /** "" for a new tab (AGENCY's own start page, drawn by the shell). */
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** secure: https. insecure: plain http on the internet. local: this computer. new: the start page. */
  security: "secure" | "insecure" | "local" | "new";
  /** Page zoom, 1 = 100%. */
  zoom: number;
  error: BrowserError | null;
  video: VideoState | null;
  /** AGENCY's assistant is working in this tab. */
  agent: boolean;
  audible: boolean;
  sensitive: SensitiveKind | null;
}

export interface BrowserState {
  tabs: BrowserTab[];
  activeId: number | null;
  /** The page asked for full screen (a video): the shell keeps only a slim bar with Help and Stop. */
  bigScreen: boolean;
}

export type PageTargetKind = "link" | "button" | "field" | "choice" | "list" | "other";

/** Something on the page the person can choose: a link, button, text box, checkbox, menu item. */
export interface PageTarget {
  /** Stable for this page load. */
  ref: string;
  role: string;
  /** Accessible name, page text (untrusted). */
  name: string;
  rect: ScreenRect;
  kind: PageTargetKind;
  /** Password, code or card fields. */
  secure?: boolean;
}

/** The page held still for choosing: a picture of it and what can be chosen on it. */
export interface PageFrame {
  tabId: number;
  /** JPEG data URL of the page as it is now, or null when it couldn't be captured. */
  image: string | null;
  targets: PageTarget[];
  truncated: boolean;
  viewport: { width: number; height: number };
  scroll: { y: number; maxY: number };
}

/** A text box on the page, for the eye keyboard. */
export interface PageField {
  ref: string;
  label: string;
  /** Always "" for secure fields: AGENCY never reads or types passwords, codes or card numbers. */
  value: string;
  type: "text" | "email" | "tel" | "url" | "number" | "search" | "multiline" | "password" | "other";
  secure: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  /** What submitting is called here ("Search", "Sign in"), or null when there is nothing to submit. */
  submitLabel: string | null;
  maxLength: number | null;
}

export type ActivateResult =
  | { kind: "done"; navigated: boolean }
  | { kind: "field"; field: PageField }
  /** A list (select): the shell shows its options as big choices. */
  | { kind: "list"; ref: string; label: string; options: string[]; selected: string | null }
  /** The person's own choice looks consequential (pay, send, delete): ask "are you sure?" first. */
  | { kind: "confirm"; action: ConsequentialKind; label: string; origin: string }
  | { kind: "gone" }
  | { kind: "error"; message: string };

export type FieldOp =
  | { op: "set"; value: string }
  /** Scroll the box into the middle of the view again (after the eye keyboard made the view smaller). */
  | { op: "show" }
  | { op: "next" }
  | { op: "previous" }
  | { op: "submit"; confirmed?: boolean };

export type FieldResult =
  | { kind: "field"; field: PageField }
  | { kind: "done"; navigated: boolean }
  | { kind: "confirm"; action: ConsequentialKind; label: string; origin: string }
  | { kind: "gone" }
  | { kind: "error"; message: string };

export type ReaderBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  /** A list item; `ordered` is its number in an ordered list. */
  | { type: "item"; text: string; ordered: number | null }
  | { type: "image"; alt: string };

export interface ReaderArticle {
  title: string;
  byline: string | null;
  site: string | null;
  blocks: ReaderBlock[];
  /** Estimated reading time. */
  minutes: number;
  /** True when the page isn't an article and this is just its visible text. */
  plainText: boolean;
}

export interface PopupChoice {
  ref: string;
  label: string;
  /** decline: reject or necessary only. close: close or no thanks. accept: accept all. */
  tone: "decline" | "close" | "accept" | "other";
}

export interface PopupInfo {
  kind: "cookies" | "dialog" | "overlay";
  /** The start of what it says (untrusted). */
  text: string;
  choices: PopupChoice[];
}

export type VideoCommand = "play-pause" | "back" | "forward" | "captions" | "big-screen";

export type SitePermission = "microphone" | "camera" | "location" | "notifications" | "clipboard";

export type BrowserPrompt =
  | { id: string; type: "permission"; tabId: number; origin: string; permission: SitePermission }
  | {
      id: string;
      type: "download";
      tabId: number | null;
      origin: string;
      filename: string;
      bytes: number | null;
      /** A program or installer: a helper should decide. */
      program: boolean;
    };

/** allow / deny / never for permissions; save / cancel for downloads. */
export type PromptAnswer = "allow" | "deny" | "never" | "save" | "cancel";

export interface BrowserNotice {
  text: string;
  tone: "info" | "warn" | "danger";
}

export type BrowserEvent =
  | { type: "state"; state: BrowserState }
  | { type: "prompt"; prompt: BrowserPrompt }
  | { type: "prompt.closed"; id: string }
  | { type: "notice"; tabId: number | null; notice: BrowserNotice }
  /** The person or a helper clicked into a text box on the page: offer the eye keyboard. */
  | { type: "field"; tabId: number; field: PageField }
  /** The assistant started or stopped working in a tab, or needs a helper (a robot check, a sign-in). */
  | { type: "agent"; tabId: number | null; active: boolean; helperNeeded?: string; acting?: string }
  /** Main asks the shell to bring the browser to the front (a task or a flow opened a page in it). */
  | { type: "show" };

export interface Favourite {
  id: string;
  title: string;
  url: string;
}

export interface HistoryEntry {
  url: string;
  title: string;
  /** ms since epoch. */
  at: number;
}

export interface BrowserSettings {
  searchEngine: "google" | "duckduckgo" | "bing";
  /** A small built-in list of ad and tracker hosts is blocked. */
  blockAds: boolean;
  /** Where the assistant does web tasks: AGENCY Browser, or the person's own Chrome (AGENCY Bridge). */
  agentBrowser: "agency" | "chrome";
  /**
   * May the assistant open and read any website, and take reversible steps there (always under the guard: anything
   * consequential still needs the person's approval)? Off: practice sites only.
   */
  agentAnySite: boolean;
  /** Consequential actions for real on websites (each one approved by the person). Off: practice only. */
  realActions: boolean;
}

export interface SitePermissionEntry {
  origin: string;
  permission: SitePermission;
  decision: "allow" | "deny";
}

export interface OpenRequest {
  url: string;
  /** Open in a new tab (default: the current tab if it is the start page, else a new tab). */
  newTab?: boolean;
}

export type OpenResult = { ok: true; tabId: number } | { ok: false; error: string };

export type ScrollRequest =
  | { by: "page"; direction: 1 | -1 }
  | { by: "px"; amount: number }
  | { by: "edge"; direction: 1 | -1 };

/**
 * `window.agency.browser`, shell only. Every call is checked again in main: addresses, refs and values from the
 * shell are never trusted as safe just because the shell sent them.
 */
export interface BrowserApi {
  state(): Promise<BrowserState>;
  onEvent(listener: (event: BrowserEvent) => void): Unsubscribe;
  /** Where the page goes, in the shell's client coordinates (CSS pixels). null or visible=false hides it. */
  layout(rect: ScreenRect | null, visible: boolean): void;
  open(request: OpenRequest): Promise<OpenResult>;
  navigate(tabId: number, url: string): Promise<OpenResult>;
  back(tabId: number): Promise<void>;
  forward(tabId: number): Promise<void>;
  reload(tabId: number): Promise<void>;
  stopLoading(tabId: number): Promise<void>;
  /** Show the start page in this tab (Back returns to the page). */
  start(tabId: number): Promise<void>;
  newTab(): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  activateTab(tabId: number): Promise<void>;
  zoom(tabId: number, change: "in" | "out" | "reset"): Promise<number>;
  /** Pictures of the open tabs for the tab switcher (data URLs), by tab id. */
  thumbnails(): Promise<Record<number, string>>;
  /** Hold the page still for choosing: its picture and targets. */
  frame(tabId: number): Promise<PageFrame | null>;
  activate(tabId: number, ref: string, confirmed?: boolean): Promise<ActivateResult>;
  field(tabId: number, ref: string, op: FieldOp): Promise<FieldResult>;
  chooseOption(tabId: number, ref: string, option: string): Promise<boolean>;
  scroll(tabId: number, request: ScrollRequest): void;
  reader(tabId: number): Promise<ReaderArticle | null>;
  popup(tabId: number): Promise<PopupInfo | null>;
  /** Press one of the pop-up's own buttons, or hide it ("hide"). */
  closePopup(tabId: number, ref: string | "hide"): Promise<boolean>;
  video(tabId: number, command: VideoCommand): Promise<VideoState | null>;
  exitBigScreen(): void;
  answer(promptId: string, answer: PromptAnswer): void;
  history(): Promise<HistoryEntry[]>;
  clearHistory(): Promise<void>;
  favourites(): Promise<Favourite[]>;
  setFavourites(favourites: Favourite[]): Promise<Favourite[]>;
  settings(): Promise<BrowserSettings>;
  setSettings(settings: Partial<BrowserSettings>): Promise<BrowserSettings>;
  sitePermissions(): Promise<SitePermissionEntry[]>;
  forgetSitePermission(origin: string, permission: SitePermission): Promise<void>;
  /** Sign out of every site in AGENCY Browser (cookies and site data). */
  clearSiteData(): Promise<void>;
}
