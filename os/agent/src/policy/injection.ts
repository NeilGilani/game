/**
 * Untrusted content (web pages, emails, documents, transcripts) is data, never instructions.
 * This detector looks for text aimed at an AI agent. A hit pauses the task and shows the person.
 * It is a tripwire, not the defence: the guard enforces approvals whatever the model was told.
 */

export interface InjectionFinding {
  /** The matching excerpt, at most 200 characters, for the person to see. */
  excerpt: string;
  pattern: string;
}

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "ignore-instructions", re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|the)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|directions?|guidelines?)/i },
  { name: "addressed-to-ai", re: /\b(attention|note|message|instructions?)\s+(to|for)\s+(the\s+)?(ai|assistant|agent|llm|model|claude|chatbot|bot)\b/i },
  { name: "ai-imperative", re: /\b(ai|assistant|agent|claude|llm|language model)s?\b[^.\n]{0,20}\b(must|should|need to|are required to|now)\b[^.\n]{0,60}\b(click|send|transfer|pay|buy|order|navigate|go to|visit|open|type|enter|email|forward|delete|approve|call|reveal|share)\b/i },
  { name: "role-reassignment", re: /\b(you are now|from now on,? you|act as|pretend to be|new (system )?(prompt|instructions?|role))\b/i },
  { name: "system-tag", re: /(<\/?\s*(system|assistant|instructions?|admin)\s*>|\[\s*(system|inst)\s*\]|<\|im_start\|>|###\s*(system|instruction))/i },
  { name: "secret-exfiltration", re: /\b(send|email|forward|post|share|reveal|tell)\b[^.\n]{0,40}\b(password|passcode|2fa|one[- ]time code|card number|cvv|api key|credentials?|ssn|social security)/i },
  { name: "hidden-approval", re: /\b(already (been )?approved|no (need for|need to ask for) (approval|confirmation)|without (asking|confirmation|approval)|skip (the )?(approval|confirmation))\b/i },
];

export function detectInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const { name, re } of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - 60);
    const end = Math.min(text.length, m.index + m[0].length + 80);
    findings.push({ pattern: name, excerpt: text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 200) });
  }
  return findings;
}

/** Wrap untrusted text so the model sees exactly where data begins and ends. */
export function asUntrusted(source: string, text: string): string {
  const clean = text.replace(/<\/?untrusted[^>]*>/gi, "");
  return `<untrusted source="${source.replace(/"/g, "'")}">\n${clean}\n</untrusted>`;
}
