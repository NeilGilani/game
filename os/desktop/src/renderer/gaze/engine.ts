/**
 * Hosts the @agency/gaze engine (Instance 2) in the hidden gaze window and publishes its GazeEvents to main.
 * MediaPipe's runtime and model are served from this app (agency://gaze/mediapipe, /models): nothing loads
 * from the network, and camera frames never leave this window.
 */

import type { AgencyApi } from "@agency/contracts";
import { GazeEngine, singleDisplay, WebcamProvider, type LandmarkerFactory } from "@agency/gaze";

declare global {
  interface Window {
    agency: AgencyApi;
  }
}

const createLandmarker: LandmarkerFactory = async () => {
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks("../mediapipe/wasm");
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: "../models/face_landmarker.task", delegate },
    runningMode: "VIDEO" as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    return { landmarker: await FaceLandmarker.createFromOptions(fileset, options("GPU")), delegate: "GPU" };
  } catch {
    return { landmarker: await FaceLandmarker.createFromOptions(fileset, options("CPU")), delegate: "CPU" };
  }
};

const engine = new GazeEngine({ screen: singleDisplay(screen.width, screen.height, devicePixelRatio) });
engine.on((event) => window.agency.gaze.publish(event));
const camera = new WebcamProvider(createLandmarker);
camera.onStatus((status, error) => {
  if (status === "error") console.error(`gaze camera error: ${error ?? "unknown"}`);
});
void engine.attach(camera);
// Main slows this window down while the shell (which tracks the eyes itself) is in front. Through the engine's
// governor, which sets the camera's rate on every frame (setting the camera directly was undone by the next frame)
// and never goes below the floor where Lifeline's help signal still works.
window.agency.gaze.onPace?.((fps) => engine.setFrameRateCap(Number.isFinite(fps) && fps > 0 ? fps : null));
