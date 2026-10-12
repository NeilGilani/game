import { describe, expect, it } from "vitest";
import type { GazeEvent } from "../src/contracts";
import { GazeEngine, TrackingMonitor, sampleConfidence } from "../src/engine";
import { FrameRateGovernor } from "../src/frameRate";
import { ExternalTrackerProvider, ScriptedTrackerDriver } from "../src/providers/external";
import { MouseProvider } from "../src/providers/mouse";
import type { ProviderFrame } from "../src/providers/types";
import { ScreenSpace, singleDisplay } from "../src/screen";
import { GazeScript, HeadMotion, readingFixations, simulate, type SimFrame } from "../src/synth/scenarios";
import { DISPLAY, person } from "./helpers";

const toFrame = (f: SimFrame): ProviderFrame => ({
  kind: "face",
  frame: {
    t: f.t,
    landmarks: f.frame.landmarks,
    matrix: f.frame.matrix,
    blink: f.frame.blinkScore,
    aspect: f.frame.aspect,
  },
});

function collect(engine: GazeEngine): GazeEvent[] {
  const events: GazeEvent[] = [];
  engine.on((e) => events.push(e));
  return events;
}

/** Calibrate an engine on synthetic person `seed` through its own CalibrationRun. */
async function calibratedEngine(seed: number, screen = singleDisplay(DISPLAY.width, DISPLAY.height)) {
  const engine = new GazeEngine({ screen });
  const face = person(seed);
  const head = new HeadMotion({ kind: "still", seed });
  const run = engine.startCalibration();
  let t = 0;
  let prev = { x: 735, y: 478 };
  for (let i = 0; i < 40; i++) {
    const step = run.next();
    if (step.kind !== "target") {
      if (step.kind === "done") run.apply(step.result);
      else throw new Error(step.reason);
      break;
    }
    const target = step.target;
    const done = run.collect(target.id);
    const script = new GazeScript([
      { x: prev.x, y: prev.y, durationMs: 1 },
      { x: target.x, y: target.y, durationMs: 3000 },
    ]);
    for (const f of simulate(face, script, head, { startMs: t, seed: i })) {
      engine.handle(toFrame(f));
      if ((await Promise.race([done, Promise.resolve(-1)])) >= 0) break;
    }
    await done;
    t += 3200;
    prev = target;
  }
  engine.endCalibration();
  return { engine, face, head, t };
}

describe("gaze engine", () => {
  it("calibrates through its own run and then emits samples in global points", async () => {
    const { engine, face, head, t } = await calibratedEngine(1);
    expect(engine.calibration).not.toBeNull();
    const events = collect(engine);
    const script = new GazeScript([{ x: 1100, y: 300, durationMs: 2000 }], { naturalBlinks: false });
    for (const f of simulate(face, script, head, { startMs: t + 1000 })) engine.handle(toFrame(f));
    const samples = events.flatMap((e) => (e.type === "sample" ? [e.sample] : []));
    expect(samples.length).toBeGreaterThan(40);
    const late = samples.slice(-20);
    const mx = late.reduce((s, p) => s + p.x, 0) / late.length;
    const my = late.reduce((s, p) => s + p.y, 0) / late.length;
    expect(Math.hypot(mx - 1100, my - 300)).toBeLessThan(200);
    expect(late.every((s) => s.confidence >= 0.5 && s.source === "webcam-gaze")).toBe(true);
    expect(late.filter((s) => s.fixation).length).toBeGreaterThan(15);
  });

  it("fires Lifeline's help signal on three long blinks, uncalibrated, in head mode, and while paused", () => {
    for (const setup of ["uncalibrated", "head", "paused"] as const) {
      const engine = new GazeEngine({
        screen: singleDisplay(1470, 956),
        mode: setup === "head" ? "head" : "gaze",
      });
      if (setup === "paused") engine.setPaused(true);
      const events = collect(engine);
      const script = new GazeScript([{ x: 700, y: 400, durationMs: 9000 }], {
        naturalBlinks: false,
        closures: [
          [1000, 1000],
          [2800, 1000],
          [4600, 1000],
        ],
      });
      for (const f of simulate(person(2), script, new HeadMotion({ kind: "still" })))
        engine.handle(toFrame(f));
      const signals = events.filter((e) => e.type === "help-signal");
      expect(signals.length, setup).toBe(1);
      const progress = events.flatMap((e) => (e.type === "help-progress" ? [e.counted] : []));
      expect(progress.slice(0, 3), setup).toEqual([1, 2, 3]);
    }
  });

  it("raises no help signal during ten minutes of reading with natural blinks", () => {
    const engine = new GazeEngine({ screen: singleDisplay(1470, 956) });
    const events = collect(engine);
    let t = 0;
    for (let page = 0; t < 10 * 60_000; page++) {
      const script = new GazeScript(readingFixations(DISPLAY, { seed: page, lines: 20 }), { seed: page });
      for (const f of simulate(person(3), script, new HeadMotion({ kind: "natural", seed: page }), {
        startMs: t,
        fps: 15,
      }))
        engine.handle(toFrame(f));
      t += script.totalMs;
    }
    expect(t).toBeGreaterThanOrEqual(10 * 60_000);
    expect(events.filter((e) => e.type === "help-signal").length).toBe(0);
  });

  it("never reads a lost face as a blink", () => {
    const engine = new GazeEngine({ screen: singleDisplay(1470, 956) });
    const events = collect(engine);
    for (let i = 0; i < 120; i++)
      engine.handle({ kind: "face", frame: { t: i * 33, landmarks: null, aspect: 4 / 3 } });
    const blinks = events.filter((e) => e.type === "blink");
    expect(blinks.every((e) => e.type === "blink" && e.score === null && !e.face)).toBe(true);
    expect(events.some((e) => e.type === "help-signal" || e.type === "help-progress")).toBe(false);
  });

  it("emits a long-blink switch only when the blink switch is on", () => {
    const run = (on: boolean) => {
      const engine = new GazeEngine({ screen: singleDisplay(1470, 956), blinkSwitch: on });
      const events = collect(engine);
      const script = new GazeScript([{ x: 700, y: 400, durationMs: 3000 }], {
        naturalBlinks: false,
        closures: [[1000, 700]],
      });
      for (const f of simulate(person(4), script, new HeadMotion({ kind: "still" })))
        engine.handle(toFrame(f));
      return events.filter((e) => e.type === "switch").length;
    };
    expect(run(true)).toBe(1);
    expect(run(false)).toBe(0);
  });

  it("reports tracking weak, then lost, then ok", () => {
    const m = new TrackingMonitor(1500);
    const states: string[] = [];
    const push = (t: number, c: number) => {
      const s = m.update(t, c);
      if (s) states.push(s);
    };
    for (let t = 0; t < 200; t += 33) push(t, 1);
    for (let t = 200; t < 2000; t += 33) push(t, 0);
    for (let t = 2000; t < 2200; t += 33) push(t, 1);
    expect(states).toEqual(["ok", "weak", "lost", "ok"]);
  });

  it("confidence below 0.5 on a saccade frame and lower off the calibrated display", () => {
    const fix = {
      x: 0,
      y: 0,
      fixation: false,
      fixationMs: 0,
      noisePt: 100,
      outputNoisePt: 50,
      saccade: true,
    };
    expect(sampleConfidence(1, fix, 0)).toBeLessThan(0.5);
    expect(sampleConfidence(1, { ...fix, saccade: false }, 300)).toBeLessThan(1);
    expect(sampleConfidence(1, { ...fix, saccade: false }, 0)).toBe(1);
  });

  it("keeps samples in global points across displays (external monitor on the left)", async () => {
    const screen = new ScreenSpace([
      {
        id: "ext",
        bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
        scaleFactor: 1,
        primary: false,
        hasCamera: false,
      },
      {
        id: "mac",
        bounds: { x: 0, y: 0, width: 1470, height: 956 },
        scaleFactor: 2,
        primary: true,
        hasCamera: true,
      },
    ]);
    const engine = new GazeEngine({ screen });
    const events = collect(engine);
    const mouse = new MouseProvider();
    await engine.attach(mouse);
    mouse.push(-1000, 300, 0);
    mouse.push(-5000, 300, 16);
    mouse.push(700, 2000, 33);
    const samples = events.flatMap((e) => (e.type === "sample" ? [e.sample] : []));
    expect(samples[0]).toMatchObject({ x: -1000, y: 300, source: "mouse", confidence: 1 });
    expect(samples[1]!.x).toBe(-1920); // clamped to the external display's left edge
    expect(samples[2]).toMatchObject({ x: 700, y: 955 });
    expect(screen.displayAt(-1000, 300)!.id).toBe("ext");
  });

  it("maps an external tracker's normalised samples to global points", async () => {
    const engine = new GazeEngine({ screen: singleDisplay(1470, 956) });
    const events = collect(engine);
    const driver = new ScriptedTrackerDriver();
    await engine.attach(new ExternalTrackerProvider(driver, { x: 0, y: 0, width: 1470, height: 956 }));
    for (let i = 0; i < 20; i++) driver.emit({ t: i * 16, x: 0.5, y: 0.25, normalized: true, confidence: 1 });
    const last = events.filter((e) => e.type === "sample").at(-1);
    expect(last).toMatchObject({ sample: { x: 735, y: 239, source: "external-tracker" } });
  });

  it("decides on a picker for crowded targets under the gaze", async () => {
    const engine = new GazeEngine({ screen: singleDisplay(1470, 956) });
    const mouse = new MouseProvider();
    await engine.attach(mouse);
    mouse.push(500, 500, 0);
    const targets = [
      {
        id: "a",
        rect: { x: 498, y: 490, width: 10, height: 10 },
        role: "button",
        label: "A",
        source: "ax" as const,
      },
      {
        id: "b",
        rect: { x: 490, y: 498, width: 10, height: 10 },
        role: "button",
        label: "B",
        source: "ax" as const,
      },
    ];
    // Mouse error radius is tiny, so these two (both within a few points) are still ambiguous.
    expect(engine.precision(targets).kind).toBe("picker");
  });
});

describe("frame-rate governor", () => {
  it("takes an outside limit, but never below the Lifeline floor", () => {
    const g = new FrameRateGovernor({ floorFps: 10 });
    g.observe(0, true);
    g.setCap(5);
    expect(g.targetFps(100)).toBe(10);
    g.setCap(20);
    expect(g.targetFps(100)).toBe(20);
    g.setPaused(true);
    expect(g.targetFps(100)).toBe(15); // a limit only lowers the rate
    g.setCap(null);
    g.setPaused(false);
    expect(g.targetFps(100)).toBe(30);
  });

  it("keeps the desktop's limit on the camera across frames, and the help signal still fires", async () => {
    const engine = new GazeEngine({ screen: singleDisplay(1470, 956) });
    const asked: number[] = [];
    let push: ((f: ProviderFrame) => void) | null = null;
    await engine.attach({
      id: "fake-camera",
      kind: "face",
      start: async (onFrame) => {
        push = onFrame;
      },
      stop: () => undefined,
      setTargetFps: (fps) => asked.push(fps),
    });
    const events = collect(engine);
    engine.setFrameRateCap(5);
    // Three long blinks, seen at the floor rate (10 frames a second) the limit leaves.
    const script = new GazeScript([{ x: 700, y: 400, durationMs: 9000 }], {
      naturalBlinks: false,
      closures: [
        [1000, 1000],
        [2800, 1000],
        [4600, 1000],
      ],
    });
    let last = -Infinity;
    for (const f of simulate(person(2), script, new HeadMotion({ kind: "still" }))) {
      if (f.t - last < 100) continue;
      last = f.t;
      push!(toFrame(f));
    }
    // Before the fix, the next frame put the camera straight back to 30.
    expect(asked.length).toBeGreaterThan(50);
    expect(Math.max(...asked)).toBe(10);
    expect(events.some((e) => e.type === "help-signal")).toBe(true);
    engine.setFrameRateCap(null);
    expect(asked.at(-1)).toBe(30);
  });

  it("drops to idle when nobody is in view but never below the Lifeline floor", () => {
    const g = new FrameRateGovernor({ idleFps: 2, floorFps: 10 });
    g.observe(0, true);
    expect(g.targetFps(100)).toBe(30);
    g.setPaused(true);
    expect(g.targetFps(100)).toBe(15);
    expect(g.targetFps(10_000)).toBe(10);
  });

  it("decimates a fast camera to the target rate", () => {
    const g = new FrameRateGovernor({ activeFps: 15 });
    g.observe(0, true);
    let processed = 0;
    for (let t = 0; t < 1000; t += 1000 / 60) if (g.shouldProcess(t)) processed++;
    expect(processed).toBeGreaterThanOrEqual(14);
    expect(processed).toBeLessThanOrEqual(17);
  });
});
