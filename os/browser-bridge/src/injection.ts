/**
 * Flags page text that looks like it is trying to instruct an AI. This never makes content trusted: all
 * page content is data either way. It helps the agent notice an attempt, stop, and show the person.
 */

const RULES: Array<[string, RegExp]> = [
  ["ignore previous instructions", /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|your)\b.{0,30}\b(instructions?|prompts?|rules|directions)\b/i],
  ["new instructions", /\b(new|updated|real|actual|hidden|secret)\s+(instructions?|orders|directive|task)\b/i],
  ["addresses the AI", /\b(AI|LLM|language model|assistant|agent|Claude|ChatGPT|GPT|bot)\b\s*[,:]?\s*(you must|you should|please|must|now|immediately|do not|don't|stop)\b/i],
  ["role marker", /(^|\n|\s)(system|assistant|developer)\s*(prompt)?\s*:/i],
  ["fake approval", /\b(the (user|person|owner) (has )?(already )?(approved|authori[sz]ed|consented)|approval (is )?(granted|not needed|already given)|pre-?approved)\b/i],
  ["asks for secrets", /\b(enter|type|send|share|reveal|provide)\b.{0,40}\b(password|passcode|2fa|one[- ]time code|verification code|card number|cvv|security code|seed phrase)\b/i],
  ["exfiltration", /\b(send|forward|email|post|upload|copy)\b.{0,50}\b(all|every|the user's|their|your)\b.{0,30}\b(emails?|messages|contacts|files|data|history|cookies|address|details)\b/i],
  ["tool call markup", /<\s*\/?\s*(tool_call|function_calls?|invoke|system|instructions?)\b/i],
];

export function detectInjection(text: string): string[] {
  const found: string[] = [];
  for (const [label, re] of RULES) {
    const m = re.exec(text);
    if (m) found.push(`${label}: "${excerpt(text, m.index, m[0].length)}"`);
  }
  return found;
}

function excerpt(text: string, at: number, len: number): string {
  const s = text.slice(Math.max(0, at - 10), Math.min(text.length, at + len + 30));
  return s.replace(/\s+/g, " ").trim().slice(0, 140);
}
