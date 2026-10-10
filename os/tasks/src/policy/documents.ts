/**
 * What AGENCY will and won't sign. Some documents need formalities an eye-gaze click can't
 * provide (witnesses, a notary, capacity checks), and signing for someone else needs legal
 * authority AGENCY can't verify. For those, AGENCY explains the proper route instead.
 *
 * The check is conservative: any strong signal refuses. The document text is untrusted
 * data; it can make AGENCY refuse, but it can never make AGENCY sign.
 */

export type RefusalCategory = "will" | "power-of-attorney" | "notarized" | "on-behalf" | "health-directive";

export interface SigningRefusal {
  category: RefusalCategory;
  title: string;
  why: string;
  properRoute: string;
  evidence: string;
}

const RULES: { category: RefusalCategory; re: RegExp; title: string; why: string; properRoute: string }[] = [
  {
    category: "will",
    re: /\b(last will( and testament)?|this (is my )?will\b|testament(ary)?|codicil|testator|testatrix|executor of (my|this) (will|estate)|bequeath)/i,
    title: "This looks like a will",
    why: "Wills usually need witnesses (and sometimes a notary) who watch you sign. In most places an electronic signature alone does not make a valid will.",
    properRoute:
      "Ask a lawyer or legal aid service about making a will with an accessible signing method. Many can arrange witnesses, a notary or an alternative mark recognised where you live.",
  },
  {
    category: "power-of-attorney",
    re: /\b(power of attorney|attorney[- ]in[- ]fact|durable power|lasting power of attorney|\bLPA\b|enduring power|appoint .{0,40} (as )?my (agent|attorney))/i,
    title: "This looks like a power of attorney",
    why: "A power of attorney gives someone legal power over your affairs. It usually needs a witness or notary, and sometimes a check that you understand it.",
    properRoute:
      "Arrange it with a lawyer, notary or your local office for powers of attorney. They can confirm your choice in a way that is recognised, including for people who sign with their eyes.",
  },
  {
    category: "notarized",
    re: /\b(notary public|notari[sz]ed|notarial|before me,? the undersigned|sworn (to|before)|subscribed and sworn|acknowledg(e)?ment before|my commission expires|jurat|affidavit|under penalty of perjury.{0,40}notary)/i,
    title: "This needs a notary",
    why: "A notarised document must be signed in front of a notary (in person or through an approved remote notary). AGENCY can't stand in for that.",
    properRoute:
      "Book a notary. Many offer remote online notarisation with video, and they can accommodate someone who signs with eye gaze. Bring this document to them.",
  },
  {
    category: "health-directive",
    re: /\b(advance (health ?care )?directive|living will|health ?care proxy|do not resuscitate|\bDNR\b|POLST|MOLST)/i,
    title: "This is a health care directive",
    why: "Advance directives and DNR orders usually need witnesses or a clinician, and the rules differ a lot by place.",
    properRoute:
      "Go through it with your care team or a lawyer. They can make sure your wishes are recorded in the form your hospital and state accept.",
  },
  {
    category: "on-behalf",
    re: /\b(on behalf of|for and on behalf|as (legal )?(guardian|agent|representative|trustee|executor) (of|for)|signing for (another|someone)|authori[sz]ed (signatory|representative) (of|for))/i,
    title: "This is signed for someone else",
    why: "AGENCY only signs as you, for yourself. Signing for another person or an organisation needs authority AGENCY can't check.",
    properRoute:
      "The person or organisation should sign it themselves, or the person with legal authority should sign through their usual process.",
  },
];

export function checkSignable(
  text: string,
  opts: { signingFor?: "self" | "someone-else" } = {},
): SigningRefusal | null {
  if (opts.signingFor === "someone-else") {
    const rule = RULES.find((r) => r.category === "on-behalf")!;
    return {
      category: rule.category,
      title: rule.title,
      why: rule.why,
      properRoute: rule.properRoute,
      evidence: "You chose to sign for someone else.",
    };
  }
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) {
      const start = Math.max(0, m.index - 30);
      return {
        category: rule.category,
        title: rule.title,
        why: rule.why,
        properRoute: rule.properRoute,
        evidence: text
          .slice(start, m.index + m[0].length + 30)
          .replace(/\s+/g, " ")
          .trim(),
      };
    }
  }
  return null;
}

export const ESIGN_NOTE =
  "Rules for electronic signatures differ by country and state. Many everyday forms accept them (in the US under the ESIGN Act and UETA; in the EU under eIDAS), but some documents don't. If you're unsure, ask whoever sent you the document whether an electronic signature is accepted.";
