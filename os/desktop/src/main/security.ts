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

export function applySecurity(app: App, policy: SecurityPolicy): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      policy.log.warn(`blocked window.open to ${url}`);
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
