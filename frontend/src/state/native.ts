/**
 * Mac apps through agency-native (Instance 3), reached via `window.agency.native` in the Mac app. In a browser a fake
 * list of common apps stands in, and launching only pretends (labelled simulated): a web page can't open Mac apps.
 */
import type { AppInfo } from "./contracts";
import { fakeForced, host } from "./host";

export interface AppsSource {
  simulated: boolean;
  list(): Promise<AppInfo[]>;
  launch(bundleId: string): Promise<{ ok: boolean; error?: string }>;
  activate(bundleId: string): Promise<{ ok: boolean }>;
}

const FAKE_APPS: AppInfo[] = [
  {
    bundleId: "com.google.Chrome",
    name: "Google Chrome",
    path: "/Applications/Google Chrome.app",
    running: true,
    frontmost: false,
  },
  {
    bundleId: "com.apple.Music",
    name: "Music",
    path: "/System/Applications/Music.app",
    running: false,
    frontmost: false,
  },
  {
    bundleId: "com.apple.MobileSMS",
    name: "Messages",
    path: "/System/Applications/Messages.app",
    running: true,
    frontmost: false,
  },
  {
    bundleId: "com.apple.mail",
    name: "Mail",
    path: "/System/Applications/Mail.app",
    running: false,
    frontmost: false,
  },
  {
    bundleId: "com.apple.FaceTime",
    name: "FaceTime",
    path: "/System/Applications/FaceTime.app",
    running: false,
    frontmost: false,
  },
  {
    bundleId: "com.apple.TV",
    name: "TV",
    path: "/System/Applications/TV.app",
    running: false,
    frontmost: false,
  },
  {
    bundleId: "com.apple.Photos",
    name: "Photos",
    path: "/System/Applications/Photos.app",
    running: false,
    frontmost: false,
  },
  {
    bundleId: "com.apple.Notes",
    name: "Notes",
    path: "/System/Applications/Notes.app",
    running: false,
    frontmost: false,
  },
  {
    bundleId: "com.apple.iCal",
    name: "Calendar",
    path: "/System/Applications/Calendar.app",
    running: false,
    frontmost: false,
  },
  {
    bundleId: "com.apple.Safari",
    name: "Safari",
    path: "/Applications/Safari.app",
    running: false,
    frontmost: false,
  },
  {
    bundleId: "com.apple.finder",
    name: "Finder",
    path: "/System/Library/CoreServices/Finder.app",
    running: true,
    frontmost: false,
  },
  {
    bundleId: "com.apple.Preview",
    name: "Preview",
    path: "/System/Applications/Preview.app",
    running: false,
    frontmost: false,
  },
];

class FakeApps implements AppsSource {
  simulated = true;
  private apps = FAKE_APPS.map((a) => ({ ...a }));
  async list(): Promise<AppInfo[]> {
    return this.apps.map((a) => ({ ...a }));
  }
  async launch(bundleId: string) {
    const app = this.apps.find((a) => a.bundleId === bundleId);
    if (!app) return { ok: false, error: "That app isn't installed." };
    this.apps.forEach((a) => (a.frontmost = false));
    app.running = true;
    app.frontmost = true;
    return { ok: true };
  }
  async activate(bundleId: string) {
    const r = await this.launch(bundleId);
    return { ok: r.ok };
  }
}

let shared: AppsSource | null = null;

export function apps(): AppsSource {
  if (shared) return shared;
  const h = host();
  if (h && !fakeForced("native")) {
    shared = {
      simulated: false,
      list: () => h.native.call("apps.list", { includeIcons: true }).then((r) => r.apps),
      launch: (bundleId) => h.native.call("apps.launch", { bundleId }),
      activate: (bundleId) => h.native.call("apps.activate", { bundleId }),
    };
  } else {
    shared = new FakeApps();
  }
  return shared;
}
