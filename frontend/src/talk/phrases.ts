/**
 * Talk phrases: the things people in care most often need to say, in big categories.
 * The person's own saved phrases form the first category.
 */

export interface PhraseCategory {
  id: string;
  label: string;
  icon: string;
  phrases: string[];
}

export const QUICK_ANSWERS = [
  { id: "yes", label: "Yes", say: "Yes." },
  { id: "no", label: "No", say: "No." },
  { id: "maybe", label: "Not sure", say: "I'm not sure." },
  { id: "wait", label: "Wait", say: "Please wait, I'm thinking." },
] as const;

export const CATEGORIES: PhraseCategory[] = [
  {
    id: "needs",
    label: "Needs",
    icon: "hand",
    phrases: [
      "I'm thirsty.",
      "I need suction, please.",
      "Please move me, I'm uncomfortable.",
      "I need the bathroom.",
      "Please adjust my mask.",
      "I'm too hot.",
      "I'm too cold.",
      "I'm hungry.",
      "Please scratch my nose.",
      "I need my medicine.",
      "Please wipe my eyes.",
      "Please turn the light off.",
    ],
  },
  {
    id: "feel",
    label: "How I feel",
    icon: "sparkle",
    phrases: [
      "I'm fine, thank you.",
      "I'm tired.",
      "I feel short of breath.",
      "I'm in pain.",
      "I feel sick.",
      "I'm worried.",
      "I'm frustrated.",
      "I'm happy.",
      "I'm bored.",
      "I feel better now.",
    ],
  },
  {
    id: "talk",
    label: "Conversation",
    icon: "message",
    phrases: [
      "Hello!",
      "Thank you.",
      "I love you.",
      "How are you?",
      "Please give me a moment to type.",
      "Can you repeat that?",
      "That's funny!",
      "Tell me about your day.",
      "I don't agree.",
      "Goodnight.",
    ],
  },
  {
    id: "activities",
    label: "Things to do",
    icon: "play",
    phrases: [
      "Can we watch TV?",
      "Please put some music on.",
      "Please read to me.",
      "I'd like to go outside.",
      "Please call my family.",
      "I want to rest now.",
      "Please open the window.",
      "Can you sit with me?",
    ],
  },
];

export const MY_PHRASES_ID = "mine";
const KEY = "agency.talk.phrases";
export const MAX_SAVED = 40;

export function loadSaved(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function storeSaved(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** Adds a phrase to the front, without duplicates (case-insensitive), capped. */
export function withSaved(list: string[], phrase: string): string[] {
  const p = phrase.trim();
  if (!p) return list;
  const rest = list.filter((x) => x.toLowerCase() !== p.toLowerCase());
  return [p, ...rest].slice(0, MAX_SAVED);
}
