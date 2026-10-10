/**
 * Secrets the agent must never type, read out or send: passwords, one-time codes, payment card numbers.
 * Detection is deliberately broad; a false positive hands control to the person, which is safe.
 */

import type { ActionTarget, PageNode } from "../types";

const SECRET_AUTOCOMPLETE =
  /^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)$/i;
const SECRET_LABEL =
  /\b(pass(word|code|phrase)?|pin|cvv|cvc|csc|security code|card number|credit card|debit card|verification code|one[- ]time (code|password)|2fa|two[- ]factor|otp|authenticat(or|ion) code|sms code)\b/i;

export function isSecretField(
  field: Pick<PageNode, "name" | "secure" | "autocomplete"> | ActionTarget,
): boolean {
  if ("secure" in field && field.secure) return true;
  if ("autocomplete" in field && field.autocomplete && SECRET_AUTOCOMPLETE.test(field.autocomplete))
    return true;
  const label = "name" in field ? field.name : (field as ActionTarget).label;
  return label !== undefined && SECRET_LABEL.test(label);
}

/** Luhn-valid runs of 13 to 19 digits (spaces or dashes allowed between groups). */
export function containsCardNumber(text: string): boolean {
  const candidates = text.match(/\b(?:\d[ -]?){12,18}\d\b/g) ?? [];
  return candidates.some((c) => luhn(c.replace(/[ -]/g, "")));
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A short code typed right after text that looks like a 2FA prompt, or text that names itself a password. */
export function looksLikeSecretText(text: string): string | null {
  if (containsCardNumber(text)) return "a payment card number";
  if (/\b(password|passcode|pin)\s*[:=]\s*\S+/i.test(text)) return "a password";
  if (
    /\b(code|otp|2fa)\s*[:=]?\s*\d{4,8}\b/i.test(text) &&
    /\b(verif|one[- ]time|2fa|otp|login|sign[- ]in)/i.test(text)
  )
    return "a one-time code";
  return null;
}

/** Remove card numbers and obvious secrets from text before it reaches the model or the audit log. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/[ -]/g, "")) ? "[card number hidden]" : m))
    .replace(/\b(password|passcode|pin)(\s*[:=]\s*)\S+/gi, "$1$2[hidden]")
    .replace(
      /\b((?:verification|security|one[- ]time|login|sign[- ]in)\s+code(?:\s+is)?\s*[:=]?\s*)\d{4,8}\b/gi,
      "$1[hidden]",
    );
}
