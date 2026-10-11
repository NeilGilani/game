/**
 * Mac apps through agency-native (Instance 3), reached via `window.agency.native` in the Mac app. In a browser a fake
 * list of common apps stands in (labelled simulated), and opening one honestly fails: a web page can't open Mac apps.
 */
import type { AppInfo } from "./contracts";
import { fakeForced, host } from "./host";

export interface AppsSource {
  simulated: boolean;
  list(): Promise<AppInfo[]>;
  launch(bundleId: string): Promise<{ ok: boolean; error?: string }>;
  activate(bundleId: string): Promise<{ ok: boolean; error?: string }>;
}

/** What opening an app says outside the Mac app. Never a pretend success. */
export const NEEDS_MAC_APP =
  "opening Mac apps needs the AGENCY Mac app. A web page can't open apps on your Mac";

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
  async list(): Promise<AppInfo[]> {
    return FAKE_APPS.map((a) => ({ ...a }));
  }
  async launch(_bundleId: string) {
    return { ok: false, error: NEEDS_MAC_APP };
  }
  async activate(_bundleId: string) {
    return { ok: false, error: NEEDS_MAC_APP };
  }
}

/** The helper's own words, without Electron's "Error invoking remote method ..." wrapping. */
function reason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}

let shared: AppsSource | null = null;

export function apps(): AppsSource {
  if (shared) return shared;
  const h = host();
  if (h && !fakeForced("native")) {
    const launch = (bundleId: string) =>
      h.native.call("apps.launch", { bundleId }).catch((err: unknown) => ({ ok: false, error: reason(err) }));
    shared = {
      simulated: false,
      list: () => h.native.call("apps.list", { includeIcons: true }).then((r) => r.apps),
      launch,
      activate: async (bundleId) => {
        const r = await h.native.call("apps.activate", { bundleId }).catch(() => ({ ok: false }));
        if (r.ok) return r;
        // macOS 14+ activation is cooperative: agency-native is a background helper, so the system can refuse its
        // request to bring another app forward. Opening the app through Launch Services (apps.launch, what
        // `open -b` does) brings a running app to the front.
        return launch(bundleId);
      },
    };
  } else {
    shared = new FakeApps();
  }
  return shared;
}

/** Tests only: forget the chosen source so the next `apps()` looks for the host again. */
export function resetAppsForTests(): void {
  shared = null;
}
