// Which computer is the visitor on? Used only to pick a download; nothing is stored or sent anywhere.
// Inputs are passed in so the logic can be unit-tested (tests/unit/platform.test.ts).

import type { Arch } from "./release";

export type OS = "mac" | "ios" | "windows" | "linux" | "android" | "chromeos" | "other";

export interface PlatformInputs {
  userAgent: string;
  maxTouchPoints?: number;
  /** From navigator.userAgentData.getHighEntropyValues(["architecture", "bitness"]) (Chromium only). */
  clientHints?: { platform?: string; architecture?: string; bitness?: string } | null;
  /** The WebGL renderer string, e.g. "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, ...)". */
  webglRenderer?: string | null;
}

export interface Platform {
  os: OS;
  arch: Arch | "unknown";
  /** How we know the chip, so the page can say "we couldn't tell" honestly. */
  archSource: "client-hints" | "graphics" | "none";
}

export function detectOS(inputs: PlatformInputs): OS {
  const ua = inputs.userAgent;
  const hinted = inputs.clientHints?.platform?.toLowerCase();
  if (hinted === "macos") return "mac";
  if (hinted === "windows") return "windows";
  if (hinted === "android") return "android";
  if (hinted === "chrome os" || hinted === "chromeos") return "chromeos";
  if (hinted === "linux") return "linux";
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  // iPadOS Safari asks for desktop pages and says "Macintosh"; only the touch screen gives it away.
  if (/Macintosh|Mac OS X/.test(ua)) return (inputs.maxTouchPoints ?? 0) > 1 ? "ios" : "mac";
  if (/Android/.test(ua)) return "android";
  if (/CrOS/.test(ua)) return "chromeos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}

/** Safari and Firefox always say "Intel Mac OS X", even on Apple silicon, so the user agent never decides. */
export function detectMacArch(inputs: PlatformInputs): Pick<Platform, "arch" | "archSource"> {
  const hinted = inputs.clientHints?.architecture?.toLowerCase();
  if (hinted === "arm") return { arch: "arm64", archSource: "client-hints" };
  if (hinted === "x86") return { arch: "x64", archSource: "client-hints" };

  const gpu = inputs.webglRenderer ?? "";
  // Safari reports every Mac's GPU as just "Apple GPU", Intel ones too, so only a named M-series chip counts.
  if (/Apple M\d/i.test(gpu)) return { arch: "arm64", archSource: "graphics" };
  // Intel Macs have Intel, AMD or NVIDIA graphics. (Rosetta can't hide the GPU.)
  if (/(Intel|AMD|Radeon|NVIDIA|GeForce)/i.test(gpu)) return { arch: "x64", archSource: "graphics" };
  return { arch: "unknown", archSource: "none" };
}

export function detectPlatform(inputs: PlatformInputs): Platform {
  const os = detectOS(inputs);
  if (os !== "mac") return { os, arch: "unknown", archSource: "none" };
  return { os, ...detectMacArch(inputs) };
}
