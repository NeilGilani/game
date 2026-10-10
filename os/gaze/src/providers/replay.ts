/**
 * Replay provider: plays a landmark recording back through the engine, either in real time (for
 * demos and for developing without a camera) or as fast as possible (tests, benchmarks).
 */

import { type Recording, frameToFace } from "../record";
import type { GazeProvider, ProviderFrame } from "./types";

export class ReplayProvider implements GazeProvider {
  readonly id: string;
  readonly kind = "face" as const;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(
    private readonly recording: Recording,
    private readonly options: { loop?: boolean; speed?: number; clock?: () => number } = {},
  ) {
    this.id = `replay:${recording.note || recording.createdAt}`;
  }

  /** Real-time playback; frame times are shifted onto the engine clock. */
  async start(onFrame: (f: ProviderFrame) => void): Promise<void> {
    this.stopped = false;
    const clock = this.options.clock ?? (() => performance.now());
    const speed = this.options.speed ?? 1;
    const frames = this.recording.frames;
    if (frames.length === 0) return;
    const play = () => {
      const origin = clock();
      const first = frames[0]!.t;
      let i = 0;
      const step = () => {
        if (this.stopped) return;
        const f = frames[i]!;
        const face = frameToFace(this.recording, f);
        const shift = origin - first / speed;
        const t = f.t / speed + shift;
        onFrame({
          kind: "face",
          frame: {
            ...face,
            t,
            ...(face.captureT !== undefined ? { captureT: face.captureT / speed + shift } : {}),
          },
        });
        i += 1;
        if (i >= frames.length) {
          if (this.options.loop) play();
          return;
        }
        const wait = Math.max(0, frames[i]!.t / speed + shift - clock());
        this.timer = setTimeout(step, wait);
      };
      step();
    };
    play();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Deliver every frame synchronously with its recorded timestamps (tests, benchmarks). */
  runSync(onFrame: (f: ProviderFrame) => void): void {
    for (const f of this.recording.frames) onFrame({ kind: "face", frame: frameToFace(this.recording, f) });
  }
}
