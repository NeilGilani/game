/**
 * Secure defaults for every web contents: no new windows, no navigation away from AGENCY, no webviews, and a
 * permission handler that grants the camera only to the windows that track the eyes (the shell, which runs the
 * calibrated eye-tracking pipeline, and the optional hidden engine window): video only, never the microphone.
 */

import type { App, Session, WebContents } from "electron";
import type { Logger } from "./log";

export interface SecurityPolicy {
  /** Origins a window may navigate within (agency://shell, plus the Vite dev server in development). */
  allowedOrigins: () => string[];
  /** May this web contents use the camera (the shell or the gaze engine window)? */
  mayUseCamera: (contents: WebContents) => boolean;
  log: Logger;
  /** Opens an allow-listed https page in the person's browser (Electron's shell.openExternal). */
  openExternal?: (url: string) => void;
}

export function isAllowedNavigation(target: string, allowedOrigins: string[]): boolean {
  try {
    const url = new URL(target);
    const origin = url.protocol === "agency:" ? `agency://${url.host}` : url.origin;
    return allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}

/** Pure decision, unit-tested: may this request get this permission? */
export function decidePermission(
  permission: string,
  mayUseCamera: boolean,
  mediaTypes: readonly string[] | undefined,
): boolean {
  if (permission !== "media") return false;
  if (!mayUseCamera) return false;
  const types = mediaTypes ?? [];
  return types.length > 0 && types.every((t) => t === "video");
}

/** Sites the Watch & listen and Browse screens open in the person's browser (https only). */
const EXTERNAL_HOSTS = [
  "youtube.com",
  "netflix.com",
  "wikipedia.org",
  "weather.com",
  "news.google.com",
  "mail.google.com",
  "www.google.com",
];

/**
 * The canonical address to hand to the browser, or null when the page may not be opened. Only plain https on the
 * default port to one of EXTERNAL_HOSTS (or a subdomain): no user name or password in the address (they can be
 * used to disguise the real host), no other port, no other scheme. The URL parser lowercases schemes and hosts and
 * turns international names into punycode, so look-alike hosts never match.
 */
export function externalUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null;
  if (u.port !== "") return null;
  const host = u.hostname;
  if (!EXTERNAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  return u.href;
}

export function isExternalAllowed(url: string): boolean {
  return externalUrl(url) !== null;
}

export function applySecurity(app: App, policy: SecurityPolicy): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // A page the person chose in Watch & listen or Browse opens in their own browser, never in an AGENCY window.
      // Only these well-known https sites; anything else stays blocked.
      // The parsed, canonical form is what opens, never the raw string the page passed.
      const safe = externalUrl(url);
      if (safe && policy.openExternal) policy.openExternal(safe);
      else policy.log.warn(`blocked window.open to ${url}`);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url, policy.allowedOrigins())) {
        event.preventDefault();
        policy.log.warn(`blocked navigation to ${url}`);
      }
    });
    contents.on("will-redirect", (event, url) => {
      if (!isAllowedNavigation(url, policy.allowedOrigins())) {
        event.preventDefault();
        policy.log.warn(`blocked redirect to ${url}`);
      }
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

export function applyPermissionHandlers(session: Session, policy: SecurityPolicy): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? (details.mediaTypes as string[] | undefined) : undefined;
    const ok = decidePermission(permission, policy.mayUseCamera(contents), mediaTypes);
    if (!ok)
      policy.log.warn(
        `denied permission ${permission} (${(mediaTypes ?? []).join(",")}) to ${contents.getURL()}`,
      );
    callback(ok);
  });
  session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (!contents) return false;
    const mediaType = (details as { mediaType?: string }).mediaType;
    return decidePermission(permission, policy.mayUseCamera(contents), mediaType ? [mediaType] : undefined);
  });
  session.setDevicePermissionHandler(() => false);
}
