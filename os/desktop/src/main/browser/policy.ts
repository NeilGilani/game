/**
 * AGENCY Browser's rules, as pure functions so they are easy to test: which addresses a tab may open, what counts
 * as AGENCY's own (never reachable from a page), which sites are sensitive for the assistant, which permissions a
 * page may even ask for, and how downloads are named.
 */

import { classifyUrl } from "@agency/browser-bridge";
import type { SensitiveKind, SitePermission } from "@agency/contracts";

export type Security = "secure" | "insecure" | "local";

export type NavigationDecision =
  | { ok: true; url: string; security: Security }
  | { ok: false; reason: string; kind: "scheme" | "internal" | "invalid" | "credentials" };

/** Schemes a page may never open, with a plain reason. */
const BLOCKED_SCHEMES: Record<string, string> = {
  "file:": "Files on this computer can't be opened in AGENCY Browser.",
  "chrome:": "Browser settings pages are off limits.",
  "chrome-extension:": "Browser extension pages are off limits.",
  "devtools:": "Developer tools are off limits.",
  "view-source:": "Page source is off limits.",
  "javascript:": "That link runs code instead of opening a page, so AGENCY blocked it.",
  "data:": "That link has no web address, so AGENCY blocked it.",
  "blob:": "That link has no web address, so AGENCY blocked it.",
  "filesystem:": "That link has no web address, so AGENCY blocked it.",
  "agency:": "That is part of AGENCY itself, not a web page.",
};

/** True for this computer: localhost, *.localhost and loopback addresses. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(h) ||
    h === "0.0.0.0"
  );
}

function portOf(u: URL): string {
  return u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
}

/**
 * Is this address one of AGENCY's own services (the coordinator, the development shell)? Any loopback spelling of
 * the same port counts: 127.0.0.1, localhost and [::1] all reach the same server.
 */
export function isInternal(url: URL, internalOrigins: readonly string[]): boolean {
  for (const origin of internalOrigins) {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      continue;
    }
    if (o.protocol !== url.protocol || portOf(o) !== portOf(url)) continue;
    if (o.hostname === url.hostname) return true;
    if (isLocalHost(o.hostname) && isLocalHost(url.hostname) && !url.hostname.endsWith(".localhost"))
      return true;
  }
  return false;
}

export function securityOf(url: URL): Security {
  if (url.protocol === "https:") return "secure";
  return isLocalHost(url.hostname) ? "local" : "insecure";
}

/**
 * May a tab open this address? Only http and https, never AGENCY's own services, never an address with a user name
 * or password in it (a classic way to disguise where a link really goes). The canonical form is what opens.
 */
export function decideNavigation(target: string, internalOrigins: readonly string[]): NavigationDecision {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return { ok: false, kind: "invalid", reason: "That isn't a web address." };
  }
  const blocked = BLOCKED_SCHEMES[u.protocol];
  if (blocked) return { ok: false, kind: u.protocol === "agency:" ? "internal" : "scheme", reason: blocked };
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return { ok: false, kind: "scheme", reason: "AGENCY Browser opens web pages (http and https) only." };
  if (u.username !== "" || u.password !== "")
    return {
      ok: false,
      kind: "credentials",
      reason: "That address hides a user name or password in it, a common trick. AGENCY blocked it.",
    };
  if (isInternal(u, internalOrigins))
    return { ok: false, kind: "internal", reason: "That is part of AGENCY itself, not a web page." };
  return { ok: true, url: u.href, security: securityOf(u) };
}

/**
 * May a page load this resource (a script, image, request)? Same rules for the scheme of web traffic, and never
 * AGENCY's own services: a page must not be able to talk to the coordinator.
 */
export function decideRequest(url: string, internalOrigins: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (["data:", "blob:"].includes(u.protocol)) return true;
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return false;
  const asHttp = new URL(u.href.replace(/^ws/, "http"));
  return !isInternal(asHttp, internalOrigins);
}

// ------------------------------------------------------------------------------------------------------------
// Sensitive sites: the assistant reads only, unless the person approves each step

const GOVERNMENT = [
  /(^|\.)gov$/,
  /(^|\.)mil$/,
  /(^|\.)gov\.[a-z]{2}$/,
  /(^|\.)gob\.[a-z]{2}$/,
  /(^|\.)gouv\.[a-z]{2}$/,
  /(^|\.)gc\.ca$/,
  /(^|\.)canada\.ca$/,
  /(^|\.)europa\.eu$/,
  /(^|\.)service\.gov\.uk$/,
];

const HEALTH_HOSTS = [
  "mychart.com",
  "mychart.org",
  "followmyhealth.com",
  "kp.org",
  "kaiserpermanente.org",
  "nhs.uk",
  "patientportal.com",
  "athenahealth.com",
  "myhealthrecord.gov.au",
  "healthvault.com",
  "onemedical.com",
  "teladoc.com",
  "zocdoc.com",
  "patient.info",
  // The sandbox web world's pretend clinic and pharmacy, so the rule can be tested without real ones.
  "clinic.localhost",
  "pharmacy.localhost",
];

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Banks and payments, health records, government, password managers and account security pages. */
export function sensitiveKind(url: string): SensitiveKind | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const c = classifyUrl(u.href);
  if (c?.category === "banking") return "bank";
  if (c?.category === "password-manager") return "passwords";
  if (c?.category === "account-security") return "account";
  if (HEALTH_HOSTS.some((d) => hostMatches(host, d)) || /(^|[.-])(mychart|patientportal)([.-]|$)/.test(host))
    return "health";
  if (GOVERNMENT.some((re) => re.test(host))) return "government";
  return null;
}

export const SENSITIVE_WORDS: Record<SensitiveKind, string> = {
  bank: "a bank or payments site",
  health: "a health records site",
  government: "a government site",
  passwords: "a password manager",
  account: "an account security page",
};

// ------------------------------------------------------------------------------------------------------------
// Permissions

export type PermissionRoute =
  { kind: "ask"; permission: SitePermission } | { kind: "allow" } | { kind: "deny"; why?: "camera" };

/**
 * What to do with a page's permission request. Asked per site: microphone, location, notifications, reading the
 * clipboard. Never: the camera (AGENCY's camera is the person's eyes and stays AGENCY's), devices (USB, serial,
 * HID, MIDI), screen capture, other windows, pointer lock, opening other apps. Always: full screen (AGENCY shows it
 * in its own big-screen mode) and writing to the clipboard (a page's own Copy button).
 */
export function routePermission(
  permission: string,
  mediaTypes: readonly string[] | undefined,
): PermissionRoute {
  switch (permission) {
    case "media": {
      const types = mediaTypes ?? [];
      if (types.includes("video") || types.length === 0) return { kind: "deny", why: "camera" };
      return types.every((t) => t === "audio") ? { kind: "ask", permission: "microphone" } : { kind: "deny" };
    }
    case "geolocation":
      return { kind: "ask", permission: "location" };
    case "notifications":
      return { kind: "ask", permission: "notifications" };
    case "clipboard-read":
      return { kind: "ask", permission: "clipboard" };
    case "clipboard-sanitized-write":
    case "fullscreen":
      return { kind: "allow" };
    default:
      return { kind: "deny" };
  }
}

/** The permission check handler's answer: only what the person allowed for this site before. */
export function checkPermission(
  permission: string,
  mediaType: string | undefined,
  stored: (permission: SitePermission) => "allow" | "deny" | null,
): boolean {
  const route = routePermission(permission, mediaType ? [mediaType] : undefined);
  if (route.kind === "allow") return true;
  if (route.kind === "deny") return false;
  return stored(route.permission) === "allow";
}

// ------------------------------------------------------------------------------------------------------------
// Downloads

const PROGRAM_EXT =
  /\.(dmg|pkg|mpkg|app|command|tool|sh|bash|zsh|csh|py|pl|rb|jar|exe|msi|bat|cmd|com|scr|ps1|vbs|js|jse|wsf|apk|deb|rpm|run|bin|workflow|scpt|applescript|terminal|webloc|inetloc|fileloc|mobileconfig|kext|prefpane|plugin|xpi|crx)$/i;

/** Programs and installers, which a helper should decide about. */
export function isProgram(filename: string): boolean {
  return PROGRAM_EXT.test(filename.trim());
}

/** A plain file name: no folders, no control characters, no leading dots, not too long. */
export function safeFilename(name: string): string {
  const base = (name.split(/[/\\]/).pop() ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (!base) return "download";
  if (base.length <= 120) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && base.length - dot <= 12 ? base.slice(dot) : "";
  return base.slice(0, 120 - ext.length) + ext;
}

/** "photo.jpg", then "photo (2).jpg", "photo (3).jpg"... the first name not taken. */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const c = `${stem} (${i})${ext}`;
    if (!taken(c)) return c;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/** A page that didn't load, in plain words (Chromium's net error codes). null: not worth showing (cancelled). */
export function loadError(
  code: number,
): { kind: "load" | "certificate" | "blocked"; message: string } | null {
  if (code === -3) return null;
  if (code <= -200 && code > -300)
    return {
      kind: "certificate",
      message:
        "This site's security certificate isn't valid, so AGENCY won't open it: someone could be pretending to be the site.",
    };
  if (code === -20 || code === -27) return { kind: "blocked", message: "AGENCY Browser blocked this page." };
  if (code === -105 || code === -137)
    return {
      kind: "load",
      message: "AGENCY couldn't find that site. Check the address, or the internet connection.",
    };
  if (code === -106) return { kind: "load", message: "This Mac isn't connected to the internet right now." };
  if ([-7, -102, -104, -109, -118, -324, -100, -101].includes(code))
    return { kind: "load", message: "The site didn't answer. It may be down; try again in a while." };
  if (code === -310)
    return { kind: "load", message: "The site keeps sending AGENCY around in circles, so it stopped." };
  return { kind: "load", message: "The page couldn't load." };
}

/** A short, plain origin for the person: "www.example.com" (or "this computer" for local pages). */
export function siteLabel(url: string): string {
  try {
    const u = new URL(url);
    if (isLocalHost(u.hostname)) return u.host;
    return u.hostname;
  } catch {
    return "this page";
  }
}

/** A Chrome-like user agent: sites serve their normal pages instead of "unsupported browser" ones. */
export function chromeUserAgent(ua: string): string {
  return ua.replace(/\s(AGENCY|agency-os|@agency\/desktop)\/\S+/gi, "").replace(/\sElectron\/\S+/, "");
}
