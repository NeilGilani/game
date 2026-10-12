/**
 * Filling a form, one field at a time. Each field becomes a step with answers to choose
 * from, and those answers only ever come from details the person saved (or what the form
 * already says, or today's date). Nothing personal is invented: with no saved detail, the
 * step asks. Secret fields (passwords, card or ID numbers) are never filled by AGENCY.
 */

import { isSecretField } from "../policy/secrets";
import type { Profile } from "../profile";
import { proposeFills } from "./understand";

/** A fillable field, read from the PDF's form (AcroForm). */
export interface PaperField {
  name: string;
  /** The form's own tooltip for the field, when it has one; otherwise made from the name. */
  label: string;
  type: "text" | "checkbox" | "choice" | "signature";
  value: string;
  /** For choice fields (dropdowns, radio buttons): the allowed values. */
  options?: string[];
  maxLength?: number;
  multiline?: boolean;
  page?: number;
  readOnly?: boolean;
}

export interface FieldSuggestion {
  value: string;
  /** Where it came from, shown under it: "Your saved name", "Already on the form". */
  from: string;
}

export interface FieldStep {
  field: PaperField;
  suggestions: FieldSuggestion[];
  /** Passwords, card and ID numbers: AGENCY leaves these for a helper. */
  secret: boolean;
}

/** "applicant_full_name" -> "Applicant full name". */
export function humanize(name: string): string {
  const last = name.split(".").pop() ?? name;
  const words = last
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

const DATE_FIELD = /\bdate\b/i;
const BIRTH = /\b(birth|dob|born)\b/i;

export function todayText(now: Date): string {
  return now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** Answers for one field, from saved details only. */
export function suggestionsFor(
  field: PaperField,
  details: Profile | null,
  now = new Date(),
): FieldSuggestion[] {
  const out: FieldSuggestion[] = [];
  const add = (value: string | undefined, from: string) => {
    const v = (value ?? "").trim();
    if (!v || out.some((s) => s.value === v)) return;
    if (field.maxLength && v.length > field.maxLength) return;
    out.push({ value: v, from });
  };
  if (field.value.trim()) add(field.value, "Already on the form");
  if (field.type !== "text") return out;
  const probe = `${field.name} ${field.label}`;
  if (details) {
    for (const p of proposeFills([{ name: probe, type: "text" }], details))
      add(p.value, `Your saved ${p.from.toLowerCase()}`);
  }
  if (DATE_FIELD.test(probe) && !BIRTH.test(probe)) add(todayText(now), "Today's date");
  return out;
}

/** The steps for a form: every field the person can fill, in the form's order. */
export function formSteps(
  fields: readonly PaperField[],
  details: Profile | null,
  now = new Date(),
): FieldStep[] {
  return fields
    .filter((f) => f.type !== "signature" && !f.readOnly)
    .map((field) => {
      const secret = isSecretField({ name: field.name, label: field.label });
      return { field, secret, suggestions: secret ? [] : suggestionsFor(field, details, now) };
    });
}

/** Is this answer allowed for this field? (Choice fields only take their own options.) */
export function validAnswer(field: PaperField, value: string): boolean {
  if (field.type === "checkbox") return value === "" || value === "yes";
  if (field.type === "choice") return value === "" || (field.options ?? []).includes(value);
  if (field.maxLength && value.length > field.maxLength) return false;
  return value.length <= 2000;
}

/** "Form.pdf" -> "Form-filled.pdf". The desktop host picks a free name if that one exists. */
export function copyName(original: string, suffix: "filled" | "signed"): string {
  const stem = original.replace(/\.pdf$/i, "");
  return `${stem}-${suffix}.pdf`;
}
