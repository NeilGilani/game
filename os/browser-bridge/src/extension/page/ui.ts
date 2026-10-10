/**
 * What the person sees in the page while AGENCY works: a banner "AGENCY is using this tab" with a big
 * Stop button, a highlight around the element being acted on, and an optional reading mode.
 *
 * The UI lives in a closed shadow root, so page scripts can't read or restyle it. If a page removes it,
 * it comes back. Stop accepts any click (a page faking a Stop press only stops AGENCY, which is safe).
 */

import { UI_HOST_ATTR } from "./dom.ts";

const FONT = `"Atkinson Hyperlegible", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
const BANNER_HEIGHT = 112;

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let bannerShown = false;
let stopped = false;
let onStop: () => void = () => undefined;
let keeper: MutationObserver | null = null;

function ensureHost(): ShadowRoot {
  if (host && root) {
    if (!host.isConnected) document.documentElement.appendChild(host);
    return root;
  }
  host = document.createElement("agency-bridge-ui");
  host.setAttribute(UI_HOST_ATTR, "");
  host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
<style>
  :host { all: initial; }
  .banner { position: fixed; top: 0; left: 0; right: 0; height: ${BANNER_HEIGHT}px; box-sizing: border-box;
    display: none; align-items: center; justify-content: space-between; gap: 24px; padding: 8px 24px;
    background: #14213d; color: #ffffff; font: 600 28px/1.2 ${FONT}; pointer-events: auto;
    border-bottom: 6px solid #fca311; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
  .banner.on { display: flex; }
  .banner.stopped { background: #7a1f1f; border-bottom-color: #ffd6d6; }
  .msg { display: flex; flex-direction: column; gap: 4px; }
  .sub { font: 400 20px/1.2 ${FONT}; opacity: .92; }
  button.stop { min-width: 180px; min-height: 96px; border: 4px solid #ffffff; border-radius: 16px;
    background: #d00000; color: #ffffff; font: 700 30px/1 ${FONT}; cursor: pointer; }
  button.stop:focus-visible { outline: 6px solid #fca311; outline-offset: 4px; }
  .hl { position: fixed; display: none; box-sizing: border-box; border: 5px solid #fca311; border-radius: 10px;
    box-shadow: 0 0 0 4px rgba(20,33,61,.85), 0 0 24px 6px rgba(252,163,17,.6); pointer-events: none; }
  .hl.on { display: block; }
  .hl .tag { position: absolute; left: -5px; bottom: 100%; margin-bottom: 8px; white-space: nowrap; max-width: 80vw;
    overflow: hidden; text-overflow: ellipsis; background: #14213d; color: #fff; font: 600 20px/1.2 ${FONT};
    padding: 6px 12px; border-radius: 8px; }
  .hl.below .tag { bottom: auto; top: 100%; margin: 8px 0 0; }
  @media (prefers-reduced-motion: no-preference) { .hl.on { transition: all .15s ease-out; } }
</style>
<div class="banner" role="region" aria-label="AGENCY">
  <div class="msg" aria-live="polite"><span class="title">AGENCY is using this tab</span>
    <span class="sub">It will ask you before anything important. Press Stop to take back control.</span></div>
  <button class="stop" type="button">Stop</button>
</div>
<div class="hl" aria-hidden="true"><span class="tag"></span></div>`;
  const stop = root.querySelector<HTMLButtonElement>("button.stop");
  stop?.addEventListener("click", (e) => {
    e.stopPropagation();
    onStop();
  });
  document.documentElement.appendChild(host);
  keeper = new MutationObserver(() => {
    if (host && !host.isConnected && (bannerShown || highlightOn)) document.documentElement.appendChild(host);
  });
  keeper.observe(document.documentElement, { childList: true });
  return root;
}

export function setStopHandler(fn: () => void): void {
  onStop = fn;
}

export function showBanner(): void {
  const r = ensureHost();
  bannerShown = true;
  stopped = false;
  const b = r.querySelector(".banner");
  b?.classList.add("on");
  b?.classList.remove("stopped");
  setText(
    r,
    "AGENCY is using this tab",
    "It will ask you before anything important. Press Stop to take back control.",
  );
  r.querySelector<HTMLButtonElement>("button.stop")!.hidden = false;
}

export function showStopped(): void {
  const r = ensureHost();
  bannerShown = true;
  stopped = true;
  const b = r.querySelector(".banner");
  b?.classList.add("on", "stopped");
  setText(r, "AGENCY stopped", "Nothing more will happen in this tab until you start a new task.");
  r.querySelector<HTMLButtonElement>("button.stop")!.hidden = true;
  hideHighlight();
}

export function hideBanner(): void {
  bannerShown = false;
  root?.querySelector(".banner")?.classList.remove("on");
  hideHighlight();
}

export function isStoppedShown(): boolean {
  return stopped;
}

/** The Stop button's rect in viewport CSS px, published as a protected eye-control target. */
export function stopButtonRect(): DOMRect | null {
  if (!bannerShown || stopped || !root) return null;
  return root.querySelector("button.stop")?.getBoundingClientRect() ?? null;
}

export function bannerHeight(): number {
  return bannerShown ? BANNER_HEIGHT : 0;
}

function setText(r: ShadowRoot, title: string, sub: string): void {
  const t = r.querySelector(".title");
  const s = r.querySelector(".sub");
  if (t) t.textContent = title;
  if (s) s.textContent = sub;
}

let highlightOn = false;
let followed: Element | null = null;
let raf = 0;

export function highlight(el: Element, label: string): void {
  const r = ensureHost();
  const hl = r.querySelector<HTMLElement>(".hl");
  const tag = r.querySelector<HTMLElement>(".hl .tag");
  if (!hl || !tag) return;
  tag.textContent = label;
  followed = el;
  highlightOn = true;
  hl.classList.add("on");
  const place = () => {
    if (!followed || !highlightOn) return;
    const b = followed.getBoundingClientRect();
    hl.style.left = `${b.left - 8}px`;
    hl.style.top = `${b.top - 8}px`;
    hl.style.width = `${b.width + 16}px`;
    hl.style.height = `${b.height + 16}px`;
    hl.classList.toggle("below", b.top - 52 < bannerHeight());
    raf = requestAnimationFrame(place);
  };
  cancelAnimationFrame(raf);
  place();
}

export function hideHighlight(): void {
  highlightOn = false;
  followed = null;
  cancelAnimationFrame(raf);
  root?.querySelector(".hl")?.classList.remove("on");
}

// ---------- Reading mode ----------

const READING_ID = "agency-bridge-reading-mode";

const READING_CSS = `
html { font-size: 150% !important; }
body { line-height: 1.6 !important; max-width: 52rem !important; margin-left: auto !important; margin-right: auto !important;
  padding: 0 1rem !important; font-family: "Atkinson Hyperlegible", -apple-system, sans-serif !important;
  letter-spacing: 0.01em !important; }
p, li, dd, dt, td, th, label, blockquote { font-size: 1.25rem !important; }
a[href] { display: inline-block !important; min-height: 64px !important; min-width: 96px !important; padding: 0.5em 0.75em !important;
  margin: 0.25em 0 !important; font-size: 1.3rem !important; text-decoration: underline !important;
  text-underline-offset: 0.2em !important; box-sizing: border-box !important; }
button, input, select, textarea, summary, [role="button"] { min-height: 64px !important; font-size: 1.25rem !important;
  padding: 0.5em 0.75em !important; }
input[type="checkbox"], input[type="radio"] { width: 40px !important; height: 40px !important; min-height: 0 !important; }
img, video { max-width: 100% !important; height: auto !important; }
*:focus-visible { outline: 5px solid #fca311 !important; outline-offset: 3px !important; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

export function setReadingMode(on: boolean): boolean {
  const existing = document.getElementById(READING_ID);
  if (on && !existing) {
    const s = document.createElement("style");
    s.id = READING_ID;
    s.textContent = READING_CSS;
    (document.head ?? document.documentElement).appendChild(s);
  } else if (!on && existing) {
    existing.remove();
  }
  return on;
}

export function readingModeOn(): boolean {
  return !!document.getElementById(READING_ID);
}
