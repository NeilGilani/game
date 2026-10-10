/**
 * A stand-alone page for the memory explorer, used by the memory end-to-end tests until the shell
 * routes #/memory (see os/memory/INTEGRATION_REQUEST.md). It uses the real input layer, so dwell
 * selection is exercised exactly as in the app.
 */
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../../styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { InputLayer } from "../../input/InputLayer";
import { AnnouncerProvider } from "../../state/announcer";
import { ConnectionProvider } from "../../state/connection";
import { InputProvider } from "../../state/input";
import { PreferencesProvider } from "../../state/preferences";
import { useRoute } from "../../state/router";
import { injectFrame, visionEngine } from "../../vision/tracker";
import { MemoryExplorer } from "../MemoryExplorer";

try {
  if (localStorage.getItem("agency.testHooks") === "1") {
    (window as unknown as Record<string, unknown>).__agency = {
      inject: (frame: Parameters<typeof injectFrame>[1]) => injectFrame(visionEngine(), frame),
    };
  }
} catch {
  /* storage unavailable */
}

function Harness() {
  const route = useRoute();
  const segments = route.segments[0] === "memory" ? route.segments.slice(1) : [];
  return (
    <main className="main" id="main" tabIndex={-1}>
      <MemoryExplorer segments={segments} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectionProvider>
      <PreferencesProvider>
        <AnnouncerProvider speak={false}>
          <InputProvider>
            <Harness />
            <InputLayer />
          </InputProvider>
        </AnnouncerProvider>
      </PreferencesProvider>
    </ConnectionProvider>
  </StrictMode>,
);
