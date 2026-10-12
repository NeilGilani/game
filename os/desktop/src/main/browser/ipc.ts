/**
 * The shell's calls to AGENCY Browser (IPC.browser, shell only), checked argument by argument before they reach the
 * browser host. Anything malformed is refused; addresses are checked again by the host's own rules.
 */

import type { WebContents } from "electron";
import type {
  FieldOp,
  PromptAnswer,
  ScreenRect,
  ScrollRequest,
  SitePermission,
  VideoCommand,
} from "@agency/contracts";
import type { BrowserHost } from "./host";

const VIDEO: readonly VideoCommand[] = ["play-pause", "back", "forward", "captions", "big-screen"];
const PERMISSIONS: readonly SitePermission[] = [
  "microphone",
  "camera",
  "location",
  "notifications",
  "clipboard",
];
const ANSWERS: readonly PromptAnswer[] = ["allow", "deny", "never", "save", "cancel"];

export function tabId(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error("bad tab");
  return v;
}

function text(v: unknown, max: number): string {
  if (typeof v !== "string") throw new Error("bad text");
  return v.slice(0, max);
}

export function rect(v: unknown): ScreenRect | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const n = [r.x, r.y, r.width, r.height];
  if (!n.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  return { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number };
}

export function fieldOp(v: unknown): FieldOp {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.op === "set") return { op: "set", value: text(o.value, 5000) };
  if (o.op === "next" || o.op === "previous" || o.op === "show") return { op: o.op };
  if (o.op === "submit") return { op: "submit", confirmed: o.confirmed === true };
  throw new Error("bad field operation");
}

export function scrollRequest(v: unknown): ScrollRequest {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.by === "px" && typeof o.amount === "number" && Number.isFinite(o.amount))
    return { by: "px", amount: Math.max(-4000, Math.min(4000, o.amount)) };
  if (o.by === "page" || o.by === "edge") return { by: o.by, direction: o.direction === -1 ? -1 : 1 };
  throw new Error("bad scroll");
}

export async function browserCall(
  b: BrowserHost,
  sender: WebContents,
  op: string,
  a: unknown[],
): Promise<unknown> {
  switch (op) {
    case "state":
      return b.state();
    case "layout":
      b.layout(sender, rect(a[0]), a[1] === true);
      return null;
    case "open": {
      const o = (a[0] ?? {}) as Record<string, unknown>;
      return b.open(text(o.url, 4000), o.newTab === true);
    }
    case "navigate":
      return b.navigate(tabId(a[0]), text(a[1], 4000));
    case "back":
      return b.back(tabId(a[0]));
    case "forward":
      return b.forward(tabId(a[0]));
    case "reload":
      return b.reload(tabId(a[0]));
    case "stopLoading":
      return b.stopLoading(tabId(a[0]));
    case "start":
      return b.start(tabId(a[0]));
    case "newTab":
      return b.newTab();
    case "closeTab":
      return b.closeTab(tabId(a[0]));
    case "activateTab":
      return b.activateTab(tabId(a[0]));
    case "zoom": {
      const c = a[1];
      if (c !== "in" && c !== "out" && c !== "reset") throw new Error("bad zoom");
      return b.zoom(tabId(a[0]), c);
    }
    case "thumbnails":
      return b.thumbnails();
    case "frame":
      return b.frame(tabId(a[0]));
    case "activate":
      return b.activate(tabId(a[0]), text(a[1], 40), a[2] === true);
    case "field":
      return b.field(tabId(a[0]), text(a[1], 40), fieldOp(a[2]));
    case "chooseOption":
      return b.chooseOption(tabId(a[0]), text(a[1], 40), text(a[2], 200));
    case "scroll":
      b.scroll(tabId(a[0]), scrollRequest(a[1]));
      return null;
    case "reader":
      return b.reader(tabId(a[0]));
    case "popup":
      return b.popup(tabId(a[0]));
    case "closePopup":
      return b.closePopup(tabId(a[0]), text(a[1], 40));
    case "video": {
      const c = a[1] as VideoCommand;
      if (!VIDEO.includes(c)) throw new Error("bad video command");
      return b.video(tabId(a[0]), c);
    }
    case "exitBigScreen":
      b.setBigScreen(false);
      return null;
    case "answer": {
      const ans = a[1] as PromptAnswer;
      if (!ANSWERS.includes(ans)) throw new Error("bad answer");
      b.answer(text(a[0], 40), ans);
      return null;
    }
    case "history":
      return b.store.history;
    case "clearHistory":
      b.store.clearHistory();
      return null;
    case "favourites":
      return b.store.favourites;
    case "setFavourites":
      return b.setFavourites(a[0]);
    case "settings":
      return b.settings;
    case "setSettings":
      return b.setSettings(a[0]);
    case "sitePermissions":
      return b.store.permissions;
    case "forgetSitePermission": {
      const p = a[1] as SitePermission;
      if (!PERMISSIONS.includes(p)) throw new Error("bad permission");
      b.forgetSitePermission(text(a[0], 300), p);
      return null;
    }
    case "clearSiteData":
      return b.clearSiteData();
    default:
      throw new Error("unknown browser operation");
  }
}
