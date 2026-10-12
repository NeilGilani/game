/**
 * A host for the browser, Vitest and Playwright: records every call, answers native methods from a
 * small in-memory Mac (scripted apps; secure-field refusal; stopAll). Nothing here touches a real Mac.
 */

import type {
  AppInfo,
  LifelineSignal,
  NativeMethod,
  NativeMethods,
  ScreenRect,
  SelectionEvent,
  Suggestion,
} from "../contracts";
import type { NativeCall, OverlayHost } from "./host";

export interface HostCall {
  kind: "native" | "lifeline" | "stopAll" | "home" | "pressWeb" | "logSelection";
  method?: string;
  params?: unknown;
}

export interface FakeHostOptions {
  apps?: AppInfo[];
  /** ax.press answers ok: false for these target ids (to exercise the click fallback). */
  pressFails?: string[];
  /** input.type refuses (secure field focused natively). */
  secureFocused?: boolean;
  phrases?: string[];
  /** input.drag answers ok: false (to exercise the failure message). */
  dragFails?: boolean;
  /** apps.activate answers ok: false, as macOS 14+ may for a background helper (to exercise the launch fallback). */
  activateRefused?: boolean;
  /** apps.launch answers ok: false. */
  launchFails?: boolean;
}

export const DEMO_APPS: AppInfo[] = [
  {
    bundleId: "com.apple.finder",
    name: "Finder",
    path: "/System/Library/CoreServices/Finder.app",
    running: true,
    frontmost: true,
  },
  {
    bundleId: "com.google.Chrome",
    name: "Google Chrome",
    path: "/Applications/Google Chrome.app",
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
    bundleId: "com.apple.MobileSMS",
    name: "Messages",
    path: "/System/Applications/Messages.app",
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
];

export class FakeHost implements OverlayHost {
  readonly calls: HostCall[] = [];
  regions: ScreenRect[] = [];
  private opts: FakeHostOptions;
  stopped = 0;

  constructor(opts: FakeHostOptions = {}) {
    this.opts = opts;
  }

  configure(opts: Partial<FakeHostOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  native: NativeCall = async <M extends NativeMethod>(method: M, params: NativeMethods[M]["params"]) => {
    this.calls.push({ kind: "native", method, params });
    return this.answer(method, params) as NativeMethods[M]["result"];
  };

  private answer(method: NativeMethod, params: unknown): unknown {
    switch (method) {
      case "ax.press": {
        const id = (params as { targetId: string }).targetId;
        return (this.opts.pressFails ?? []).includes(id)
          ? { ok: false, error: "no AXPress action" }
          : { ok: true };
      }
      case "input.type":
        return this.opts.secureFocused ? { ok: false, error: "secure text field focused" } : { ok: true };
      case "input.drag":
        return this.opts.dragFails ? { ok: false, error: "drag failed" } : { ok: true };
      case "apps.list":
        return { apps: this.opts.apps ?? DEMO_APPS };
      case "apps.activate":
        return this.opts.activateRefused ? { ok: false } : { ok: true };
      case "apps.launch":
        return this.opts.launchFails ? { ok: false, error: "not installed" } : { ok: true };
      case "input.click":
      case "input.scroll":
      case "input.key":
      case "input.stopAll":
        return { ok: true };
      default:
        return { ok: true };
    }
  }

  lifeline(signal: LifelineSignal): void {
    this.calls.push({ kind: "lifeline", params: signal });
  }

  stopAll(): void {
    this.stopped++;
    this.calls.push({ kind: "stopAll" });
  }

  home(): void {
    this.calls.push({ kind: "home" });
  }

  async pressWeb(targetId: string): Promise<{ ok: boolean }> {
    this.calls.push({ kind: "pressWeb", params: { targetId } });
    return { ok: true };
  }

  async memorySuggestions(): Promise<Suggestion[]> {
    return (this.opts.phrases ?? []).map((label, i) => ({
      nodeId: `phrase-${i}`,
      path: ["talk", label],
      label,
      score: 1 - i / 10,
      reason: "Said often",
    }));
  }

  logSelection(event: SelectionEvent): void {
    this.calls.push({ kind: "logSelection", params: event });
  }

  setInteractiveRegions(rects: ScreenRect[]): void {
    this.regions = rects;
  }

  nativeCalls(method?: string): HostCall[] {
    return this.calls.filter((c) => c.kind === "native" && (!method || c.method === method));
  }
}
