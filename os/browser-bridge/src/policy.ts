/**
 * Safety policy for the bridge, as pure functions so they are easy to test:
 *  - protected sites (banking, password managers, account security) need the person's own allowance;
 *  - secret fields (passwords, one-time codes, card fields) are never read or typed into;
 *  - text that contains a card number is never typed;
 *  - which clicks are consequential and need an approval bound to the exact action.
 */

import type { ConsequentialKind } from "../../contracts/src/index.ts";
import type { BlockCategory } from "./protocol.ts";

const BANKING = [
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "citi.com",
  "citibank.com",
  "capitalone.com",
  "usbank.com",
  "pnc.com",
  "truist.com",
  "tdbank.com",
  "ally.com",
  "discover.com",
  "americanexpress.com",
  "schwab.com",
  "fidelity.com",
  "vanguard.com",
  "etrade.com",
  "sofi.com",
  "chime.com",
  "navyfederal.org",
  "usaa.com",
  "hsbc.com",
  "hsbc.co.uk",
  "barclays.co.uk",
  "lloydsbank.com",
  "natwest.com",
  "santander.com",
  "santander.co.uk",
  "monzo.com",
  "revolut.com",
  "paypal.com",
  "venmo.com",
  "wise.com",
  "zellepay.com",
  "coinbase.com",
  "robinhood.com",
  // The sandbox web world's pretend bank, so the rule is testable without real banks.
  "bank.localhost",
];

const PASSWORD_MANAGERS = [
  "1password.com",
  "1password.ca",
  "1password.eu",
  "lastpass.com",
  "bitwarden.com",
  "dashlane.com",
  "keepersecurity.com",
  "nordpass.com",
  "roboform.com",
  "passwords.google.com",
];

const ACCOUNT_SECURITY: Array<{ host: string; path?: RegExp }> = [
  { host: "accounts.google.com" },
  { host: "myaccount.google.com", path: /^\/(security|signinoptions|password|two-step|apppasswords)/ },
  { host: "account.apple.com" },
  { host: "appleid.apple.com" },
  { host: "iforgot.apple.com" },
  { host: "account.microsoft.com", path: /^\/security/ },
  { host: "login.live.com" },
  { host: "account.proton.me" },
  { host: "pass.proton.me" },
];

/** Hostnames that look like a bank even if they're not on the list. */
const BANKISH = /(^|[.-])(bank|banking|creditunion|federalcu|fcu)([.-]|$)|bank\b/;

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

export interface Classification {
  category: BlockCategory;
  reason: string;
}

/** Is this URL a protected site? `extraHosts` are hosts the person or a helper added. */
export function classifyUrl(url: string, extraHosts: readonly string[] = []): Classification | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { category: "browser-internal", reason: "Not a web address." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { category: "browser-internal", reason: "Browser and system pages are off limits." };
  }
  const host = u.hostname.toLowerCase();
  if (host === "chromewebstore.google.com" || (host === "chrome.google.com" && u.pathname.startsWith("/webstore")))
    return { category: "browser-internal", reason: "Extension store: installing software is the person's decision." };
  for (const d of extraHosts) if (hostMatches(host, d.toLowerCase())) return { category: "custom", reason: "Added to the protected list." };
  for (const d of PASSWORD_MANAGERS) if (hostMatches(host, d)) return { category: "password-manager", reason: "Password manager." };
  for (const r of ACCOUNT_SECURITY)
    if (hostMatches(host, r.host) && (!r.path || r.path.test(u.pathname)))
      return { category: "account-security", reason: "Account sign-in or security settings." };
  for (const d of BANKING) if (hostMatches(host, d)) return { category: "banking", reason: "Bank or payments." };
  if (BANKISH.test(host)) return { category: "banking", reason: "Looks like a bank." };
  return null;
}

/** Only ordinary web pages may be opened by the agent. */
export function isOpenableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

const SECRET_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
]);

const SECRET_NAME = /pass(word|wd|code)?|\bpin\b|otp|one[-_ ]?time|2fa|mfa|verification[-_ ]?code|security[-_ ]?code|cvv|cvc|csc|card[-_ ]?number|cc[-_]?num/i;

export interface FieldFacts {
  tag: string;
  type?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  label?: string | null;
  inputmode?: string | null;
}

/** Secret fields: never read their value, never type into them, never autofill. */
export function isSecretField(f: FieldFacts): boolean {
  const tag = f.tag.toLowerCase();
  if (tag !== "input" && tag !== "textarea") return false;
  if ((f.type ?? "").toLowerCase() === "password") return true;
  for (const token of (f.autocomplete ?? "").toLowerCase().split(/\s+/)) if (SECRET_AUTOCOMPLETE.has(token)) return true;
  const hay = [f.name, f.id, f.label].filter(Boolean).join(" ");
  return SECRET_NAME.test(hay);
}

function luhnValid(digits: string): boolean {
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

/** True if the text contains something that looks like a payment card number (13-19 digits, Luhn-valid). */
export function containsCardNumber(text: string): boolean {
  const candidates = text.match(/(?:\d[ -]?){12,18}\d/g) ?? [];
  return candidates.some((c) => {
    const digits = c.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });
}

/** Unmistakable actions. `links` marks the ones that count even on a link (e.g. "Buy now" links). */
const STRONG: Array<[ConsequentialKind, RegExp, { links: boolean }]> = [
  ["purchase", /\b(place( your)? order|order now|pay( now)?|buy( now)?|purchase|checkout and pay|confirm (and )?(order|payment|purchase)|complete (order|purchase)|subscribe|donate|add funds|transfer|send money)\b/i, { links: true }],
  ["sign", /\b(sign(?!\s*(in|up|out|on)\b)( document| here| now)?|adopt and sign|e-?sign)\b/i, { links: false }],
  ["send", /\b(send|post|reply|forward|publish|share|tweet)\b/i, { links: false }],
  ["delete", /\b(delete|trash|erase|discard|cancel (order|appointment|booking|subscription|membership|refill)|close account|deactivate)\b/i, { links: true }],
  ["account-or-settings", /\b(save (settings|changes|preferences)|change (password|email|settings)|update (account|profile|password|settings)|enable|disable|turn (on|off))\b/i, { links: false }],
  ["install", /\b(install|add to chrome|download and install)\b/i, { links: true }],
  ["call", /\b(call now|place call|start call|dial)\b/i, { links: true }],
];

/** Steps on the way to something, which are easy to undo: no approval for these. */
const REVERSIBLE = /^(add\b|search|find|filter|sort|next|continue|save and continue|review|preview|update\b|back|edit|change\b|show|view|see|go\b|remove\b|open|load more|more)/i;

const SUBMIT = /\b(submit|apply|request( refill)?|book( appointment| now)?|confirm|finish|complete|register|sign up|enroll|schedule|reserve)\b/i;

export interface ActionFacts {
  role: string;
  name: string;
  /** The element submits a form when activated (submit button, or Enter in a form field). */
  submitsForm: boolean;
  /** The form's method, if any. */
  formMethod?: string | null;
}

/**
 * The bridge's own reading of whether an action is consequential. This is a second line of defence; the
 * agent runtime decides risk too. It errs on the side of asking.
 */
export function classifyAction(a: ActionFacts): ConsequentialKind | null {
  const name = a.name.replace(/\s+/g, " ").trim();
  const isLink = a.role === "link" && !a.submitsForm;
  const actsLikeButton = a.submitsForm || /^(button|link|menuitem|checkbox|switch|radio|tab|option|clickable)$/.test(a.role);
  if (!actsLikeButton) return null;
  for (const [kind, re, { links }] of STRONG) if (re.test(name) && (links || !isLink)) return kind;
  if (REVERSIBLE.test(name)) return null;
  if (!isLink && SUBMIT.test(name)) return "submit";
  // Any other form that posts data somewhere is a submission.
  if (a.submitsForm && (a.formMethod ?? "get").toLowerCase() === "post") return "submit";
  return null;
}
