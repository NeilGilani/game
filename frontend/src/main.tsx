import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { LookTarget, SyntheticEyes, SyntheticEyesOptions } from "./vision/synthetic";
import { injectFrame, visionEngine } from "./vision/tracker";

try {
  if (localStorage.getItem("agency.testHooks") === "1") {
    let eyes: SyntheticEyes | null = null;
    (window as unknown as Record<string, unknown>).__agency = {
      inject: (frame: Parameters<typeof injectFrame>[1]) => injectFrame(visionEngine(), frame),
      // A simulated person driving the real gaze engine (vision/synthetic.ts), loaded only here.
      eyes: async (options?: SyntheticEyesOptions) => {
        const { SyntheticEyes } = await import("./vision/synthetic");
        eyes?.stop();
        eyes = new SyntheticEyes(visionEngine(), options);
        eyes.start();
      },
      lookAt: (target: LookTarget) => eyes?.lookAt(target),
      closeEyes: (ms: number) => eyes?.close(ms),
      pointer: () => visionEngine().last?.pointer ?? null,
      // How many of RealEye's eye-image features the last camera frame had (0: none read).
      eyeFeatures: () => visionEngine().last?.eyes?.length ?? 0,
    };
  }
} catch {
  /* storage unavailable */
}

// The hosted web demo (VITE_WEB_DEMO=1) answers coordinator calls in the page; see demo/webDemo.ts.
const ready =
  import.meta.env.VITE_WEB_DEMO === "1"
    ? import("./demo/webDemo").then((m) => m.installWebDemo())
    : Promise.resolve();

void ready.then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
