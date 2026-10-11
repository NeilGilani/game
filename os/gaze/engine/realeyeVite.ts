import type { Plugin } from "vite";

/**
 * RealEye's package (its eye-image features: os/gaze/src/eyeImage.ts) also ships face detectors
 * that import MediaPipe statically. AGENCY runs MediaPipe itself and never uses those detectors,
 * so in builds their MediaPipe import becomes an empty module. MediaPipe then stays in its own
 * chunk, loaded only when the camera starts, instead of in every page load.
 */
export function realeyeWithoutMediapipe(): Plugin {
  const stub = "\0realeye-mediapipe-stub";
  return {
    name: "realeye-without-mediapipe",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "@mediapipe/tasks-vision" &&
        importer?.includes("@realeye-io/webcam-eyetracker-light-open")
      )
        return stub;
      return null;
    },
    load(id) {
      if (id !== stub) return null;
      return "export const FaceDetector = undefined;\nexport const FaceLandmarker = undefined;\nexport const FilesetResolver = undefined;\n";
    },
  };
}
