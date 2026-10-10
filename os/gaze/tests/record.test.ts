import { describe, expect, it } from "vitest";
import { ConsentRequiredError, PIPELINE_INDICES, Recorder, frameToFace, isRecording } from "../src/record";
import { extractFeatures } from "../src/landmarks";
import { ReplayProvider } from "../src/providers/replay";
import type { ProviderFrame } from "../src/providers/types";
import { person } from "./helpers";

describe("recording", () => {
  it("refuses to record without explicit consent", () => {
    expect(() => new Recorder(false)).toThrow(ConsentRequiredError);
  });

  it("stores only the landmarks the pipeline uses, never images", () => {
    const rec = new Recorder(true, { origin: "synthetic" });
    const f = person(1).render({
      gaze: { x: 500, y: 500 },
      head: { position: [0, 14, 60], yawDeg: 3, pitchDeg: 1, rollDeg: 0 },
      closure: 0,
    });
    rec.add({ t: 10, landmarks: f.landmarks, matrix: f.matrix, blink: f.blinkScore, aspect: f.aspect });
    rec.add({ t: 43, landmarks: null, aspect: f.aspect });
    const r = rec.finish();
    expect(isRecording(JSON.parse(JSON.stringify(r)))).toBe(true);
    expect(r.indices).toEqual([...PIPELINE_INDICES]);
    expect(r.frames[0]!.l!.length).toBe(PIPELINE_INDICES.length * 3);
    expect(r.frames[1]!.l).toBeNull();
    expect(Object.keys(r.frames[0]!).sort()).toEqual(["b", "l", "m", "t"]);
    // Replayed features match the live ones (to rounding).
    const live = extractFeatures(f.landmarks, f.aspect, f.matrix)!;
    const back = frameToFace(r, r.frames[0]!);
    const replayed = extractFeatures(back.landmarks!, back.aspect, back.matrix ?? undefined)!;
    expect(replayed.h).toBeCloseTo(live.h, 3);
    expect(replayed.rightN!.v).toBeCloseTo(live.rightN!.v, 3);
  });

  it("replays frames in order", () => {
    const rec = new Recorder(true, { origin: "synthetic" });
    for (let i = 0; i < 5; i++) rec.add({ t: i * 33, landmarks: null, aspect: 4 / 3 });
    const out: ProviderFrame[] = [];
    new ReplayProvider(rec.finish()).runSync((f) => out.push(f));
    expect(out.map((f) => (f.kind === "face" ? f.frame.t : -1))).toEqual([0, 33, 66, 99, 132]);
  });
});
