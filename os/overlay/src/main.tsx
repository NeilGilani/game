// Atkinson Hyperlegible backs the "Easy-read font" setting (tokens.css, data-font="easy-read").
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
// Design tokens shared with the shell (docs/os/DESIGN.md), then the overlay's own styles.
import "../../../frontend/src/styles/tokens.css";
import "./ui/overlay.css";
import { createRoot } from "react-dom/client";
import { OverlayController } from "./core/controller";
import { agencyHost, displayFromQuery, type AgencyHostExtras } from "./host/agencyHost";
import type { OverlayFeed, OverlayHost } from "./host/host";
import { OverlayApp } from "./ui/OverlayApp";

async function start() {
  let host: OverlayHost & OverlayFeed;
  let extras: AgencyHostExtras | null = null;
  if (window.agency) {
    const fallback = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    let display = displayFromQuery(window.location.search, fallback);
    if (display === fallback) display = (await window.agency.overlay.display())?.bounds ?? fallback;
    const real = agencyHost(window.agency, display);
    host = real;
    extras = real;
  } else {
    // A plain browser: the fake desktop demo (mouse = gaze, scripted app controls, fake Mac).
    const { startDemo } = await import("./demo/demo");
    host = startDemo();
  }
  const ctrl = new OverlayController(host, { display: host.display });
  host.onGaze((e) => ctrl.handleGaze(e));
  host.onTargets((s) => ctrl.setTargets(s));
  extras?.onStopAll(() => ctrl.stoppedElsewhere());
  extras?.onMode((m) => ctrl.applyMode(m));
  // Scanning and scroll repeats need time to pass even when no gaze samples arrive.
  setInterval(() => ctrl.tick(performance.now()), 100);
  (window as unknown as { __agencyOverlay?: unknown }).__agencyOverlay ??= { ctrl };
  createRoot(document.getElementById("root")!).render(<OverlayApp ctrl={ctrl} />);
}

void start();
