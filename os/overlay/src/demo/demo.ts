/**
 * Fake desktop for the browser, Playwright and demos: a pretend Mail window behind the overlay whose
 * controls are published as accessibility ("ax") targets, the mouse acting as gaze, and a fake Mac that
 * records presses. Nothing here touches a real app. Labelled "Simulated" on screen.
 */

import "./demo.css";
import type { GazeEvent, Target, TargetSnapshot } from "../contracts";
import { FakeHost } from "../host/fakeHost";
import type { OverlayFeed, OverlayHost } from "../host/host";

const HTML = `
<div class="fake-window" role="presentation">
  <div class="fake-sim">Simulated app · nothing here is real</div>
  <div class="fake-toolbar">
    <span data-ax="button" data-label="Reply" class="fake-tiny">↩</span>
    <span data-ax="button" data-label="Reply all" class="fake-tiny">↩↩</span>
    <span data-ax="button" data-label="Forward" class="fake-tiny">↪</span>
    <span data-ax="button" data-label="Archive" class="fake-tiny">▤</span>
    <span class="fake-spacer"></span>
    <span data-ax="button" data-label="New message" class="fake-btn">New message</span>
  </div>
  <div class="fake-body">
    <ul class="fake-list">
      <li data-ax="cell" data-label="Pharmacy: your refill is ready">Pharmacy: your refill is ready</li>
      <li data-ax="cell" data-label="Benefits office: letter">Benefits office: letter</li>
      <li data-ax="cell" data-label="Sam: photos from Sunday">Sam: photos from Sunday</li>
    </ul>
    <div class="fake-compose">
      <label>To <span data-ax="textfield" data-label="To" class="fake-field"></span></label>
      <label>Password (demo) <span data-ax="textfield" data-label="Password" data-secure="1" class="fake-field"></span></label>
      <span data-ax="link" data-label="Open the letter" class="fake-link">Open the letter</span>
    </div>
  </div>
  <ol class="fake-log" aria-label="What the fake Mac did" data-testid="fake-log"></ol>
</div>`;

function collectTargets(): Target[] {
  const out: Target[] = [];
  document.querySelectorAll<HTMLElement>("[data-ax]").forEach((el, i) => {
    const r = el.getBoundingClientRect();
    out.push({
      id: `ax-${i}`,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      role: el.dataset.ax ?? "button",
      label: el.dataset.label ?? "",
      source: "ax",
      owner: "com.apple.mail",
      secure: el.dataset.secure === "1" || undefined,
    });
  });
  return out;
}

export function startDemo(): OverlayHost & OverlayFeed {
  const desktop = document.getElementById("desktop")!;
  desktop.innerHTML = HTML;
  const log = desktop.querySelector<HTMLOListElement>(".fake-log")!;
  const host = new FakeHost({ phrases: ["Please turn me over", "I'm thirsty", "Thank you"], withDrag: true });
  const targets = () => collectTargets();
  const labelOf = (id: string) => targets().find((t) => t.id === id)?.label ?? id;
  const note = (text: string) => {
    const li = document.createElement("li");
    li.textContent = text;
    log.appendChild(li);
    while (log.children.length > 4) log.firstElementChild?.remove();
  };

  const baseNative = host.native;
  host.native = (async (method, params) => {
    const result = await baseNative(method, params);
    const p = params as Record<string, unknown>;
    if (method === "ax.press") note(`Pressed “${labelOf(String(p.targetId))}”`);
    else if (method === "input.type") note(`Typed ${String(p.text).length} character(s)`);
    else if (method === "input.click")
      note(`Clicked at ${Math.round(Number(p.x))}, ${Math.round(Number(p.y))}`);
    else if (method === "input.scroll") note("Scrolled a page");
    else if (method === "input.key") note(`Key: ${String(p.key)}`);
    return result;
  }) as typeof host.native;

  const gazeListeners = new Set<(e: GazeEvent) => void>();
  const targetListeners = new Set<(s: TargetSnapshot) => void>();
  const emit = (e: GazeEvent) => gazeListeners.forEach((l) => l(e));
  const publish = () => {
    const s: TargetSnapshot = {
      t: performance.now(),
      owner: "com.apple.mail",
      targets: targets(),
      truncated: false,
    };
    targetListeners.forEach((l) => l(s));
  };

  window.addEventListener("pointermove", (ev) =>
    emit({
      type: "sample",
      sample: {
        t: performance.now(),
        x: ev.clientX,
        y: ev.clientY,
        confidence: 1,
        fixation: true,
        source: "mouse",
      },
    }),
  );
  // Keep a resting mouse feeding samples, as a real gaze stream would.
  let last: { x: number; y: number } | null = null;
  window.addEventListener("pointermove", (ev) => (last = { x: ev.clientX, y: ev.clientY }));
  setInterval(() => {
    if (last) {
      emit({
        type: "sample",
        sample: {
          t: performance.now(),
          x: last.x,
          y: last.y,
          confidence: 1,
          fixation: true,
          source: "mouse",
        },
      });
    }
  }, 33);
  window.addEventListener("keydown", (ev) => {
    if (ev.key === " " && ev.target === document.body)
      emit({ type: "switch", t: performance.now(), source: "key" });
  });
  window.addEventListener("resize", publish);

  const testApi = {
    host,
    gaze: (x: number, y: number, confidence = 1) =>
      emit({
        type: "sample",
        sample: { t: performance.now(), x, y, confidence, fixation: true, source: "mouse" },
      }),
    publish,
  };
  (window as unknown as { __agencyOverlay?: unknown }).__agencyOverlay = testApi;

  return Object.assign(host, {
    display: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    onGaze(cb: (e: GazeEvent) => void) {
      gazeListeners.add(cb);
      return () => gazeListeners.delete(cb);
    },
    onTargets(cb: (s: TargetSnapshot) => void) {
      targetListeners.add(cb);
      requestAnimationFrame(publish);
      return () => targetListeners.delete(cb);
    },
  });
}
