/**
 * Conversation mode: with the person's opt-in, agency-native listens on-device
 * (SFSpeechRecognizer with requiresOnDeviceRecognition, so audio never leaves the Mac) and
 * Talk shows what was said with big reply suggestions.
 *
 * Suggestions come from local rules plus the person's own phrases. Claude suggestions are a
 * separate opt-in: the exact text that would be sent is shown first, and nothing is sent
 * without consent for that conversation. What was heard is untrusted data: it is shown and
 * used to rank replies, never followed as an instruction.
 */

import { asUntrustedData } from "../policy/untrusted";
import { words } from "./predict";

export interface ReplySuggestion {
  text: string;
  source: "rule" | "phrase" | "claude";
}

const YES_NO = /^(are|is|do|does|did|can|could|would|will|should|have|has|was|were|shall|may|want|need)\b/i;

export function isQuestion(heard: string): boolean {
  const t = heard.trim();
  return t.endsWith("?") || YES_NO.test(t) || /^(what|where|when|who|why|how|which)\b/i.test(t);
}

/** Local reply suggestions for something heard. Always includes a way to ask for time. */
export function suggestReplies(
  heard: string,
  personalPhrases: readonly string[] = [],
  limit = 6,
): ReplySuggestion[] {
  const t = heard.trim().toLowerCase();
  const out: ReplySuggestion[] = [];
  const add = (text: string, source: ReplySuggestion["source"] = "rule") => {
    if (!out.some((o) => o.text.toLowerCase() === text.toLowerCase())) out.push({ text, source });
  };
  if (/\b(how are you|how're you|how do you feel|how are you feeling)\b/.test(t)) {
    add("I'm doing well, thanks");
    add("Not so good today");
    add("I'm tired");
  } else if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(t)) {
    add("Hello!");
    add("Good to see you");
  } else if (/\b(bye|goodbye|see you|good night)\b/.test(t)) {
    add("Goodbye");
    add("See you soon");
  } else if (/\b(thank|thanks)\b/.test(t)) {
    add("You're welcome");
  } else if (/\b(pain|hurt|comfortable|ok|okay|alright)\b/.test(t) && isQuestion(t)) {
    add("I'm comfortable");
    add("I'm in pain");
    add("Please reposition me");
  } else if (/^(what|where|when|who|why|how|which)\b/.test(t)) {
    add("Let me type my answer");
  } else if (isQuestion(t)) {
    add("Yes");
    add("No");
    add("Maybe");
  }
  // Personal phrases that share words with what was heard.
  const heardWords = new Set(words(t).filter((w) => w.length > 3));
  for (const phrase of personalPhrases) {
    if (words(phrase).some((w) => heardWords.has(w))) add(phrase, "phrase");
  }
  add("Give me a moment to answer");
  add("Please repeat that");
  return out.slice(0, limit);
}

/** What would be sent to Claude for reply suggestions, shown to the person before consent. */
export function claudeSuggestionRequest(heard: string, recentlySaid: readonly string[]): string {
  const context =
    recentlySaid
      .slice(-3)
      .map((s) => `- ${s}`)
      .join("\n") || "- (nothing yet)";
  return [
    "Suggest up to 4 short replies (under 10 words each) that the person could say next, in their voice.",
    "Things the person said recently:",
    context,
    "What the other person just said:",
    asUntrustedData("speech heard in the room", heard),
  ].join("\n");
}

/** Consent for Claude suggestions lasts for one conversation and is off by default. */
export interface ConversationConsent {
  listening: boolean;
  claude: boolean;
}

export const NO_CONSENT: ConversationConsent = { listening: false, claude: false };
