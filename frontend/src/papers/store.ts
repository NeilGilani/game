/**
 * What a helper saves for Papers, on this computer only: the person's details for forms, their signature picture,
 * and whether letters may be explained with Gemini. Nothing here is sent anywhere; forms only get a detail the
 * person picks, and a letter's text only leaves after the person agrees on screen.
 */
import type { Profile } from "../../../os/tasks/src/profile";

const DETAILS_KEY = "agency.papers.details";
const SIGNATURE_KEY = "agency.papers.signature";
const CLOUD_KEY = "agency.papers.cloudExplain";

/** The largest signature picture kept (a signature is small; this keeps storage safe). */
export const MAX_SIGNATURE_BYTES = 400 * 1024;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: nothing is kept */
  }
}

/** The saved details, or null when none were saved. Empty entries are dropped. */
export function loadDetails(): Profile | null {
  const raw = read(DETAILS_KEY);
  if (!raw) return null;
  try {
    return cleanDetails(JSON.parse(raw) as Partial<Profile>);
  } catch {
    return null;
  }
}

/** Trim every entry and drop empty ones; null when nothing is left. */
export function cleanDetails(p: Partial<Profile>): Profile | null {
  const t = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 200) : "");
  const a = p.address;
  const address =
    a && (t(a.line1) || t(a.city))
      ? {
          line1: t(a.line1),
          ...(t(a.line2) ? { line2: t(a.line2) } : {}),
          city: t(a.city),
          region: t(a.region),
          postalCode: t(a.postalCode),
        }
      : undefined;
  const out: Profile = {
    fullName: t(p.fullName),
    preferredName: t(p.preferredName) || t(p.fullName).split(/\s+/)[0] || "",
    ...(t(p.dateOfBirth) ? { dateOfBirth: t(p.dateOfBirth) } : {}),
    ...(t(p.phone) ? { phone: t(p.phone) } : {}),
    ...(t(p.email) ? { email: t(p.email) } : {}),
    ...(address ? { address } : {}),
  };
  const any = out.fullName || out.dateOfBirth || out.phone || out.email || out.address;
  return any ? out : null;
}

export function saveDetails(p: Partial<Profile> | null): Profile | null {
  const clean = p ? cleanDetails(p) : null;
  write(DETAILS_KEY, clean ? JSON.stringify(clean) : null);
  return clean;
}

/** The saved signature picture as a data URL (PNG or JPEG), or null. */
export function loadSignature(): string | null {
  const v = read(SIGNATURE_KEY);
  return v && /^data:image\/(png|jpeg);base64,/.test(v) ? v : null;
}

export function saveSignature(dataUrl: string | null): void {
  write(SIGNATURE_KEY, dataUrl);
}

/** May a letter's text be sent to Gemini to explain it (after the person agrees each time)? On unless turned off. */
export function cloudExplainAllowed(): boolean {
  return read(CLOUD_KEY) !== "off";
}

export function setCloudExplain(on: boolean): void {
  write(CLOUD_KEY, on ? null : "off");
}

export function dataUrlBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
