/**
 * Talk's local data: what was said (history), the person's own phrases, and voice settings.
 * Stored only in this browser profile on this Mac, visible and erasable from History.
 * Every read and write tolerates storage being unavailable.
 */

import { useCallback, useEffect, useState } from "react";
import { STARTER_BOARDS, type PhraseBoard } from "../../../os/tasks/src/index";

const HISTORY_KEY = "agency.talk.history";
const BOARDS_KEY = "agency.talk.boards";
const VOICE_KEY = "agency.talk.voice";
export const HISTORY_LIMIT = 500;

export interface SpokenItem {
  text: string;
  at: string;
}

export interface VoiceSettings {
  voiceId: string | null;
  usePersonalVoice: boolean;
}

export const DEFAULT_VOICE: VoiceSettings = { voiceId: null, usePersonalVoice: true };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: Talk keeps working for this session.
  }
}

const listeners = new Set<() => void>();
function changed() {
  for (const l of listeners) l();
}

function useStored<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback));
  useEffect(() => {
    const onChange = () => setValue(read(key, fallback));
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
    // fallback is a constant per call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (next: T) => {
      write(key, next);
      changed();
    },
    [key],
  );
  return [value, set];
}

export function useHistory() {
  const [items, setItems] = useStored<SpokenItem[]>(HISTORY_KEY, []);
  const add = useCallback(
    (text: string) => {
      const next = [...read<SpokenItem[]>(HISTORY_KEY, []), { text, at: new Date().toISOString() }];
      setItems(next.slice(-HISTORY_LIMIT));
    },
    [setItems],
  );
  const clear = useCallback(() => setItems([]), [setItems]);
  return { items, add, clear };
}

export function useBoards() {
  const [boards, setBoards] = useStored<PhraseBoard[]>(BOARDS_KEY, STARTER_BOARDS);
  const addPhrase = useCallback(
    (boardId: string, phrase: string) => {
      const current = read<PhraseBoard[]>(BOARDS_KEY, STARTER_BOARDS);
      const exists = current.some((b) => b.id === boardId);
      const next = exists
        ? current.map((b) =>
            b.id === boardId && !b.phrases.includes(phrase) ? { ...b, phrases: [...b.phrases, phrase] } : b,
          )
        : [...current, { id: boardId, title: "My phrases", phrases: [phrase] }];
      setBoards(next);
    },
    [setBoards],
  );
  const removePhrase = useCallback(
    (boardId: string, phrase: string) => {
      const current = read<PhraseBoard[]>(BOARDS_KEY, STARTER_BOARDS);
      setBoards(
        current.map((b) => (b.id === boardId ? { ...b, phrases: b.phrases.filter((p) => p !== phrase) } : b)),
      );
    },
    [setBoards],
  );
  const reset = useCallback(() => setBoards(STARTER_BOARDS), [setBoards]);
  return { boards, addPhrase, removePhrase, reset };
}

export function useVoiceSettings() {
  const [voice, setVoice] = useStored<VoiceSettings>(VOICE_KEY, DEFAULT_VOICE);
  return { voice: { ...DEFAULT_VOICE, ...voice }, setVoice };
}

export const MY_PHRASES = "mine";
