/**
 * The assistant's view of the page and its hands on it: the same page tree, action descriptions, clicks, typing
 * and list choices as the AGENCY Bridge's Chrome extension (os/browser-bridge/src/extension/page), so the agent's
 * guard sees exactly what it sees in Chrome. Each action highlights its element first.
 */

import * as act from "../../../browser-bridge/src/extension/page/actions.ts";
import { buildTree, isVisible } from "../../../browser-bridge/src/extension/page/dom.ts";

let stopped = false;

/** Stop: anything the assistant was about to do on this page doesn't happen. */
export function setStopped(on: boolean): void {
  stopped = on;
}

const isStopped = () => stopped;

const CAPTCHA_FRAME =
  /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha/i;
const CAPTCHA_TEXT =
  /\b(i'?m not a robot|verify (that )?you are (a )?human|are you a robot|prove you'?re human|security check|press (and|&) hold)\b/i;

/** A robot check (captcha) is showing: the assistant stops there and asks for a helper. */
export function captchaShowing(): boolean {
  for (const f of document.querySelectorAll("iframe")) {
    const src = f.getAttribute("src") ?? "";
    if (CAPTCHA_FRAME.test(src) && isVisible(f)) return true;
  }
  const body = document.body?.innerText.slice(0, 20_000) ?? "";
  return CAPTCHA_TEXT.test(body);
}

export function tree(maxNodes: number) {
  return buildTree(Math.max(10, Math.min(3000, maxNodes)));
}

export function describe(ref: string) {
  const m = act.describeMaterial(ref, "click");
  return { name: m.name, role: m.role, consequential: m.consequential, key: act.materialKey(m) };
}

export async function click(ref: string, expectKey: string | undefined): Promise<void> {
  await act.click(ref, expectKey, isStopped);
}

export async function type(ref: string, text: string): Promise<void> {
  await act.type(ref, text, true, false, undefined, isStopped);
}

export async function select(ref: string, option: string): Promise<void> {
  await act.select(ref, option, isStopped);
}

export { PageError } from "../../../browser-bridge/src/extension/page/actions.ts";
