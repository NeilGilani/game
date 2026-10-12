/**
 * How AGENCY reads a pop-up's buttons, as pure rules (unit-tested). It never presses anything by itself: the person
 * sees the pop-up's own choices as big buttons, the least sharing first ("Reject all" before "Accept all").
 */

import type { PopupChoice, PopupInfo } from "@agency/contracts";

const DECLINE =
  /\b(reject( all)?|decline( all)?|necessary only|only (strictly )?necessary|essential only|use necessary|refuse|deny|do not (accept|agree|sell)|disagree|continue without (accepting|agreeing))\b/i;
const CLOSE = /^(x|×|✕|✖)$|\b(close|dismiss|no,? thanks|not now|maybe later|skip|cancel|hide|later)\b/i;
const ACCEPT = /\b(accept( all)?|agree|allow( all)?|got it|i understand|okay|ok|continue|yes)\b/i;
const COOKIES =
  /\b(cookies?|consent|gdpr|ccpa|privacy (choices|settings|preferences)|we (and our partners )?use|tracking)\b/i;

export function toneOf(label: string): PopupChoice["tone"] {
  const l = label.trim();
  if (DECLINE.test(l)) return "decline";
  if (CLOSE.test(l)) return "close";
  if (ACCEPT.test(l)) return "accept";
  return "other";
}

/** A plain label for a button with only a symbol on it. */
export function labelOf(name: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  if (/^(x|×|✕|✖)$/i.test(n) || n === "") return "Close";
  return n.slice(0, 60);
}

const ORDER: Record<PopupChoice["tone"], number> = { decline: 0, close: 1, other: 2, accept: 3 };

/** The pop-up's choices, least sharing first, at most six, no repeats. */
export function orderChoices(choices: readonly { ref: string; name: string }[]): PopupChoice[] {
  const seen = new Set<string>();
  const out: PopupChoice[] = [];
  for (const c of choices) {
    const label = labelOf(c.name);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref: c.ref, label, tone: toneOf(label) });
  }
  return out.sort((a, b) => ORDER[a.tone] - ORDER[b.tone]).slice(0, 6);
}

export function popupKind(text: string, isDialog: boolean): PopupInfo["kind"] {
  if (COOKIES.test(text)) return "cookies";
  return isDialog ? "dialog" : "overlay";
}
