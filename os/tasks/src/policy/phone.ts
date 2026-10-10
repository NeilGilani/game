/**
 * Phone number policy for the call pack. Calls from AGENCY never reach emergency or crisis
 * services: Lifeline handles emergencies, and an automated or text-to-speech call to a
 * dispatcher is the owner's decision, not ours (PLAN.md, safety constitution 4).
 *
 * The check is deliberately broad: it blocks every short code, every N11 code, known
 * emergency and crisis numbers in many countries (with or without a country code), and
 * anything that doesn't look like a full phone number. Refusing a harmless number is
 * cheap; dialling an emergency line by accident is not.
 */

/** Emergency and crisis numbers by country (national form, digits only). */
const EMERGENCY_NUMBERS = new Set([
  "911", // US, Canada, Mexico and more
  "112", // EU, many others, GSM standard
  "999", // UK, Ireland and others
  "000", // Australia
  "111", // New Zealand
  "110", // Germany/Japan/China police
  "119", // Japan/Korea fire and ambulance
  "118",
  "120",
  "122",
  "100", // India and others
  "101",
  "102",
  "108",
  "15", // France SAMU
  "17", // France police
  "18", // France fire
  "113",
  "114", // France SMS for deaf people
  "115",
  "116000", // EU missing children
  "116111", // EU child helpline
  "116117",
  "116123", // emotional support
  "988", // US 988 Suicide & Crisis Lifeline
  "999999",
  "10111", // South Africa police
  "10177", // South Africa ambulance
  "106", // Australia text relay emergency
  "190", // Brazil police
  "192", // Brazil ambulance
  "193", // Brazil fire
  "060",
  "066",
  "065",
  "080",
  "1669", // Thailand ambulance
]);

/** Country calling codes we strip before checking the national number. */
const COUNTRY_CODES = [
  "1",
  "7",
  "20",
  "27",
  "30",
  "31",
  "32",
  "33",
  "34",
  "36",
  "39",
  "40",
  "41",
  "43",
  "44",
  "45",
  "46",
  "47",
  "48",
  "49",
  "51",
  "52",
  "53",
  "54",
  "55",
  "56",
  "57",
  "58",
  "60",
  "61",
  "62",
  "63",
  "64",
  "65",
  "66",
  "81",
  "82",
  "84",
  "86",
  "90",
  "91",
  "92",
  "93",
  "94",
  "95",
  "98",
  "212",
  "213",
  "216",
  "234",
  "254",
  "353",
  "354",
  "351",
  "352",
  "358",
  "380",
  "420",
  "421",
  "852",
  "880",
  "886",
  "971",
  "972",
  "966",
];

export type PhoneCheck =
  | { ok: true; e164: string; display: string }
  | { ok: false; reason: "emergency" | "short-code" | "invalid" | "premium"; message: string };

export function digitsOnly(text: string): string {
  return text.replace(/[^\d+]/g, "");
}

function nationalCandidates(digits: string): string[] {
  const out = new Set<string>([digits]);
  for (const cc of COUNTRY_CODES) {
    if (digits.startsWith(cc)) {
      const rest = digits.slice(cc.length);
      out.add(rest);
      // Trunk prefix (0 in much of Europe, e.g. +44 0...).
      if (rest.startsWith("0")) out.add(rest.slice(1));
    }
  }
  if (digits.startsWith("0")) out.add(digits.slice(1));
  return [...out];
}

const LIFELINE_MESSAGE =
  "AGENCY never calls emergency or crisis lines from Calls. For an emergency, use Lifeline: it alerts your helpers right away.";

/**
 * Normalises and checks a number for an outgoing call. `defaultCountry` is a calling code
 * used for numbers written without one (default "1", North America).
 */
export function checkOutgoingNumber(raw: string, defaultCountry = "1"): PhoneCheck {
  const cleaned = digitsOnly(raw.trim());
  const hasPlus = cleaned.startsWith("+") || raw.trim().startsWith("00");
  let digits = cleaned.replace(/\+/g, "");
  if (raw.trim().startsWith("00")) digits = digits.slice(2);
  if (digits.length === 0) return { ok: false, reason: "invalid", message: "That isn't a phone number." };

  for (const candidate of nationalCandidates(digits)) {
    if (EMERGENCY_NUMBERS.has(candidate))
      return { ok: false, reason: "emergency", message: LIFELINE_MESSAGE };
  }
  // N11 codes (211, 311, 411 ... 911) and any number this short are service codes.
  if (/^[2-9]11$/.test(digits) || digits.length <= 6) {
    return {
      ok: false,
      reason: "short-code",
      message: `${LIFELINE_MESSAGE} Short service numbers can't be called from here either.`,
    };
  }

  let e164: string;
  if (hasPlus) e164 = `+${digits}`;
  else if (defaultCountry === "1" && digits.length === 10) e164 = `+1${digits}`;
  else if (defaultCountry === "1" && digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else if (digits.startsWith("0")) e164 = `+${defaultCountry}${digits.slice(1)}`;
  else e164 = `+${defaultCountry}${digits}`;

  const national = e164.slice(1);
  if (national.length < 8 || national.length > 15)
    return {
      ok: false,
      reason: "invalid",
      message: "That number doesn't look complete. Check it with a helper.",
    };
  // North American premium-rate (900/976) numbers cost money per minute.
  if (/^1(900|976)/.test(national))
    return {
      ok: false,
      reason: "premium",
      message: "Premium-rate numbers that charge per minute are blocked.",
    };

  return { ok: true, e164, display: formatDisplay(e164) };
}

export function formatDisplay(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (m) return `+1 (${m[1]}) ${m[2]}-${m[3]}`;
  return e164.replace(
    /^(\+\d{1,3})(\d+)$/,
    (_s, cc: string, rest: string) => `${cc} ${rest.replace(/(\d{3,4})(?=\d)/g, "$1 ")}`,
  );
}
