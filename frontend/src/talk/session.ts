/**
 * What the person has said this session: the last utterance (shown large on screen for
 * anyone who didn't hear it) and a short history for "say it again".
 */
import { useSyncExternalStore } from "react";
import { speak } from "./speech";
import { persistPredictor, predictor } from "./store";

export interface Said {
  text: string;
  at: number;
}

interface TalkSession {
  last: Said | null;
  history: string[];
  speaking: boolean;
}

const MAX_HISTORY = 12;
let state: TalkSession = { last: null, history: [], speaking: false };
const listeners = new Set<() => void>();
let seq = 0;

function set(patch: Partial<TalkSession>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useTalkSession(): TalkSession {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/**
 * Say something on the person's behalf: show it, speak it, remember it.
 * `learn` feeds the words to the predictor (for things the person typed or chose).
 */
export async function say(text: string, { learn = true }: { learn?: boolean } = {}): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  const history = [clean, ...state.history.filter((h) => h !== clean)].slice(0, MAX_HISTORY);
  set({ last: { text: clean, at: Date.now() }, history, speaking: true });
  if (learn) {
    predictor().learn(clean);
    persistPredictor();
  }
  const mine = ++seq;
  await speak(clean);
  // A newer utterance interrupts this one; only the latest decides when speaking ends.
  if (mine === seq) set({ speaking: false });
}

export function resetTalkSession(): void {
  set({ last: null, history: [], speaking: false });
}
