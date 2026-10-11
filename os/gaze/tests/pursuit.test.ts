import { describe, expect, it } from "vitest";
import { gazeInput } from "../src/calibration/features";
import { predictModel } from "../src/calibration/model";
import { PursuitCalibration } from "../src/calibration/pursuit";
import { extractFeatures } from "../src/landmarks";
import { trackingConfidence } from "../src/quality";
import { MACBOOK_DISPLAY, SyntheticFace, TYPICAL_NOISE, WEBCAM_640, randomAnatomy } from "../src/synth/face";
import { HeadMotion } from "../src/synth/scenarios";

const DISPLAY = { x: 0, y: 0, width: MACBOOK_DISPLAY.widthPt, height: MACBOOK_DISPLAY.heightPt };

describe("5-second eye scan (smooth pursuit), simulated people", () => {
  it("takes about 5 seconds and lands within AGENCY's targets", () => {
    const errors: number[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const face = new SyntheticFace(randomAnatomy(seed), MACBOOK_DISPLAY, WEBCAM_640, TYPICAL_NOISE, seed);
      const head = new HeadMotion({ kind: "still", seed });
      const scan = new PursuitCalibration({ display: DISPLAY });
      expect(scan.durationMs).toBeLessThan(6500);
      for (let ms = 0; ms <= scan.durationMs; ms += 33) {
        // The eyes trail the light by about 100 ms.
        const f = face.render({ gaze: scan.at(ms - 100), head: head.at(ms), closure: 0 });
        const features = extractFeatures(f.landmarks, f.aspect, f.matrix);
        scan.add(ms, features, trackingConfidence(features, f.blinkScore), f.blinkScore);
      }
      const step = scan.finish();
      expect(step.kind).toBe("done");
      if (step.kind !== "done") continue;
      // Held-out check: fixations on a grid the scan never stopped at.
      for (const nx of [0.2, 0.4, 0.6, 0.8]) {
        for (const ny of [0.25, 0.5, 0.75]) {
          const target = { x: DISPLAY.width * nx, y: DISPLAY.height * ny };
          let sx = 0;
          let sy = 0;
          let n = 0;
          for (let i = 0; i < 15; i++) {
            const f = face.render({ gaze: target, head: head.at(9000 + i * 33), closure: 0 });
            const p = predictModel(
              step.result.model,
              gazeInput(extractFeatures(f.landmarks, f.aspect, f.matrix)!),
            );
            if (!p) continue;
            sx += p.x;
            sy += p.y;
            n += 1;
          }
          errors.push(Math.hypot(sx / n - target.x, sy / n - target.y));
        }
      }
    }
    const meanError = errors.reduce((a, b) => a + b, 0) / errors.length;
    console.log(`eye scan: mean error ${Math.round(meanError)} pt on held-out points (simulated)`);
    expect(meanError).toBeLessThan(96);
  });
});
