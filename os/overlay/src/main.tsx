import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./ui/overlay.css";
import { createRoot } from "react-dom/client";
import { OverlayController } from "./core/controller";
import { agencyHost } from "./host/agencyHost";
import type { OverlayFeed, OverlayHost } from "./host/host";
import { OverlayApp } from "./ui/OverlayApp";

async function start() {
  let host: OverlayHost & OverlayFeed;
  if (window.agency) {
    host = agencyHost(window.agency);
  } else {
    // A plain browser: the fake desktop demo (mouse = gaze, scripted app controls, fake Mac).
    const { startDemo } = await import("./demo/demo");
    host = startDemo();
  }
  const ctrl = new OverlayController(host, { display: host.display });
  host.onGaze((e) => ctrl.handleGaze(e));
  host.onTargets((s) => ctrl.setTargets(s));
  // Scanning and scroll repeats need time to pass even when no gaze samples arrive.
  setInterval(() => ctrl.tick(performance.now()), 100);
  (window as unknown as { __agencyOverlay?: unknown }).__agencyOverlay ??= { ctrl };
  createRoot(document.getElementById("root")!).render(<OverlayApp ctrl={ctrl} />);
}

void start();
