/**
 * The shared AGENCY OS contracts this package builds against (owned by Instance 1). Type-only,
 * so it works the same from the web app, the engine window and Node tests.
 */
export type {
  CalibrationQuality,
  GazeEvent,
  GazeSample,
  InputSource,
  TrackingState,
} from "../../contracts/src/gaze";
export type { ScreenRect, Target, TargetSnapshot } from "../../contracts/src/targets";
