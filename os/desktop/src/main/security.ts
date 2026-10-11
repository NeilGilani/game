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

export function isExternalAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return EXTERNAL_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export function applySecurity(app: App, policy: SecurityPolicy): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // A page the person chose in Watch & listen or Browse opens in their own browser, never in an AGENCY window.
      // Only these well-known https sites; anything else stays blocked.
      if (isExternalAllowed(url) && policy.openExternal) policy.openExternal(url);
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
