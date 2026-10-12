// Everything on the site that changes as AGENCY OS grows lives here, so the copy stays honest in one place.

/** The repository whose GitHub Releases hold the .dmg. Can be a separate public releases repository. */
export const RELEASES_REPO: string = import.meta.env["PUBLIC_RELEASES_REPO"] ?? "NeilGilani/game";
/** Where the source code lives. */
export const SOURCE_REPO = "NeilGilani/game";
export const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`;
export const SOURCE_URL = `https://github.com/${SOURCE_REPO}`;

/**
 * The address for "tell me when it works on my computer". Left empty until the owner chooses a public address;
 * the page then points to GitHub Issues instead. Never a third-party form.
 */
export const CONTACT_EMAIL: string = import.meta.env["PUBLIC_CONTACT_EMAIL"] ?? "";
export const ISSUES_URL = `${SOURCE_URL}/issues`;

/** Set PUBLIC_DEMO_VIDEO to a real recording (e.g. "demo/agency-60s.mp4" in public/) to replace the placeholder. */
export const DEMO_VIDEO: string = import.meta.env["PUBLIC_DEMO_VIDEO"] ?? "demo/agency-demo.mp4";
export const DEMO_CAPTIONS: string = import.meta.env["PUBLIC_DEMO_CAPTIONS"] ?? "demo/agency-demo.vtt";

/** The people building AGENCY. Names only: roles and photos go here once each person has chosen them. */
export const TEAM = [
  { name: "Neil Gilani", initials: "NG" },
  { name: "Rayansh “Ray” Bakshi", initials: "RB" },
  { name: "Ryan Cho", initials: "RC" },
];

export const REQUIREMENTS = {
  macos: "macOS 13 Ventura or later",
  chips: "A Mac with Apple silicon (M1 or later) or an Intel processor",
  camera: "A webcam: the one built into a MacBook or iMac works",
  browser: "Google Chrome, for eye control on web pages (other apps work without it)",
  ai: "A Google Gemini API key for tasks the AI agent plans itself. Without one, AGENCY runs its built-in tasks only.",
};

/**
 * Where each feature really stands. "prototype" = working and tested in the AGENCY app that's in the repository
 * today. "building" = being built for AGENCY OS and not in a release yet. Update this as work lands.
 */
export type Status = "prototype" | "building";
export const STATUS_REVIEWED = "11 October 2026";
export const STATUS_LABEL: Record<Status, string> = {
  prototype: "Works today",
  building: "Being built",
};
