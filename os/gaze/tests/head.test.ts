/**
 * Head movement after the eye scan, with simulated people (synth/face.ts, synth/scenarios.ts).
 * Every number here is simulated: no real person or camera was measured.
 */
import { describe, expect, it } from "vitest";
import { PostureMonitor, fitHeadModel, postureExcess } from "../src/calibration/head";
import { extractFeatures } from "../src/landmarks";
import { mulMat3Vec, rotationYPR } from "../src/linalg";
import {
  MACBOOK_DISPLAY,
  NO_NOISE,
  NOMINAL_ANATOMY,
  SyntheticFace,
  WEBCAM_640,
  TYPICAL_NOISE,
  cameraToScreenPoint,
} from "../src/synth/face";
import { type HeadSource, POSTURES, type PostureName, PostureShift } from "../src/synth/scenarios";
import { DISPLAY, GRID, fixate, gridError, scannedEngine } from "./helpers";

describe("eye features when the head moves without the eyes turning in it", () => {
  const face = new SyntheticFace(NOMINAL_ANATOMY, MACBOOK_DISPLAY, WEBCAM_640, NO_NOISE);
  /** Eyes looking straight out of the face, head at `position` turned by yaw/pitch. */
  const straight = (position: [number, number, number], yawDeg = 0, pitchDeg = 0) => {
    const head = { position, yawDeg, pitchDeg, rollDeg: 0 };
    const dir = mulMat3Vec(rotationYPR((yawDeg * Math.PI) / 180, (pitchDeg * Math.PI) / 180, 0), [0, 0, -1]);
    const s = -position[2] / dir[2];
    const hit = cameraToScreenPoint(MACBOOK_DISPLAY, [position[0] + s * dir[0], position[1] + s * dir[1], 0]);
    const f = face.render({ gaze: hit, head, closure: 0 });
    return extractFeatures(f.landmarks, f.aspect, f.matrix)!;
  };

  it("stay put when the head moves sideways, down or closer (the camera's viewing angle is undone)", () => {
    const a = straight([0, 12, 60]);
    for (const p of [
      [8, 12, 60],
      [0, 20, 60],
      [-6, 6, 45],
      [5, 18, 75],
    ] as [number, number, number][]) {
      const b = straight(p);
      // Closer or further, the two eyes converge more or less (that's real), so compare both eyes' mean.
      const mean = (f: typeof a, k: "h" | "v") => (f.leftN![k] + f.rightN![k]) / 2;
      expect(Math.abs(mean(b, "h") - mean(a, "h"))).toBeLessThan(0.002);
      expect(Math.abs(mean(b, "v") - mean(a, "v"))).toBeLessThan(0.002);
      // Without undoing the viewing angle, sideways moves shift the iris by 10x that.
      if (p[0] !== 0) expect(Math.abs(b.right.h - a.right.h)).toBeGreaterThan(0.01);
    }
  });
});

const SEEDS = [1, 2, 3, 4];
const SPOTS = [
  [0.15, 0.2],
  [0.5, 0.2],
  [0.85, 0.2],
  [0.15, 0.5],
  [0.85, 0.5],
  [0.3, 0.8],
  [0.7, 0.8],
  [0.5, 0.5],
] as const;

describe("head moves after the 5-second scan (simulated people)", () => {
  it(
    "keeps tracking: every posture change lands close to the error at the scan's pose",
    { timeout: 120_000 },
    () => {
      const rows: Record<string, number> = {};
      for (const seed of SEEDS) {
        const { engine, face, head, endMs } = scannedEngine(seed, "still");
        let t = endMs + 1000;
        rows.home = (rows.home ?? 0) + gridError(engine, face, head, t) / SEEDS.length;
        for (const name of Object.keys(POSTURES) as PostureName[]) {
          t += 30_000;
          // Settled into the new posture 1.5 s before the first fixation.
          const moved = new PostureShift(head, POSTURES[name], t - 3000, 1500);
          rows[name] = (rows[name] ?? 0) + gridError(engine, face, moved, t) / SEEDS.length;
        }
      }
      console.log(
        `after the scan (simulated, ${SEEDS.length} people, mean error pt): ` +
          Object.entries(rows)
            .map(([k, v]) => `${k} ${Math.round(v)}`)
            .join(", "),
      );
      for (const [name, error] of Object.entries(rows)) {
        expect(error, name).toBeLessThan(Math.max(1.4 * rows.home!, rows.home! + 30));
        expect(error, name).toBeLessThan(100);
      }
    },
  );

  it("doesn't invent a head effect from a scan where the head barely moved", () => {
    const { engine, result } = scannedEngine(1, "still");
    const h = engine.headModel!;
    expect(h).toBeTruthy();
    expect(h.jx.every((v) => v === 0) && h.jy.every((v) => v === 0)).toBe(true);
    // The reference pose is where the person sat: about 60 cm away, 14 cm below the camera.
    expect(h.ref.tz).toBeGreaterThan(55);
    expect(h.ref.tz).toBeLessThan(65);
    expect(fitHeadModel(result.samples, result.model.config)).toEqual(h);
  });

  it(
    "learns from selections made turned and facing the screen, where the tracker leans with the head",
    { timeout: 120_000 },
    () => {
      // A tracker whose iris estimate shifts 0.04 px per degree of head turn (real landmark models have
      // pose-dependent biases the synthetic face otherwise lacks): turning 10 degrees costs ~40 pt.
      const noise = { ...TYPICAL_NOISE, irisBiasPerYawPx: [0.04, 0] as [number, number] };
      const sums = { homeBefore: 0, homeAfter: 0, turnedBefore: 0, turnedAfter: 0 };
      for (const seed of SEEDS) {
        const { engine, face, head, endMs } = scannedEngine(seed, "still", noise);
        let t = endMs + 1000;
        const measure = (src: HeadSource) => {
          const e = gridError(engine, face, src, t);
          t += GRID.length * 1600 + 2000;
          return e;
        };
        const turned = () => new PostureShift(head, POSTURES.turnRight, t - 1500, 800);
        sums.homeBefore += measure(head);
        sums.turnedBefore += measure(turned());
        // Everyday use: selections on 100 pt targets, in blocks facing the screen and turned towards one side.
        let n = 0;
        for (let block = 0; block < 6; block++) {
          t += 1000;
          const src = block % 2 ? new PostureShift(head, POSTURES.turnRight, t - 800, 800) : head;
          for (const [nx, ny] of SPOTS) {
            const target = { x: DISPLAY.width * nx, y: DISPLAY.height * ny };
            const start = t;
            fixate(engine, face, src, target, t, 1500);
            t += 1500;
            engine.selection(
              `s${n++}`,
              { x: target.x - 50, y: target.y - 50, width: 100, height: 100 },
              t,
              start,
            );
            t += 300;
          }
        }
        fixate(engine, face, head, { x: 735, y: 478 }, t, 5000); // the last selections are confirmed
        t += 5000;
        sums.homeAfter += measure(head);
        sums.turnedAfter += measure(turned());
      }
      const k = SEEDS.length;
      const r = (v: number) => Math.round(v / k);
      console.log(
        `learned head effect (simulated): turned ${r(sums.turnedBefore)} -> ${r(sums.turnedAfter)} pt, ` +
          `facing the screen ${r(sums.homeBefore)} -> ${r(sums.homeAfter)} pt`,
      );
      expect(sums.turnedAfter).toBeLessThan(0.75 * sums.turnedBefore);
      expect(sums.homeAfter / k).toBeLessThan(sums.homeBefore / k + 10);
    },
  );
});

describe("telling the person they've moved (simulated)", () => {
  type Said = { issue: string | null; message: string | null; t: number };
  function watch(name: PostureName | null, change?: ConstructorParameters<typeof PostureShift>[1], seed = 1) {
    const { engine, face, head, endMs } = scannedEngine(seed, "natural");
    const said: Said[] = [];
    engine.onAdvice((a) => {
      if (a.type === "posture") said.push({ issue: a.issue, message: a.message, t: a.t });
    });
    const t = endMs + 1000;
    const moved = new PostureShift(head, change ?? (name ? POSTURES[name] : {}), t + 2000, 1500);
    // Looking around the screen for 12 s: moves at 2 s, settled by 3.5 s.
    GRID.forEach((target, i) => fixate(engine, face, moved, target, t + i * 1000, 1000));
    return { said, engine, face, head, moved, t };
  }

  it(
    "says what to do, in plain words, when the person has moved far from the scan",
    { timeout: 60_000 },
    () => {
      const cases: [ConstructorParameters<typeof PostureShift>[1], string, string][] = [
        [{ d: [0, 0, -20] }, "lean-back", "Lean back a little."],
        [{ d: [0, 0, 20] }, "come-closer", "Come a little closer to the screen."],
        [{ d: [0, 12, 0] }, "sit-up", "Sit up a little."],
        [{ d: [-13, 0, 0] }, "move-left", "Move a little to your left."],
        [{ yawDeg: 24 }, "face-screen", "Turn your head back towards the screen."],
        [{ pitchDeg: 19 }, "chin-up", "Lift your chin a little."],
        [{ pitchDeg: -19 }, "chin-down", "Lower your chin a little."],
      ];
      for (const [change, issue, message] of cases) {
        const { said, engine, t } = watch(null, change);
        expect(said.length, issue).toBe(1);
        expect(said[0]).toMatchObject({ issue, message });
        // Not before the move, and within a couple of seconds of settling.
        expect(said[0]!.t).toBeGreaterThan(t + 3000);
        expect(said[0]!.t).toBeLessThan(t + 6500);
        expect(engine.last?.posture).toBe(issue);
      }
    },
  );

  it(
    "stays quiet for ordinary movement and the scenario postures that track fine",
    { timeout: 60_000 },
    () => {
      for (const name of ["leanIn", "slouch", "turnRight", "chinDown"] as PostureName[]) {
        expect(watch(name).said, name).toEqual([]);
      }
    },
  );

  it("takes the message away once the person is back", { timeout: 60_000 }, () => {
    const { engine, face, head, said, t } = watch(null, { d: [0, 0, -20] });
    expect(said.at(-1)?.issue).toBe("lean-back");
    for (let i = 0; i < 4; i++) fixate(engine, face, head, GRID[i]!, t + 13_000 + i * 1000, 1000);
    expect(said.at(-1)).toMatchObject({ issue: null, message: null });
    expect(engine.postureIssue).toBeNull();
  });

  it("thresholds: picks the biggest change and names it", () => {
    const ref = { yaw: 0, pitch: 0, tx: 0, ty: 14, tz: 60 };
    expect(postureExcess({ ...ref, tz: 42 }, ref)!.issue).toBe("lean-back");
    expect(postureExcess({ ...ref, ty: 25 }, ref)!.issue).toBe("sit-up");
    expect(postureExcess({ ...ref, ty: 3 }, ref)!.issue).toBe("sit-lower");
    expect(postureExcess({ ...ref, tx: 12 }, ref)!.issue).toBe("move-right");
    // MediaPipe's pitch grows as the head tilts down: tilted down, so "lift your chin".
    expect(postureExcess({ ...ref, pitch: 16 }, ref)!.issue).toBe("chin-up");
    expect(postureExcess(ref, ref)!.excess).toBe(0);
    // A glance away for half a second never reaches the person.
    const m = new PostureMonitor();
    for (let t = 0; t < 3000; t += 33) {
      const away = t > 1000 && t < 1500;
      expect(m.update(t, away ? { ...ref, yaw: 40 } : ref, ref)).toBeUndefined();
    }
  });
});
