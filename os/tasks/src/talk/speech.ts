/**
 * Speaking aloud. The real voice is agency-native's `speech.say` (AVSpeechSynthesizer,
 * including Apple's Personal Voice when the person made one and allowed AGENCY to use it).
 * In a plain browser it falls back to the Web Speech API; tests use the fake.
 */

import type { NativeEvent, NativeMethod, NativeMethods } from "../contracts";

/** The slice of agency-native the packs use. The main process enforces what renderers may call. */
export interface NativeClient {
  invoke<M extends NativeMethod>(
    method: M,
    params: NativeMethods[M]["params"],
  ): Promise<NativeMethods[M]["result"]>;
  /** Native events (speech results). Returns an unsubscribe function. */
  onEvent?(listener: (event: NativeEvent) => void): () => void;
}

export interface Voice {
  id: string;
  name: string;
  personal: boolean;
}

export interface Speaker {
  readonly kind: "native" | "browser" | "fake" | "none";
  voices(): Promise<Voice[]>;
  say(text: string, opts?: { voiceId?: string; rate?: number }): Promise<boolean>;
  stop?(): void;
}

/** Personal Voice first when allowed, then the chosen voice, then the system default. */
export function pickVoice(
  voices: readonly Voice[],
  preferredId: string | null,
  usePersonal: boolean,
): Voice | null {
  if (usePersonal) {
    const personal = voices.find((v) => v.personal);
    if (personal) return personal;
  }
  return voices.find((v) => v.id === preferredId) ?? null;
}

export function nativeSpeaker(native: NativeClient): Speaker {
  return {
    kind: "native",
    voices: async () => (await native.invoke("speech.voices", {})).voices,
    say: async (text, opts) =>
      (
        await native.invoke("speech.say", {
          text,
          ...(opts?.voiceId ? { voiceId: opts.voiceId } : {}),
          ...(opts?.rate ? { rate: opts.rate } : {}),
        })
      ).ok,
  };
}

/** Web Speech API fallback for the web app (no Personal Voice there). */
export function browserSpeaker(): Speaker {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) return noSpeaker();
  return {
    kind: "browser",
    voices: async () =>
      synth.getVoices().map((v) => ({ id: v.voiceURI, name: `${v.name} (${v.lang})`, personal: false })),
    say: (text, opts) =>
      new Promise<boolean>((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        const voice = synth.getVoices().find((v) => v.voiceURI === opts?.voiceId);
        if (voice) u.voice = voice;
        if (opts?.rate) u.rate = opts.rate;
        u.onend = () => resolve(true);
        u.onerror = () => resolve(false);
        synth.speak(u);
      }),
    stop: () => synth.cancel(),
  };
}

export function noSpeaker(): Speaker {
  return { kind: "none", voices: async () => [], say: async () => false };
}

export class FakeSpeaker implements Speaker {
  readonly kind = "fake" as const;
  readonly spoken: { text: string; voiceId?: string }[] = [];
  constructor(
    private readonly available: Voice[] = [{ id: "fake.samantha", name: "Samantha", personal: false }],
  ) {}
  async voices(): Promise<Voice[]> {
    return this.available;
  }
  async say(text: string, opts?: { voiceId?: string }): Promise<boolean> {
    this.spoken.push({ text, ...(opts?.voiceId ? { voiceId: opts.voiceId } : {}) });
    return true;
  }
}
