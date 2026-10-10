/**
 * The person's profile, used to fill forms and offer replies like "My name is ...".
 * Filling or saying any of it is shown word for word before it happens. It never holds
 * passwords, codes, card numbers or government ID numbers.
 */

export interface Profile {
  fullName: string;
  /** Shown in disclosures: "a text-to-speech voice for Riley". */
  preferredName: string;
  dateOfBirth?: string;
  phone?: string;
  email?: string;
  address?: {
    line1: string;
    line2?: string;
    city: string;
    region: string;
    postalCode: string;
    country?: string;
  };
}

export function addressLine(p: Profile): string | undefined {
  const a = p.address;
  if (!a) return undefined;
  return [a.line1, a.line2, `${a.city}, ${a.region} ${a.postalCode}`].filter(Boolean).join(", ");
}

/** Riley, the fictional person in the demo story (PLAN.md). */
export const DEMO_PROFILE: Profile = {
  fullName: "Riley Morgan",
  preferredName: "Riley",
  dateOfBirth: "March 3, 1984",
  phone: "+1 (555) 555-0199",
  email: "riley@example.com",
  address: { line1: "12 Harbor Lane", city: "Springfield", region: "OR", postalCode: "97477", country: "US" },
};

/** Replies built from the profile when the other party asks for these details. */
export function profileReplies(heard: string, p: Profile): string[] {
  const t = heard.toLowerCase();
  const out: string[] = [];
  const wantsName = /\b(name)\b/.test(t);
  const wantsDob = /\b(date of birth|birthday|born|dob)\b/.test(t);
  if (wantsName && wantsDob && p.dateOfBirth) out.push(`${p.fullName}, born ${p.dateOfBirth}`);
  else if (wantsName) out.push(`My name is ${p.fullName}`);
  else if (wantsDob && p.dateOfBirth) out.push(`My date of birth is ${p.dateOfBirth}`);
  const addr = addressLine(p);
  if (/\b(address|where do you live)\b/.test(t) && addr) out.push(`My address is ${addr}`);
  if (/\b(phone|number|reach you)\b/.test(t) && p.phone) out.push(`My number is ${p.phone}`);
  return out;
}
