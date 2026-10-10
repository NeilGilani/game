/**
 * The content script: runs in every page (isolated world), answers the service worker's page commands,
 * shows the banner and highlight, and publishes on-screen interactive elements for eye control.
 */

import type { ViewportGeometry } from "../geometry.ts";
import type { ViewportRect } from "../protocol.ts";
import * as act from "./page/actions.ts";
import { buildTree, interactiveInView, isSecure, refFor } from "./page/dom.ts";
import * as ui from "./page/ui.ts";

export type ToContent =
  | { kind: "page"; method: string; params: Record<string, unknown> }
  | { kind: "banner"; state: "on" | "off" | "stopped" }
  | { kind: "targets"; enabled: boolean }
  | { kind: "ping" };

export type FromContent =
  | { kind: "targets"; url: string; viewport: ViewportGeometry; items: WebItem[] }
  | { kind: "stop" }
  | { kind: "reading"; on: boolean };

export interface WebItem {
  ref: string;
  role: string;
  name: string;
  rect: ViewportRect;
  secure?: boolean;
  protected?: boolean;
}

export type ContentReply = { ok: true; result: unknown } | { ok: false; code: string; message: string };

declare global {
  interface Window {
    __agencyBridgeLoaded?: boolean;
  }
}

if (!window.__agencyBridgeLoaded) {
  window.__agencyBridgeLoaded = true;
  start();
}

function start(): void {
  let stopped = false;
  let targetsEnabled = false;
  const send = (m: FromContent) => {
    chrome.runtime.sendMessage(m).catch(() => undefined);
  };

  ui.setStopHandler(() => {
    stopped = true;
    ui.showStopped();
    send({ kind: "stop" });
  });

  // Escape also stops AGENCY while it is working in this tab.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && e.isTrusted && ui.stopButtonRect()) {
        stopped = true;
        ui.showStopped();
        send({ kind: "stop" });
      }
    },
    true,
  );

  async function runPage(method: string, p: Record<string, unknown>): Promise<unknown> {
    const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
    const ref = str("ref");
    const isStopped = () => stopped;
    switch (method) {
      case "tree":
        return buildTree(Math.max(10, Math.min(3000, Number(p.maxNodes) || 600)));
      case "describe": {
        if (!ref) throw new act.PageError("bad-request", "ref is required.");
        const m = act.describeMaterial(ref, p.action === "submit" ? "submit" : "click");
        return { material: m, key: act.materialKey(m) };
      }
      case "click":
        if (!ref) throw new act.PageError("bad-request", "ref is required.");
        await act.click(ref, str("expectKey"), isStopped);
        return { done: true };
      case "type":
        if (!ref) throw new act.PageError("bad-request", "ref is required.");
        return {
          done: true,
          value: await act.type(
            ref,
            str("text") ?? "",
            p.clear !== false,
            p.pressEnter === true,
            str("expectKey"),
            isStopped,
          ),
        };
      case "select":
        if (!ref) throw new act.PageError("bad-request", "ref is required.");
        return { done: true, value: await act.select(ref, str("option") ?? "", isStopped) };
      case "scroll":
        return {
          done: true,
          scroll: await act.scroll(
            ref,
            p.direction === "up" ? "up" : p.direction === "down" ? "down" : undefined,
            Number(p.pages) || 1,
          ),
        };
      case "waitFor":
        return act.waitFor(
          p.condition as never,
          Math.max(0, Math.min(120_000, Number(p.timeoutMs) || 10_000)),
          isStopped,
        );
      case "extractText":
        return act.extractText(ref, Math.max(100, Math.min(200_000, Number(p.maxChars) || 20_000)));
      case "extractTables":
        return act.extractTables();
      case "reading":
        send({ kind: "reading", on: ui.setReadingMode(p.on === true) });
        schedule();
        return { on: ui.readingModeOn() };
      case "info":
        return { url: location.href, title: document.title, reading: ui.readingModeOn() };
      default:
        throw new act.PageError("unknown-method", `Unknown page method ${method}.`);
    }
  }

  chrome.runtime.onMessage.addListener((msg: ToContent, sender, reply: (r: ContentReply) => void) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg.kind === "ping") {
      reply({ ok: true, result: "pong" });
      return false;
    }
    if (msg.kind === "banner") {
      if (msg.state === "on") {
        stopped = false;
        ui.showBanner();
      } else if (msg.state === "stopped") {
        stopped = true;
        ui.showStopped();
      } else ui.hideBanner();
      schedule();
      reply({ ok: true, result: null });
      return false;
    }
    if (msg.kind === "targets") {
      targetsEnabled = msg.enabled;
      lastSent = "";
      if (targetsEnabled) schedule();
      reply({ ok: true, result: null });
      return false;
    }
    runPage(msg.method, msg.params ?? {})
      .then((result) => reply({ ok: true, result }))
      .catch((e: unknown) => {
        ui.hideHighlight();
        if (e instanceof act.PageError) reply({ ok: false, code: e.code, message: e.message });
        else reply({ ok: false, code: "internal", message: e instanceof Error ? e.message : String(e) });
      });
    return true;
  });

  // ---------- Eye-control targets ----------

  let timer = 0;
  let lastSent = "";
  function schedule(): void {
    if (!targetsEnabled) return;
    clearTimeout(timer);
    timer = window.setTimeout(publish, 120);
  }

  function publish(): void {
    if (!targetsEnabled || document.visibilityState !== "visible") return;
    const items: WebItem[] = interactiveInView(300).map(({ el, role, name, rect }) => {
      const it: WebItem = { ref: refFor(el), role, name, rect };
      if (isSecure(el)) it.secure = true;
      return it;
    });
    const stop = ui.stopButtonRect();
    if (stop)
      items.unshift({
        ref: "agency-stop",
        role: "button",
        name: "Stop AGENCY",
        rect: { x: stop.x, y: stop.y, width: stop.width, height: stop.height },
        protected: true,
      });
    const vv = window.visualViewport;
    const viewport: ViewportGeometry = {
      innerWidth,
      innerHeight,
      vvOffsetLeft: vv?.offsetLeft ?? 0,
      vvOffsetTop: vv?.offsetTop ?? 0,
      vvScale: vv?.scale ?? 1,
    };
    const msg: FromContent = { kind: "targets", url: location.href, viewport, items };
    const key = JSON.stringify(msg);
    if (key === lastSent) return;
    lastSent = key;
    send(msg);
  }

  const forceRepublish = () => {
    lastSent = "";
    schedule();
  };
  addEventListener("scroll", schedule, { passive: true, capture: true });
  addEventListener("resize", forceRepublish);
  visualViewport?.addEventListener("resize", forceRepublish);
  visualViewport?.addEventListener("scroll", schedule);
  document.addEventListener("visibilitychange", forceRepublish);
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "disabled", "aria-hidden", "aria-expanded", "open"],
  });
  addEventListener("load", schedule);
  addEventListener("transitionend", schedule, true);

  // Ask the service worker whether targets are on (it also pushes changes).
  chrome.runtime
    .sendMessage({ kind: "hello-content" })
    .then((r: { targets?: boolean; banner?: "on" | "off" | "stopped"; reading?: boolean } | undefined) => {
      targetsEnabled = !!r?.targets;
      if (r?.banner === "on") ui.showBanner();
      if (r?.banner === "stopped") {
        stopped = true;
        ui.showStopped();
      }
      if (r?.reading) ui.setReadingMode(true);
      schedule();
    })
    .catch(() => undefined);
}
