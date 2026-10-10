/** Merges target snapshots from the shell, the accessibility tree and web pages into one for the overlay. */

import type { ScreenRect, Target, TargetSnapshot, TargetSource } from "@agency/contracts";

const MAX_TARGETS = 400;

/** Snapshot owner while AGENCY's own shell is in front; the overlay stands down for it. */
export const SHELL_OWNER = "agency.shell";

/**
 * The bundle id of the running app (macOS), read from the Info.plist next to the executable, so accessibility
 * snapshots of AGENCY's own windows can be recognised. Null where it can't be read.
 */
export function readBundleId(execPath: string, read: (path: string) => string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(execPath);
  if (!m) return null;
  try {
    const plist = read(`${m[1]}/Contents/Info.plist`);
    const id = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return id?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

export class TargetMerger {
  private readonly bySource = new Map<TargetSource, TargetSnapshot>();

  update(source: TargetSource, snapshot: TargetSnapshot): void {
    this.bySource.set(source, snapshot);
  }

  clear(source: TargetSource): void {
    this.bySource.delete(source);
  }

  /**
   * While AGENCY's shell is in front, only its own targets count: the accessibility tree of an Electron window
   * is a pile of unlabelled rows, and the shell runs its own dwell. Otherwise web targets win over
   * accessibility targets inside browser content. Accessibility snapshots of AGENCY's own windows
   * (`selfOwner`) are never used.
   */
  merged(now: number, shellFrontmost: boolean, selfOwner: string | null = null): TargetSnapshot {
    const shell = this.bySource.get("shell");
    const ax = this.bySource.get("ax");
    const web = this.bySource.get("web");
    const out: Target[] = [];
    let truncated = false;
    let owner: string | null = null;

    if (shellFrontmost) {
      out.push(...(shell?.targets ?? []));
      owner = SHELL_OWNER;
    } else {
      const webTargets = web?.targets ?? [];
      out.push(...webTargets);
      const axUsable = ax && !(selfOwner && ax.owner === selfOwner);
      for (const t of axUsable ? ax.targets : []) {
        if (webTargets.some((w) => overlapRatio(w.rect, t.rect) > 0.6)) continue;
        out.push(t);
      }
      owner = (axUsable ? ax.owner : null) ?? web?.owner ?? null;
      truncated = Boolean((axUsable && ax.truncated) || web?.truncated);
    }
    if (out.length > MAX_TARGETS) {
      out.length = MAX_TARGETS;
      truncated = true;
    }
    return { t: now, owner, targets: out, truncated };
  }
}

export function overlapRatio(a: ScreenRect, b: ScreenRect): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = x * y;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? inter / smaller : 0;
}

/** Shell targets arrive in window client coordinates; convert to global screen points. */
export function toGlobal(targets: Target[], content: { x: number; y: number }, zoom = 1): Target[] {
  return targets.map((t) => ({
    ...t,
    source: "shell" as const,
    rect: {
      x: content.x + t.rect.x * zoom,
      y: content.y + t.rect.y * zoom,
      width: t.rect.width * zoom,
      height: t.rect.height * zoom,
    },
  }));
}

/** Validates untrusted renderer input before it reaches the overlay. */
export function sanitizeTargets(input: unknown): Target[] {
  if (!Array.isArray(input)) return [];
  const out: Target[] = [];
  for (const raw of input.slice(0, MAX_TARGETS)) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Partial<Target>;
    const r = t.rect;
    if (typeof t.id !== "string" || !r || ![r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n)))
      continue;
    if (r.width <= 0 || r.height <= 0) continue;
    out.push({
      id: t.id.slice(0, 200),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      role: typeof t.role === "string" ? t.role.slice(0, 40) : "button",
      label: typeof t.label === "string" ? t.label.slice(0, 200) : "",
      source: "shell",
      ...(typeof t.dwellScale === "number" && t.dwellScale > 0 && t.dwellScale <= 5
        ? { dwellScale: t.dwellScale }
        : {}),
      ...(t.protected === true ? { protected: true } : {}),
      ...(t.secure === true ? { secure: true } : {}),
    });
  }
  return out;
}
