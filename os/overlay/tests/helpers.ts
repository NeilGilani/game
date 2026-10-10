import type { Target, TargetSnapshot } from "../src/contracts";
import { OverlayController, type ControllerOptions } from "../src/core/controller";
import { center } from "../src/core/geometry";
import { FakeHost, type FakeHostOptions } from "../src/host/fakeHost";

export const DISPLAY = { x: 0, y: 0, width: 1470, height: 956 };

export function axTarget(
  id: string,
  x: number,
  y: number,
  w = 120,
  h = 40,
  extra: Partial<Target> = {},
): Target {
  return {
    id,
    rect: { x, y, width: w, height: h },
    role: "button",
    label: id,
    source: "ax",
    owner: "com.test",
    ...extra,
  };
}

export function snapshot(targets: Target[]): TargetSnapshot {
  return { t: 0, owner: "com.test", targets, truncated: false };
}

/** A controller wired to a fake host, with a fake gaze clock. */
export function setup(opts: Partial<ControllerOptions> = {}, hostOpts: FakeHostOptions = {}) {
  const host = new FakeHost(hostOpts);
  const ctrl = new OverlayController(host, { display: DISPLAY, ...opts });
  let t = 1000;
  const look = (x: number, y: number, ms: number, confidence = 0.9) => {
    const end = t + ms;
    for (; t <= end; t += 16) {
      ctrl.handleGaze({ type: "sample", sample: { t, x, y, confidence, fixation: true, source: "mouse" } });
      ctrl.tick(t);
    }
  };
  const lookAt = (id: string, ms = 1600) => {
    const b = ctrl.buttons().find((x) => x.id === id) ?? ctrlTarget(id);
    if (!b)
      throw new Error(
        `no such button ${id}: ${ctrl
          .buttons()
          .map((x) => x.id)
          .join(", ")}`,
      );
    const c = center(b.rect);
    look(c.x, c.y, ms);
  };
  const ctrlTarget = (id: string) =>
    (ctrl as unknown as { snapshot: TargetSnapshot }).snapshot.targets.find((x) => x.id === id);
  const away = (ms = 400) => look(700, 480, ms);
  const now = () => t;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { host, ctrl, look, lookAt, away, now, flush };
}
