/**
 * Read aloud: speaks paragraphs one after another and can be stopped at any time. The system voice through the web
 * speech API when it has voices (it stops at once); otherwise the Mac's own voice through AGENCY (it stops after the
 * paragraph it is on).
 */
import { host } from "../state/host";

export interface Reading {
  stop(): void;
  done: Promise<void>;
}

function hasWebVoices(): boolean {
  try {
    return typeof speechSynthesis !== "undefined" && speechSynthesis.getVoices().length > 0;
  } catch {
    return false;
  }
}

function sayWeb(text: string, rate: number): { promise: Promise<void>; cancel: () => void } {
  const u = new SpeechSynthesisUtterance(text);
  u.rate = rate;
  const promise = new Promise<void>((resolve) => {
    u.onend = () => resolve();
    u.onerror = () => resolve();
  });
  speechSynthesis.speak(u);
  return { promise, cancel: () => speechSynthesis.cancel() };
}

/**
 * Speak `paragraphs` in order. `onParagraph` says which one is being read (for highlighting and page turns);
 * -1 when finished or stopped.
 */
export function readAloud(
  paragraphs: readonly string[],
  onParagraph: (i: number) => void,
  rate = 1,
): Reading {
  let stopped = false;
  let cancel: () => void = () => undefined;
  const run = async () => {
    const web = hasWebVoices();
    const h = host();
    for (let i = 0; i < paragraphs.length && !stopped; i++) {
      const text = paragraphs[i]!.trim();
      if (!text) continue;
      onParagraph(i);
      if (web) {
        const s = sayWeb(text, rate);
        cancel = s.cancel;
        await s.promise;
      } else if (h) {
        await h.native.call("speech.say", { text: text.slice(0, 4000) }).catch(() => ({ ok: false }));
      } else {
        // No voice at all here: move on at reading pace, so the highlight still follows.
        await new Promise((r) => setTimeout(r, Math.min(8000, 200 + text.length * 40)));
      }
    }
    onParagraph(-1);
  };
  const done = run();
  return {
    stop: () => {
      stopped = true;
      cancel();
    },
    done,
  };
}
