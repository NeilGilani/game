/**
 * The real MediaPipe Face Landmarker for WebcamProvider, GPU delegate first with CPU fallback.
 * `assetBase` serves the wasm runtime (`<base>mediapipe/wasm`) and model (`<base>models/
 * face_landmarker.task`), vendored by frontend/scripts/vendor-mediapipe.mjs. Both load from the
 * local app, never a CDN, so the engine works offline and frames stay on the Mac.
 */

import type { LandmarkerFactory } from "./webcam";

export function mediapipeLandmarker(assetBase = "/"): LandmarkerFactory {
  return async () => {
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(`${assetBase}mediapipe/wasm`);
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath: `${assetBase}models/face_landmarker.task`, delegate },
      runningMode: "VIDEO" as const,
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      return { landmarker: await FaceLandmarker.createFromOptions(fileset, options("GPU")), delegate: "GPU" };
    } catch (gpuError) {
      console.warn("GPU delegate unavailable, using CPU", gpuError);
      return { landmarker: await FaceLandmarker.createFromOptions(fileset, options("CPU")), delegate: "CPU" };
    }
  };
}
