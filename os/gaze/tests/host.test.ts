import { describe, expect, it } from "vitest";
import type { CalibrationResult } from "../src/calibration/session";
import { type CalibrationStore, type HostMessage, startEngineHost } from "../src/host";
import { Recorder } from "../src/record";
import type { DisplayInfo } from "../src/screen";
import { GazeScript, HeadMotion, simulate } from "../src/synth/scenarios";
import { person } from "./helpers";

const displays: DisplayInfo[] = [
  {
    id: "mac",
    bounds: { x: 0, y: 0, width: 1470, height: 956 },
    scaleFactor: 2,
    primary: true,
    hasCamera: true,
  },
];

function memoryStore(): CalibrationStore & { value: CalibrationResult | null } {
  return {
    value: null,
    load() {
      return this.value;
    },
    save(r) {
      this.value = r;
    },
  };
}

describe("engine host", () => {
  it("starts on the mouse without a camera model and forwards contract events", async () => {
    const sent: HostMessage[] = [];
    const host = await startEngineHost({ displays, send: (m) => sent.push(m), store: null });
    expect(sent[0]).toMatchObject({ type: "host.status", provider: "mouse", status: "running" });
    await host.command({ type: "mouse", x: 300, y: 200, t: 5 });
    expect(sent.at(-1)).toMatchObject({ type: "sample", sample: { x: 300, y: 200, source: "mouse" } });
    await host.command({ type: "provider", provider: "webcam" });
    expect(sent.at(-1)).toMatchObject({ type: "host.error" });
  });

  it("answers precision requests with the request id", async () => {
    const sent: HostMessage[] = [];
    const host = await startEngineHost({ displays, send: (m) => sent.push(m), store: null });
    await host.command({ type: "mouse", x: 500, y: 500, t: 1 });
    await host.command({
      type: "precision",
      requestId: "r1",
      targets: [
        { id: "a", rect: { x: 497, y: 490, width: 6, height: 6 }, role: "button", label: "A", source: "ax" },
        { id: "b", rect: { x: 497, y: 502, width: 6, height: 6 }, role: "button", label: "B", source: "ax" },
      ],
    });
    expect(sent.at(-1)).toMatchObject({
      type: "host.precision",
      requestId: "r1",
      decision: { kind: "picker" },
    });
  });

  it("drives a calibration from replayed frames, saves it, and the help signal keeps working throughout", async () => {
    const sent: HostMessage[] = [];
    const store = memoryStore();
    const host = await startEngineHost({
      displays,
      send: (m) => sent.push(m),
      store,
      initialProvider: "none",
    });
    await host.command({ type: "calibration.start" });
    const face = person(5);
    const head = new HeadMotion({ kind: "still", seed: 5 });
    let t = 0;
    let prev = { x: 735, y: 478 };
    for (let i = 0; i < 40; i++) {
      const last = sent.filter((m) => m.type === "host.calibration").at(-1);
      if (!last || last.type !== "host.calibration" || last.step.kind !== "target") break;
      const target = last.step.target;
      const collecting = host.command({ type: "calibration.collect", targetId: target.id });
      // Three long blinks during the 4th dot: Lifeline must still hear them.
      const closures: [number, number][] =
        i === 3
          ? [
              [300, 900],
              [1500, 900],
              [2700, 900],
            ]
          : [];
      const script = new GazeScript(
        [
          { x: prev.x, y: prev.y, durationMs: 1 },
          { x: target.x, y: target.y, durationMs: i === 3 ? 5000 : 2200 },
        ],
        { naturalBlinks: false, closures },
      );
      for (const f of simulate(face, script, head, { startMs: t, seed: i }))
        host.engine.handle({
          kind: "face",
          frame: {
            t: f.t,
            landmarks: f.frame.landmarks,
            matrix: f.frame.matrix,
            blink: f.frame.blinkScore,
            aspect: f.frame.aspect,
          },
        });
      await collecting;
      t += script.totalMs + 100;
      prev = target;
    }
    const done = sent.filter((m) => m.type === "host.calibration").at(-1);
    expect(done).toMatchObject({ type: "host.calibration", step: { kind: "done" } });
    expect(store.value?.model.version).toBe(2);
    expect(sent.some((m) => m.type === "calibration")).toBe(true);
    expect(sent.filter((m) => m.type === "help-signal").length).toBe(1);
    // A new host restores the saved calibration.
    const again: HostMessage[] = [];
    const host2 = await startEngineHost({
      displays,
      send: (m) => again.push(m),
      store,
      initialProvider: "none",
    });
    expect(host2.engine.calibration).not.toBeNull();
  });

  it("records only after explicit consent and hands back a landmark recording", async () => {
    const sent: HostMessage[] = [];
    const host = await startEngineHost({
      displays,
      send: (m) => sent.push(m),
      store: null,
      initialProvider: "none",
    });
    await host.command({ type: "record.start", consent: true, note: "test" });
    const f = person(1).render({
      gaze: { x: 1, y: 1 },
      head: { position: [0, 14, 60], yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
      closure: 0,
    });
    host.engine.handle({
      kind: "face",
      frame: { t: 1, landmarks: f.landmarks, matrix: f.matrix, aspect: f.aspect },
    });
    await host.command({ type: "record.stop" });
    const rec = sent.find((m) => m.type === "host.recording");
    expect(rec).toBeDefined();
    if (rec?.type === "host.recording") expect(rec.recording.frames.length).toBe(1);
    expect(() => new Recorder(false)).toThrow();
  });
});
