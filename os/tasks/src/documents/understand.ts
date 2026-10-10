/**
 * Understanding a document: a plain-language summary (Claude, only with consent and showing
 * exactly what is sent), a local "quick facts" fallback that needs no model, filling fields
 * from the profile, and the intent statement for signing.
 */

import { isSecretField, redactSecrets } from "../policy/secrets";
import { asUntrustedData } from "../policy/untrusted";
import { addressLine, type Profile } from "../profile";
import type { FormField, LoadedDocument } from "./types";

/** At most this much document text is sent for a summary. Send the minimum (constitution 7). */
export const SUMMARY_CHAR_LIMIT = 12000;

export function summaryPayload(doc: LoadedDocument): { text: string; truncated: boolean } {
  const full = redactSecrets(doc.pages.join("\n\n"));
  const truncated = full.length > SUMMARY_CHAR_LIMIT;
  const body = truncated ? full.slice(0, SUMMARY_CHAR_LIMIT) : full;
  const text = [
    "Explain this document in plain language for someone who reads slowly and tires easily.",
    "Use at most 6 short sentences: who it is from, what it is about, what they must do, by when, and any amount of money.",
    "Say clearly if it asks for a signature and what signing would mean.",
    asUntrustedData(`the document "${doc.name}"`, body),
  ].join("\n");
  return { text, truncated };
}

export interface Summarizer {
  readonly kind: "claude" | "fake";
  summarize(payload: string): Promise<string>;
}

export class FakeSummarizer implements Summarizer {
  readonly kind = "fake" as const;
  readonly received: string[] = [];
  constructor(private readonly reply = "This is a simulated summary. No model was used.") {}
  async summarize(payload: string): Promise<string> {
    this.received.push(payload);
    return this.reply;
  }
}

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";

/** Facts found by simple patterns, with no model. Labelled as such in the UI. */
export function quickFacts(doc: LoadedDocument): string[] {
  const text = doc.pages.join("\n");
  const facts: string[] = [];
  facts.push(`${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}.`);
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 3);
  if (firstLine) facts.push(`It starts: “${firstLine.slice(0, 120)}”`);
  const dates = new Set(
    text.match(new RegExp(`\\b(?:(?:${MONTHS}) \\d{1,2},? \\d{4}|\\d{1,2}/\\d{1,2}/\\d{2,4})\\b`, "g")) ?? [],
  );
  if (dates.size) facts.push(`Dates mentioned: ${[...dates].slice(0, 4).join(", ")}.`);
  const deadline =
    /(?:by|before|no later than|due(?: date)?:?)\s+([A-Z][a-z]+ \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/.exec(
      text,
    );
  if (deadline) facts.push(`It mentions a deadline: ${deadline[1]}.`);
  const amounts = new Set(text.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? []);
  if (amounts.size) facts.push(`Amounts of money: ${[...amounts].slice(0, 4).join(", ")}.`);
  if (/\bsignature\b|\bsign\b/i.test(text)) facts.push("It asks for a signature.");
  if (doc.fields.length)
    facts.push(`It has ${doc.fields.length} field${doc.fields.length === 1 ? "" : "s"} to fill in.`);
  return facts;
}

export interface FillProposal {
  field: string;
  value: string;
  /** Which profile detail it came from, shown to the person. */
  from: string;
}

/** Match form fields to profile details by name. Secret fields (SSN, card, PIN...) are never filled. */
export function proposeFills(fields: readonly FormField[], profile: Profile): FillProposal[] {
  const out: FillProposal[] = [];
  const address = addressLine(profile);
  const firstName = profile.fullName.split(/\s+/)[0] ?? profile.fullName;
  const lastName = profile.fullName.split(/\s+/).slice(1).join(" ");
  for (const f of fields) {
    if (f.type !== "text" || isSecretField({ name: f.name })) continue;
    if (f.value && f.value.trim()) continue;
    const n = f.name.toLowerCase().replace(/[_\-.]+/g, " ");
    const add = (value: string | undefined, from: string) => {
      if (value) out.push({ field: f.name, value, from });
    };
    if (/\b(first|given) ?name\b/.test(n)) add(firstName, "First name");
    else if (/\b(last|family|sur) ?name\b/.test(n)) add(lastName, "Last name");
    else if (/\b(full )?name\b/.test(n) && !/\b(company|employer|doctor|signature)\b/.test(n))
      add(profile.fullName, "Full name");
    else if (/\b(dob|date of birth|birth ?date)\b/.test(n)) add(profile.dateOfBirth, "Date of birth");
    else if (/\b(e ?mail)\b/.test(n)) add(profile.email, "Email");
    else if (/\b(phone|tel|mobile)\b/.test(n)) add(profile.phone, "Phone");
    else if (/\b(zip|postal)\b/.test(n)) add(profile.address?.postalCode, "Postal code");
    else if (/\bcity\b/.test(n)) add(profile.address?.city, "City");
    else if (/\b(state|region|province)\b/.test(n)) add(profile.address?.region, "State");
    else if (/\baddress\b/.test(n)) add(address, "Address");
  }
  return out;
}

export function intentStatement(signerName: string, documentName: string, pageCount: number): string {
  return `I, ${signerName}, intend to sign "${documentName}" electronically. I have seen all ${pageCount} page${pageCount === 1 ? "" : "s"}, and I understand that signing means I agree to what it says.`;
}

export const WHAT_SIGNING_MEANS = [
  "Your signature says you agree to what this document says.",
  "It can have the same effect as signing on paper.",
  "You can't easily take it back after it is sent.",
  "If anything is unclear, stop now and ask someone you trust.",
];
