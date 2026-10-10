/**
 * Lifeline sounds, generated with Web Audio (no audio files, works offline).
 *
 * - siren: loud two-tone alarm so anyone nearby hears that the person needs help. It sounds
 *   whenever an alert is open and nobody has answered, and also when the coordinator can't
 *   be reached at all, because then this alarm may be the only thing that works.
 * - countdown: a short beep each second during the cancel window.
 * - chime: two gentle notes when someone answers "on my way", or for a check-in.
 *
 * Browsers only allow sound after the page has had a real click, tap or key press. A helper
 * makes one when setting AGENCY up (the Lifeline screen shows whether sound is ready).
 * Synthetic clicks from eye control don't count, so `ready` is reported honestly.
 */

type Mode = "off" | "siren" | "countdown";

class Alarm {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private mode: Mode = "off";
  private timer: number | null = null;
  private listeners = new Set<() => void>();
  private volume = 0.9;

  constructor() {
    if (typeof window === "undefined") return;
    const unlock = () => {
      void this.unlock();
    };
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });
  }

  /** True when the browser will actually play sound. */
  get ready(): boolean {
    return this.ctx?.state === "running";
  }

  get playing(): Mode {
    return this.mode;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.ctx.addEventListener("statechange", () => this.notify());
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  async unlock(): Promise<boolean> {
    const ctx = this.context();
    if (!ctx) return false;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* still locked */
      }
    }
    this.notify();
    return this.ready;
  }

  private tone(
    freq: number,
    start: number,
    duration: number,
    level: number,
    type: OscillatorType = "square",
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(level, start + 0.02);
    gain.gain.setValueAtTime(level, start + Math.max(0.03, duration - 0.04));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  private schedule(mode: Mode): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime + 0.02;
    if (mode === "siren") {
      // Two alternating tones, four times a second: unmistakably an alarm.
      for (let i = 0; i < 4; i++) {
        this.tone(i % 2 ? 784 : 1046, t + i * 0.25, 0.22, 0.32);
      }
    } else if (mode === "countdown") {
      this.tone(880, t, 0.12, 0.18, "sine");
    }
  }

  private start(mode: Mode): void {
    if (this.mode === mode) return;
    this.stopLoop();
    this.mode = mode;
    void this.unlock();
    this.schedule(mode);
    this.timer = window.setInterval(() => this.schedule(mode), 1000);
    this.notify();
  }

  siren(): void {
    this.start("siren");
  }

  countdown(): void {
    this.start("countdown");
  }

  chime(): void {
    const ctx = this.context();
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime + 0.02;
    this.tone(660, t, 0.35, 0.22, "sine");
    this.tone(990, t + 0.3, 0.6, 0.22, "sine");
  }

  /** A short sample of the siren, for "Test alarm sound". */
  async test(): Promise<boolean> {
    const ok = await this.unlock();
    if (!ok) return false;
    this.schedule("siren");
    window.setTimeout(() => this.schedule("siren"), 1000);
    return true;
  }

  private stopLoop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  stop(): void {
    if (this.mode === "off") return;
    this.stopLoop();
    this.mode = "off";
    this.notify();
  }
}

let instance: Alarm | null = null;

export function alarm(): Alarm {
  instance ??= new Alarm();
  return instance;
}

export type { Alarm };
