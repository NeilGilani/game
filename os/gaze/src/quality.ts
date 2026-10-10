/** Frame and tracking quality checks, with plain-language guidance. */

import type { GazeFeatures } from "./landmarks";

export type QualityIssue =
  | "no-face"
  | "too-far"
  | "too-close"
  | "off-centre"
  | "head-turned"
  | "eyes-closed"
  | "too-dark"
  | "too-bright";

export const ISSUE_MESSAGES: Record<QualityIssue, string> = {
  "no-face": "I can't see a face. Sit facing the screen with your face in view.",
  "too-far": "You look far away. Move a little closer to the screen, or zoom the camera view.",
  "too-close": "You're very close to the camera. Move back a little.",
  "off-centre": "Move toward the middle of the camera view.",
  "head-turned": "Your head is turned. Face the screen if you can.",
  "eyes-closed": "Your eyes look closed.",
  "too-dark": "It's too dark. Turn on a light in front of you, not behind.",
  "too-bright": "There's bright light behind you or on the camera. Try reducing it.",
};

export function assessFace(features: GazeFeatures | null): QualityIssue[] {
  if (!features) return ["no-face"];
  const issues: QualityIssue[] = [];
  if (features.faceScale < 0.07) issues.push("too-far");
  if (features.faceScale > 0.32) issues.push("too-close");
  if (features.nose.x < 0.2 || features.nose.x > 0.8 || features.nose.y < 0.15 || features.nose.y > 0.85) {
    issues.push("off-centre");
  }
  if (Math.abs(features.pose.yaw) > 35 || Math.abs(features.pose.pitch) > 35) issues.push("head-turned");
  return issues;
}

export function assessBrightness(meanLuma: number | null): QualityIssue | null {
  if (meanLuma === null) return null;
  if (meanLuma < 45) return "too-dark";
  if (meanLuma > 225) return "too-bright";
  return null;
}

/** Mean luminance (0..255) of RGBA pixel data, sampling every `step`th pixel. */
export function meanLuminance(pixels: Uint8ClampedArray, step = 4): number {
  let total = 0;
  let count = 0;
  for (let i = 0; i + 2 < pixels.length; i += 4 * step) {
    total += 0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!;
    count += 1;
  }
  return count ? total / count : 0;
}

/**
 * Confidence 0..1 that a frame's gaze estimate is usable: face present, eyes open,
 * reasonable distance and pose. Below ~0.5 the pointer is held and dwell pauses.
 */
export function trackingConfidence(features: GazeFeatures | null, blinkScore: number | null): number {
  if (!features) return 0;
  let c = 1;
  if (blinkScore !== null && blinkScore > 0.4) c *= 0.1;
  const yaw = Math.abs(features.pose.yaw);
  const pitch = Math.abs(features.pose.pitch);
  if (yaw > 25) c *= Math.max(0.2, 1 - (yaw - 25) / 20);
  if (pitch > 25) c *= Math.max(0.2, 1 - (pitch - 25) / 20);
  if (features.faceScale < 0.06) c *= 0.4;
  if (features.h < -0.2 || features.h > 1.2) c *= 0.3;
  return Math.max(0, Math.min(1, c));
}
