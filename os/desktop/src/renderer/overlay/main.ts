/**
 * Built-in fallback overlay (until os/overlay is installed): a gaze cursor, dwell on targets from every source,
 * and the protected Help and Stop targets. Click-through everywhere except over Help and Stop.
 */

import type { AgencyApi, GazeSample, OverlayDisplay, Target, TargetSnapshot } from "@agency/contracts";
import { DwellTracker } from "../shared/dwell";

declare global {
  interface Window {
    agency: AgencyApi;
  }
}

const agency = window.agency;
const params = new URLSearchParams(location.search);
let display: OverlayDisplay = {
  id: Number(params.get("display") ?? 0),
  bounds: {
    x: Number(params.get("x") ?? 0),
    y: Number(params.get("y") ?? 0),
    width: innerWidth,
    height: innerHeight,
  },
  scaleFactor: Number(params.get("scale") ?? 1),
  primary: true,
};
void agency.overlay.display().then((d) => d && (display = d));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cursor = $("cursor");
const statusEl = $("status");
const layer = $("dwell-layer");
const helpBtn = $<HTMLButtonElement>("help");
const stopBtn = $<HTMLButtonElement>("stop");

let paused = false;
let snapshot: TargetSnapshot = { t: 0, owner: null, targets: [], truncated: false };
let statusTimer: number | undefined;

function say(text: string): void {
  statusEl.textContent = text;
  statusEl.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => statusEl.classList.remove("show"), 4000);
}

async function help(): Promise<void> {
  say("Calling for help…");
  const r = await agency.lifeline.help("help_button");
  say(
    r.delivered
      ? "Help is on the way. Your helpers have been told."
      : "Trying to reach your helpers. AGENCY keeps trying.",
  );
}

async function stop(): Promise<void> {
  const r = await agency.stopAll();
  say(r.native === "failed" ? "Stopped AGENCY. Some input may still be finishing." : "Stopped.");
}

agency.onStopAll(() => say("Stopped."));

// Protected targets in global points, from their on-screen position.
function protectedTargets(): Target[] {
  return [
    { el: helpBtn, id: "overlay.help", label: "Help" },
    { el: stopBtn, id: "overlay.stop", label: "Stop" },
  ].map(({ el, id, label }) => {
    const r = el.getBoundingClientRect();
    return {
      id,
      label,
      role: "button",
      source: "overlay" as const,
      protected: true,
      rect: { x: display.bounds.x + r.left, y: display.bounds.y + r.top, width: r.width, height: r.height },
    };
  });
}

const dwell = new DwellTracker({ dwellMs: 1000 });

function select(target: Target): void {
  if (target.id === "overlay.help") return void help();
  if (target.id === "overlay.stop") return void stop();
  if (paused || target.secure) return;
  const cx = target.rect.x + target.rect.width / 2;
  const cy = target.rect.y + target.rect.height / 2;
  if (target.source === "ax") {
    agency.native
      .call("ax.press", { targetId: target.id })
      .then((r) => (r.ok ? undefined : agency.native.call("input.click", { x: cx, y: cy })))
      .catch(() => say("That didn't work. Try again or use Stop."));
  } else {
    agency.native.call("input.click", { x: cx, y: cy }).catch(() => say("That didn't work."));
  }
}

function onSample(s: GazeSample): void {
  const lx = s.x - display.bounds.x;
  const ly = s.y - display.bounds.y;
  const onThisDisplay = lx >= 0 && ly >= 0 && lx < display.bounds.width && ly < display.bounds.height;
  cursor.style.display = onThisDisplay && s.source !== "mouse" ? "block" : "none";
  cursor.style.left = `${lx}px`;
  cursor.style.top = `${ly}px`;
  const candidates = [...protectedTargets(), ...(paused ? [] : snapshot.targets)];
  const result = dwell.update(s, candidates);
  renderDwell(result.current, result.progress);
  if (result.selected) select(result.selected);
}

function renderDwell(target: Target | null, progress: number): void {
  helpBtn.style.setProperty("--progress", target?.id === "overlay.help" ? String(progress) : "0");
  stopBtn.style.setProperty("--progress", target?.id === "overlay.stop" ? String(progress) : "0");
  layer.replaceChildren();
  if (!target || target.source === "overlay") return;
  const box = document.createElement("div");
  box.className = "dwell-target";
  box.style.left = `${target.rect.x - display.bounds.x}px`;
  box.style.top = `${target.rect.y - display.bounds.y}px`;
  box.style.width = `${target.rect.width}px`;
  box.style.height = `${target.rect.height}px`;
  box.style.setProperty("--progress", String(progress));
  layer.append(box);
}

agency.gaze.onEvent((ev) => {
  if (ev.type === "sample") onSample(ev.sample);
  else if (ev.type === "help-progress" && ev.counted > 0) say(`Help signal: ${ev.counted} of 3`);
});
agency.targets.onSnapshot((s) => (snapshot = s));
agency.overlay.onMode((m) => {
  if (m.type === "paused") paused = m.on;
  if (m.type === "hide") document.body.style.visibility = "hidden";
  if (m.type === "show") document.body.style.visibility = "visible";
});

// Mouse: clicks pass through to the app below except over our own buttons.
for (const btn of [helpBtn, stopBtn]) {
  btn.addEventListener("mouseenter", () => agency.overlay.setInteractive(true));
  btn.addEventListener("mouseleave", () => agency.overlay.setInteractive(false));
}
helpBtn.addEventListener("click", () => void help());
stopBtn.addEventListener("click", () => void stop());
