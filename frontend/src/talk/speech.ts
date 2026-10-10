/**
 * Text-to-speech for Talk: the person's voice.
 *
 * Uses the browser's built-in voices (Web Speech API), so it works offline on a Mac and
 * nothing is sent anywhere. Chrome only allows speech after the page has had one real
 * click or key press (the same rule as the Lifeline alarm); `speechReady()` reports it.
 */

export interface VoiceSettings {
  /** voiceURI of the chosen voice, or null for the system default */
  voice: string | null;
  rate: number;
  volume: number;
}

export const RATES = [0.75, 0.9, 1, 1.15, 1.3] as const;
export const DEFAULT_VOICE: VoiceSettings = { voice: null, rate: 1, volume: 1 };
const KEY = "agency.talk.voice";

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** True once the browser will let this page speak (it has had a real user gesture). */
export function speechReady(): boolean {
  const nav = navigator as Navigator & { userActivation?: { hasBeenActive: boolean } };
  return speechSupported() && (nav.userActivation ? nav.userActivation.hasBeenActive : true);
}

export function loadVoice(): VoiceSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_VOICE, ...(JSON.parse(raw) as Partial<VoiceSettings>) };
  } catch {
    /* private window or blocked storage: defaults */
  }
  return DEFAULT_VOICE;
}

export function saveVoice(v: VoiceSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/** Voices in the page's language first, then the rest. */
export function availableVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported()) return [];
  const lang = (navigator.language || "en").slice(0, 2).toLowerCase();
  const all = window.speechSynthesis.getVoices();
  const mine = all.filter((v) => v.lang.toLowerCase().startsWith(lang));
  return mine.length ? mine : all;
}

/**
 * Say `text` now, interrupting anything already being said (the newest thing the person
 * chose is what matters). Resolves when speech ends, fails, or isn't available.
 */
export function speak(text: string, settings: VoiceSettings = loadVoice()): Promise<boolean> {
  if (!speechSupported() || !text.trim()) return Promise.resolve(false);
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = settings.rate;
  u.volume = settings.volume;
  const voice = settings.voice ? synth.getVoices().find((v) => v.voiceURI === settings.voice) : undefined;
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  return new Promise((resolve) => {
    u.onend = () => resolve(true);
    u.onerror = () => resolve(false);
    synth.speak(u);
  });
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}
