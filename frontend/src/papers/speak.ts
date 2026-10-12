/** Read aloud with the person's chosen voice: the Mac's speech in the app, the browser's voice elsewhere. */
import { loadVoice } from "../screens/OsSettings";
import { host } from "../state/host";

export function readAloud(text: string): void {
  const { id, rate } = loadVoice();
  const h = host();
  if (h) {
    void h.native.call("speech.say", { text, ...(id ? { voiceId: id } : {}), rate }).catch(() => undefined);
    return;
  }
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(text);
  const v = synth.getVoices().find((x) => x.voiceURI === id);
  if (v) u.voice = v;
  u.rate = rate;
  synth.cancel();
  synth.speak(u);
}

export function stopReading(): void {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* nothing to stop */
  }
}
