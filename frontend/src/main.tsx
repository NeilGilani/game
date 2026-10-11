import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles/app.css";
import "./styles/layout.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { injectFrame, visionEngine } from "./vision/tracker";

try {
  if (localStorage.getItem("agency.testHooks") === "1") {
    (window as unknown as Record<string, unknown>).__agency = {
      inject: (frame: Parameters<typeof injectFrame>[1]) => injectFrame(visionEngine(), frame),
    };
  }
} catch {
  /* storage unavailable */
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
