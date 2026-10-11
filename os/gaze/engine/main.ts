/**
 * The gaze engine page for AGENCY OS's hidden engine window (agency://gaze/engine.html).
 *
 * Runs the camera, MediaPipe (local assets, GPU then CPU) and the GazeEngine, and publishes
 * contract GazeEvents with window.agency.gaze.publish (the preload API from os/desktop).
 *
 * Until a calibration exists, it publishes ONLY Lifeline's help-signal. The desktop's main
 * process switches from its mouse fallback to "engine" on the first event of any kind, and
 * the OS has no calibration channel yet, so publishing blinks or tracking before then would
 * take the mouse away from a helper without giving the person a working gaze pointer. The
 * help signal goes out regardless: Lifeline first. See INTEGRATION_REQUEST.md.
 */

import type { GazeEvent } from "@agency/contracts";
import { localCalibrationStore, startEngineHost } from "../src/host";
import { mediapipeLandmarker } from "../src/providers/mediapipe";
import type { DisplayInfo } from "../src/screen";

interface AgencyGazeApi {
  gaze?: { publish(event: GazeEvent): void; onPace?(listener: (fps: number) => void): () => void };
}

declare global {
  interface Window {
    agency?: AgencyGazeApi;
  }
}

/** Display bounds: from the query string when main provides them, else this screen. */
function displays(): DisplayInfo[] {
  const q = new URLSearchParams(location.search);
  const num = (k: string) => (q.has(k) ? Number(q.get(k)) : NaN);
  const [x, y, w, h] = [num("x"), num("y"), num("w"), num("h")];
  const bounds =
    [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0
      ? { x, y, width: w, height: h }
      : { x: 0, y: 0, width: screen.width, height: screen.height };
  return [{ id: "main", bounds, scaleFactor: devicePixelRatio || 2, primary: true, hasCamera: true }];
}

async function main(): Promise<void> {
  const publish = window.agency?.gaze?.publish;
  if (!publish) {
    console.warn("window.agency.gaze is missing: the engine runs but publishes nothing.");
  }
  const store = localCalibrationStore();
  host = await startEngineHost({
    displays: displays(),
    landmarker: mediapipeLandmarker(new URL("./", location.href).href),
    scheduler: "auto",
    store,
    send: (m) => {
      if (!publish) return;
      if (m.type.startsWith("host.")) {
        if (m.type === "host.error" || m.type === "host.status") console.info("[gaze]", JSON.stringify(m));
        return;
      }
      const event = m as GazeEvent;
      if (event.type === "help-signal" || host?.engine.calibration) publish(event);
    },
  });
  // Main slows this engine while the AGENCY window (which tracks the eyes itself) is in front.
  window.agency?.gaze?.onPace?.((fps) => host?.setFps(fps));
}

let host: Awaited<ReturnType<typeof startEngineHost>> | null = null;
void main().catch((err) => console.error("[gaze] engine failed to start", err));
