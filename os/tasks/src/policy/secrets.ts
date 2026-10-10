/**
 * No secrets in the agent's hands (safety constitution 5). Packs never type, read, store or
 * send passwords, 2FA codes or payment card numbers. These detectors are a backstop: packs
 * are written so they never need such values, and refuse if one shows up anyway.
 */

/** Luhn check on 13 to 19 digits: the shape of a payment card number. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
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

/** True when the text contains something that looks like a card number. */
export function containsCardNumber(text: string): boolean {
  const runs = text.match(/(?:\d[ -]?){13,19}/g) ?? [];
  return runs.some((r) => luhnValid(r.replace(/[ -]/g, "")));
}

const SECRET_FIELD =
  /(pass(word|code|phrase)?|pwd|pin\b|otp|2fa|one[- ]?time|verification code|security code|cvv|cvc|csc|card ?(number|no)|cc-?num|iban|routing|account ?number|ssn|social security)/i;

/** True when a form field's name, label or autocomplete hint asks for a secret. */
export function isSecretField(field: {
  name?: string;
  label?: string;
  autocomplete?: string;
  type?: string;
}): boolean {
  if (field.type === "password") return true;
  if (field.autocomplete && /^(cc-|one-time-code|current-password|new-password)/.test(field.autocomplete))
    return true;
  return SECRET_FIELD.test(`${field.name ?? ""} ${field.label ?? ""}`);
}

/** Replace anything card-like with a mask, for logs and prompts. */
export function redactSecrets(text: string): string {
  return text.replace(/(?:\d[ -]?){13,19}/g, (run) =>
    luhnValid(run.replace(/[ -]/g, "")) ? "[card number removed]" : run,
  );
}
