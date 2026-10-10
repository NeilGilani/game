/**
 * Talk's built-in vocabulary: a core-word board (the small set of words that make up most of
 * what people say, arranged by part of speech with the widely used Fitzgerald-style colour
 * key), starter phrase boards, quick replies and emergency phrases. People add their own
 * phrases; these are only a starting point.
 */

export type WordClass =
  "pronoun" | "verb" | "describe" | "social" | "question" | "little" | "noun" | "negation";

export interface CoreWord {
  text: string;
  cls: WordClass;
}

/** Ordered so the first pages hold the most useful words. 12 per page on screen. */
export const CORE_WORDS: CoreWord[] = [
  // Page 1: build a first sentence
  { text: "I", cls: "pronoun" },
  { text: "want", cls: "verb" },
  { text: "need", cls: "verb" },
  { text: "help", cls: "verb" },
  { text: "more", cls: "describe" },
  { text: "stop", cls: "verb" },
  { text: "you", cls: "pronoun" },
  { text: "like", cls: "verb" },
  { text: "not", cls: "negation" },
  { text: "go", cls: "verb" },
  { text: "yes", cls: "social" },
  { text: "no", cls: "negation" },
  // Page 2
  { text: "it", cls: "pronoun" },
  { text: "is", cls: "verb" },
  { text: "feel", cls: "verb" },
  { text: "good", cls: "describe" },
  { text: "bad", cls: "describe" },
  { text: "please", cls: "social" },
  { text: "my", cls: "pronoun" },
  { text: "do", cls: "verb" },
  { text: "that", cls: "little" },
  { text: "now", cls: "little" },
  { text: "thank you", cls: "social" },
  { text: "what", cls: "question" },
  // Page 3
  { text: "we", cls: "pronoun" },
  { text: "can", cls: "verb" },
  { text: "turn", cls: "verb" },
  { text: "different", cls: "describe" },
  { text: "again", cls: "little" },
  { text: "where", cls: "question" },
  { text: "he", cls: "pronoun" },
  { text: "she", cls: "pronoun" },
  { text: "they", cls: "pronoun" },
  { text: "look", cls: "verb" },
  { text: "wait", cls: "verb" },
  { text: "who", cls: "question" },
  // Page 4
  { text: "the", cls: "little" },
  { text: "a", cls: "little" },
  { text: "to", cls: "little" },
  { text: "in", cls: "little" },
  { text: "on", cls: "little" },
  { text: "off", cls: "little" },
  { text: "up", cls: "little" },
  { text: "down", cls: "little" },
  { text: "here", cls: "little" },
  { text: "when", cls: "question" },
  { text: "why", cls: "question" },
  { text: "how", cls: "question" },
  // Page 5: body and care
  { text: "pain", cls: "noun" },
  { text: "water", cls: "noun" },
  { text: "bathroom", cls: "noun" },
  { text: "bed", cls: "noun" },
  { text: "hot", cls: "describe" },
  { text: "cold", cls: "describe" },
  { text: "tired", cls: "describe" },
  { text: "hungry", cls: "describe" },
  { text: "TV", cls: "noun" },
  { text: "music", cls: "noun" },
  { text: "light", cls: "noun" },
  { text: "phone", cls: "noun" },
];

export interface PhraseBoard {
  id: string;
  title: string;
  phrases: string[];
}

export const STARTER_BOARDS: PhraseBoard[] = [
  {
    id: "quick",
    title: "Quick replies",
    phrases: [
      "Yes",
      "No",
      "Maybe",
      "I don't know",
      "Wait, please",
      "Thank you",
      "Please repeat that",
      "I'm typing",
    ],
  },
  {
    id: "greetings",
    title: "Hello and goodbye",
    phrases: [
      "Hello!",
      "Good morning",
      "How are you?",
      "I'm doing well",
      "Nice to see you",
      "Goodbye",
      "See you soon",
      "Good night",
    ],
  },
  {
    id: "needs",
    title: "What I need",
    phrases: [
      "I need help",
      "Please reposition me",
      "I need suctioning",
      "I'm thirsty",
      "I need the bathroom",
      "Please adjust my mask",
      "I'm too hot",
      "I'm too cold",
    ],
  },
  {
    id: "feelings",
    title: "How I feel",
    phrases: [
      "I'm comfortable",
      "I'm in pain",
      "I'm tired",
      "I'm happy",
      "I'm frustrated",
      "I'm worried",
      "I feel sick",
      "I'm fine",
    ],
  },
  {
    id: "talk",
    title: "Conversation",
    phrases: [
      "Give me a moment to answer",
      "That's funny",
      "Tell me more",
      "I agree",
      "I disagree",
      "Can we talk later?",
      "What do you think?",
      "I love you",
    ],
  },
];

/** Emergency phrases are spoken at once and offer Lifeline next to them. */
export interface EmergencyPhrase {
  text: string;
  /** Lifeline situation id (LIFELINE.md) when this phrase matches one. */
  situation?: string;
}

export const EMERGENCY_PHRASES: EmergencyPhrase[] = [
  { text: "I can't breathe", situation: "breathing" },
  { text: "Help me now, please", situation: "other" },
  { text: "My mask has slipped", situation: "breathing" },
  { text: "I'm in a lot of pain", situation: "pain" },
];
