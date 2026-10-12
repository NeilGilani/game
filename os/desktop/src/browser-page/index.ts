/**
 * AGENCY Browser's page preload. Runs sandboxed, in an isolated world, in the main frame of each web page.
 *
 * It exposes nothing to the page: no contextBridge, no globals. It only answers main's requests (read what can be
 * chosen, focus and fill a text box, click where the person chose, the reader text, the pop-up, the video) and
 * tells main when the person clicks into a text box or the video changes. Gaze data and AGENCY's state never come
 * here; main checks that every reply comes from this page.
 */

import { ipcRenderer } from "electron";
import { IPC } from "@agency/contracts";
import * as agent from "./agent";
import { hidePopup, popupInfo, resetPopups } from "./popup";
import { readArticle } from "./reader";
import {
  chooseOption,
  expectClick,
  fieldInfo,
  focusField,
  inspect,
  moveField,
  pageTargets,
  setFieldValue,
  settleClick,
  submitField,
  submitKind,
  typable,
  watchFieldFocus,
} from "./targets";
import { elementFor } from "../../../browser-bridge/src/extension/page/dom.ts";
import { fillView, playPause, seek, toggleCaptions, videoCenter, videoState, watchVideo } from "./video";

interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

const str = (p: Record<string, unknown>, k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");

function field(ref: string) {
  const el = elementFor(ref);
  if (!typable(el)) throw new Error("That text box is no longer on the page.");
  return el;
}

/** What scrolls at the middle of the view: an inner panel (a web app's list) or the page itself. */
function scroller(): Element {
  let el: Element | null = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  while (el && el !== document.body && el !== document.documentElement) {
    const s = getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
    el = el.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

function scrollState() {
  const se = document.scrollingElement ?? document.documentElement;
  return { y: Math.round(se.scrollTop), maxY: Math.max(0, Math.round(se.scrollHeight - innerHeight)) };
}

function scroll(p: Record<string, unknown>) {
  const target = scroller();
  const page = Math.round((target === document.scrollingElement ? innerHeight : target.clientHeight) * 0.85);
  if (p.by === "page") target.scrollBy({ top: page * (p.direction === -1 ? -1 : 1), behavior: "smooth" });
  else if (p.by === "edge")
    target.scrollTo({ top: p.direction === -1 ? 0 : target.scrollHeight, behavior: "smooth" });
  else {
    const dy = Number(p.amount);
    if (Number.isFinite(dy)) target.scrollBy({ top: Math.max(-4000, Math.min(4000, dy)), behavior: "instant" });
  }
  return scrollState();
}

async function run(method: string, p: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "ping":
      return "pong";
    case "targets":
      return {
        ...pageTargets(),
        viewport: { width: innerWidth, height: innerHeight },
        scroll: scrollState(),
      };
    case "inspect":
      return inspect(str(p, "ref"));
    case "expectClick":
      return expectClick(str(p, "ref"));
    case "settleClick":
      return settleClick();
    case "chooseOption":
      return chooseOption(str(p, "ref"), str(p, "option"));
    case "field.focus":
      return focusField(field(str(p, "ref")));
    case "field.info":
      return fieldInfo(field(str(p, "ref")));
    case "field.set":
      return setFieldValue(field(str(p, "ref")), str(p, "value"));
    case "field.move": {
      const next = moveField(field(str(p, "ref")), p.step === -1 ? -1 : 1);
      return next ? focusField(next) : null;
    }
    case "field.submitKind":
      return submitKind(field(str(p, "ref")));
    case "field.submit":
      submitField(field(str(p, "ref")));
      return true;
    case "scroll":
      return scroll(p);
    case "reader":
      return readArticle();
    case "popup":
      return popupInfo();
    case "popup.hide":
      return hidePopup();
    case "video.state":
      return videoState();
    case "video.playPause":
      return playPause();
    case "video.seek":
      seek(Number(p.seconds) || 0);
      return videoState();
    case "video.captions":
      toggleCaptions();
      return videoState();
    case "video.fill":
      fillView(p.on === true);
      return true;
    case "video.center":
      return videoCenter();
    case "agent.tree":
      return agent.tree(Number(p.maxNodes) || 600);
    case "agent.describe":
      return agent.describe(str(p, "ref"));
    case "agent.click":
      await agent.click(str(p, "ref"), typeof p.key === "string" ? p.key : undefined);
      return true;
    case "agent.type":
      await agent.type(str(p, "ref"), str(p, "text"));
      return true;
    case "agent.select":
      await agent.select(str(p, "ref"), str(p, "option"));
      return true;
    case "agent.captcha":
      return agent.captchaShowing();
    case "agent.stop":
      agent.setStopped(p.on === true);
      return true;
    default:
      throw new Error(`Unknown page method ${method}`);
  }
}

ipcRenderer.on(IPC.page, (_e, req: Request) => {
  if (!req || typeof req.id !== "number" || typeof req.method !== "string") return;
  run(req.method, req.params ?? {}).then(
    (result) => ipcRenderer.send(IPC.pageReply, { id: req.id, ok: true, result }),
    (err: unknown) =>
      ipcRenderer.send(IPC.pageReply, {
        id: req.id,
        ok: false,
        code: err instanceof agent.PageError ? err.code : "error",
        error: err instanceof Error ? err.message : String(err),
      }),
  );
});

resetPopups();
watchFieldFocus((f) => ipcRenderer.send(IPC.pageEvent, { type: "field", field: f }));
watchVideo((state) => ipcRenderer.send(IPC.pageEvent, { type: "video", state }));
