/**
 * FakeNative: an in-memory stand-in for agency-native (os/native-macos) so the overlay, the agent and the shell
 * can be tested on any OS. It mirrors the real helper's rules: permission gating, ax.press focusing text
 * fields, refusing to type into password fields (and never recording what was refused), refusing quit / lock /
 * delete key combos, the input.stopAll kill switch, and optional rate limiting.
 */

import type {
  AppInfo,
  Modifier,
  NativeEvent,
  NativeMethod,
  NativeMethods,
  PermissionKind,
  PermissionState,
  PermissionStatus,
} from "../../contracts/src/native";
import type { Target, TargetSnapshot } from "../../contracts/src/targets";

export type NativeParams<M extends NativeMethod> = NativeMethods[M]["params"];
export type NativeResult<M extends NativeMethod> = NativeMethods[M]["result"];

/** What the main process (or a preload bridge) exposes to callers of the helper. */
export interface NativeClient {
  call<M extends NativeMethod>(method: M, params: NativeParams<M>): Promise<NativeResult<M>>;
  onEvent(listener: (event: NativeEvent) => void): () => void;
}

/** JSON-RPC error codes used by agency-native. */
export const NativeErrorCode = {
  methodNotFound: -32601,
  invalidParams: -32602,
  permissionMissing: -32001,
  rateLimited: -32002,
  stopped: -32003,
} as const;

export class NativeError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "NativeError";
  }
}

export interface RecordedCall {
  method: NativeMethod;
  /** Params as sent, except text refused for a password field, which is replaced by "[redacted]". */
  params: unknown;
}

export interface FakeNativeOptions {
  targets?: Target[];
  owner?: string | null;
  apps?: AppInfo[];
  permissions?: Partial<PermissionStatus>;
  voices?: { id: string; name: string; personal: boolean }[];
  /** Delay before synthetic input takes effect, so tests can call input.stopAll in between. */
  actionDelayMs?: number;
  /** Token bucket for synthetic input. Off unless given. */
  rateLimit?: { capacity: number; refillPerSecond: number; now?: () => number };
}

const SETTINGS_PANE: Record<PermissionKind, string> = {
  accessibility: "Accessibility",
  "screen-recording": "Screen & System Audio Recording",
  camera: "Camera",
  microphone: "Microphone",
  "speech-recognition": "Speech Recognition",
};

const REQUIRED: Partial<Record<NativeMethod, PermissionKind[]>> = {
  "ax.targets": ["accessibility"],
  "ax.press": ["accessibility"],
  "input.click": ["accessibility"],
  "input.scroll": ["accessibility"],
  "input.type": ["accessibility"],
  "input.key": ["accessibility"],
  "input.drag": ["accessibility"],
  "screen.capture": ["screen-recording"],
};

const SYNTHETIC: ReadonlySet<NativeMethod> = new Set<NativeMethod>([
  "ax.press",
  "input.click",
  "input.scroll",
  "input.type",
  "input.key",
  "input.drag",
]);

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  backspace: "delete",
  enter: "return",
};

/** Same refusals as KeyPolicy in the Swift helper. */
const REFUSED_COMBOS: { key: string; mods: Modifier[]; reason: string }[] = [
  {
    key: "q",
    mods: ["cmd"],
    reason: "Quitting an app needs your approval, so AGENCY won't press Command-Q.",
  },
  { key: "q", mods: ["cmd", "shift"], reason: "AGENCY won't log you out with a key press." },
  { key: "q", mods: ["cmd", "alt", "shift"], reason: "AGENCY won't log you out with a key press." },
  {
    key: "q",
    mods: ["cmd", "ctrl"],
    reason: "AGENCY won't lock the screen: you might not be able to unlock it.",
  },
  { key: "escape", mods: ["cmd", "alt"], reason: "Force quitting apps needs your approval." },
  {
    key: "delete",
    mods: ["cmd"],
    reason: "Deleting needs your approval, so AGENCY won't press Command-Delete.",
  },
  { key: "delete", mods: ["cmd", "shift"], reason: "Emptying the Trash needs your approval." },
  { key: "delete", mods: ["cmd", "alt"], reason: "Deleting needs your approval." },
  { key: "delete", mods: ["cmd", "alt", "shift"], reason: "Emptying the Trash needs your approval." },
];

export function keyRefusal(key: string, modifiers: readonly Modifier[] = []): string | null {
  const k = key.toLowerCase();
  const name = KEY_ALIASES[k] ?? k;
  const mods = new Set<Modifier>(modifiers.filter((m) => m !== "fn"));
  const rule = REFUSED_COMBOS.find(
    (r) => r.key === name && r.mods.length === mods.size && r.mods.every((m) => mods.has(m)),
  );
  return rule?.reason ?? null;
}

export function permissionMessage(kind: PermissionKind): string {
  const pane = SETTINGS_PANE[kind];
  return `AGENCY needs ${pane} permission. A helper can turn it on in System Settings > Privacy & Security > ${pane}, next to AGENCY.`;
}

const PASSWORD_REFUSAL =
  "This is a password field. AGENCY never types passwords; ask your helper to enter it.";
const UNKNOWN_FOCUS_REFUSAL =
  "AGENCY can't tell where the text would go, so it didn't type anything. Look at a text field first.";
/** A 1x1 transparent PNG. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

type Handler = (params: never) => unknown;

export class FakeNative implements NativeClient {
  readonly calls: RecordedCall[] = [];
  readonly pressed: string[] = [];
  readonly clicks: { x: number; y: number; button: "left" | "right"; count: 1 | 2 }[] = [];
  /** dx/dy as sent: positive dy shows content above (contract: CGEvent scroll-wheel convention). */
  readonly scrolls: { x: number; y: number; dx: number; dy: number }[] = [];
  readonly drags: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
  /** Text actually typed. Never contains anything sent while a password field had focus. */
  readonly typed: string[] = [];
  readonly keys: { key: string; modifiers: Modifier[] }[] = [];
  readonly spoken: string[] = [];
  focusedTargetId: string | null = null;
  listening = false;
  stopCount = 0;

  private targets: Target[];
  private owner: string | null;
  private apps: AppInfo[];
  private permissions: PermissionStatus;
  private voices: { id: string; name: string; personal: boolean }[];
  private readonly actionDelayMs: number;
  private readonly listeners = new Set<(event: NativeEvent) => void>();
  private generation = 0;
  private tokens: number;
  private lastRefill: number;
  private readonly rateLimit: FakeNativeOptions["rateLimit"];
  private readonly handlers: {
    [M in NativeMethod]: (params: NativeParams<M>) => NativeResult<M> | Promise<NativeResult<M>>;
  };

  constructor(options: FakeNativeOptions = {}) {
    this.targets = options.targets ?? [];
    this.owner = options.owner ?? "com.example.fake";
    this.apps = options.apps ?? [
      {
        bundleId: "com.apple.finder",
        name: "Finder",
        path: "/System/Library/CoreServices/Finder.app",
        running: true,
        frontmost: false,
      },
      {
        bundleId: "com.google.Chrome",
        name: "Google Chrome",
        path: "/Applications/Google Chrome.app",
        running: false,
        frontmost: false,
      },
    ];
    this.permissions = {
      accessibility: "granted",
      "screen-recording": "granted",
      camera: "granted",
      microphone: "granted",
      "speech-recognition": "granted",
      ...options.permissions,
    };
    this.voices = options.voices ?? [
      { id: "com.apple.voice.compact.en-US.Samantha", name: "Samantha", personal: false },
    ];
    this.actionDelayMs = options.actionDelayMs ?? 0;
    this.rateLimit = options.rateLimit;
    this.tokens = options.rateLimit?.capacity ?? Infinity;
    this.lastRefill = this.now();

    this.handlers = {
      "permissions.status": () => ({ ...this.permissions }),
      "permissions.request": ({ kind }) => {
        if (this.permissions[kind] === "not-determined") this.setPermission(kind, "granted");
        return { ...this.permissions };
      },
      "ax.targets": ({ maxCount, includeWeb }) => this.snapshot(maxCount ?? 300, includeWeb ?? true),
      "ax.press": ({ targetId }) => {
        const target = this.targets.find((t) => t.id === targetId);
        if (!target) return { ok: false, error: "That control isn't on screen any more. Look at it again." };
        this.pressed.push(targetId);
        if (target.role === "textfield") this.focusedTargetId = targetId;
        return { ok: true };
      },
      "input.click": ({ x, y, button, count }) => {
        if (count !== undefined && count !== 1 && count !== 2) throw this.invalid("count must be 1 or 2");
        this.clicks.push({ x, y, button: button ?? "left", count: count ?? 1 });
        const hit = this.targets.find(
          (t) =>
            x >= t.rect.x && x <= t.rect.x + t.rect.width && y >= t.rect.y && y <= t.rect.y + t.rect.height,
        );
        if (hit?.role === "textfield") this.focusedTargetId = hit.id;
        return { ok: true };
      },
      "input.scroll": ({ x, y, dx, dy }) => {
        this.scrolls.push({ x, y, dx, dy });
        return { ok: true };
      },
      "input.drag": ({ from, to }) => {
        this.drags.push({ from, to });
        return { ok: true };
      },
      "input.type": ({ text }) => {
        const focused = this.targets.find((t) => t.id === this.focusedTargetId);
        if (!focused) return { ok: false, error: UNKNOWN_FOCUS_REFUSAL };
        if (focused.secure) return { ok: false, error: PASSWORD_REFUSAL };
        this.typed.push(text);
        return { ok: true };
      },
      "input.key": ({ key, modifiers }) => {
        const refusal = keyRefusal(key, modifiers ?? []);
        if (refusal) return { ok: false, error: refusal } as NativeResult<"input.key">;
        this.keys.push({ key, modifiers: modifiers ?? [] });
        return { ok: true };
      },
      "apps.list": ({ includeIcons }) => ({
        apps: this.apps.map((a) =>
          includeIcons ? { ...a, iconPng: a.iconPng ?? TINY_PNG } : { ...a, iconPng: undefined },
        ),
      }),
      "apps.launch": ({ bundleId }) => {
        const app = this.apps.find((a) => a.bundleId === bundleId);
        if (!app) return { ok: false, error: "That app isn't installed on this Mac." };
        app.running = true;
        this.setFrontmost(bundleId);
        return { ok: true };
      },
      "apps.activate": ({ bundleId }) => {
        const app = this.apps.find((a) => a.bundleId === bundleId && a.running);
        if (!app) return { ok: false };
        this.setFrontmost(bundleId);
        return { ok: true };
      },
      "apps.hide": ({ bundleId }) => {
        const app = this.apps.find((a) => a.bundleId === bundleId && a.running);
        if (!app) return { ok: false };
        app.frontmost = false;
        return { ok: true };
      },
      "apps.frontmost": () => ({ app: this.apps.find((a) => a.frontmost) ?? null }),
      "screen.capture": ({ format }) => ({
        data: TINY_PNG,
        width: 1,
        height: 1,
        scale: 1,
        format: format ?? "png",
      }),
      "speech.say": ({ text }) => {
        if (!text.trim()) throw this.invalid("text is empty");
        this.spoken.push(text);
        return { ok: true };
      },
      "speech.voices": () => ({ voices: [...this.voices] }),
      "calendar.today": () => ({ ok: true as const, events: [] }),
      "speech.listen": ({ on }) => {
        if (on) {
          const missing = (["microphone", "speech-recognition"] as const).find(
            (k) => this.permissions[k] !== "granted",
          );
          if (missing) return { ok: false, error: permissionMessage(missing) };
        }
        this.listening = on;
        return { ok: true };
      },
      "input.stopAll": () => {
        this.generation += 1;
        this.stopCount += 1;
        this.spoken.length = 0;
        return { ok: true };
      },
    };
  }

  async call<M extends NativeMethod>(method: M, params: NativeParams<M>): Promise<NativeResult<M>> {
    const handler = this.handlers[method] as unknown as Handler | undefined;
    if (!handler) {
      this.calls.push({ method, params });
      throw new NativeError(NativeErrorCode.methodNotFound, `Unknown method: ${String(method)}`);
    }
    this.calls.push({ method, params: this.redact(method, params) });

    if (method === "input.stopAll") return handler(params as never) as NativeResult<M>;

    const missing = (REQUIRED[method] ?? []).find((k) => this.permissions[k] !== "granted");
    if (missing) throw new NativeError(NativeErrorCode.permissionMissing, permissionMessage(missing));

    if (SYNTHETIC.has(method)) {
      if (!this.takeToken()) {
        throw new NativeError(
          NativeErrorCode.rateLimited,
          "Too many actions too quickly. AGENCY slowed down to keep you in control.",
        );
      }
      const ticket = this.generation;
      if (this.actionDelayMs > 0) await new Promise((r) => setTimeout(r, this.actionDelayMs));
      if (ticket !== this.generation)
        throw new NativeError(NativeErrorCode.stopped, "Stopped. All actions were cancelled.");
    }
    return (await handler(params as never)) as NativeResult<M>;
  }

  onEvent(listener: (event: NativeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- Scripting helpers for tests ------------------------------------------------------------------

  setTargets(targets: Target[], owner: string | null = this.owner): void {
    this.targets = targets;
    this.owner = owner;
    if (this.focusedTargetId && !targets.some((t) => t.id === this.focusedTargetId))
      this.focusedTargetId = null;
    this.emit({ type: "targets-changed", owner });
  }

  focus(targetId: string | null): void {
    this.focusedTargetId = targetId;
  }

  setFrontmost(bundleId: string | null): void {
    for (const a of this.apps) a.frontmost = a.bundleId === bundleId;
    const app = this.apps.find((a) => a.frontmost) ?? null;
    this.owner = bundleId;
    this.emit({ type: "frontmost-changed", app });
    this.emit({ type: "targets-changed", owner: bundleId });
  }

  setPermission(kind: PermissionKind, state: PermissionState): void {
    this.permissions = { ...this.permissions, [kind]: state };
    this.emit({ type: "permission-changed", status: { ...this.permissions } });
  }

  /** Simulates the other person speaking on a call (only while listening). */
  hear(text: string, final = true): void {
    if (!this.listening) return;
    this.emit(final ? { type: "speech-final", text } : { type: "speech-partial", text });
  }

  emit(event: NativeEvent): void {
    for (const l of this.listeners) l(event);
  }

  // --- Internals -----------------------------------------------------------------------------------

  private snapshot(maxCount: number, includeWeb: boolean): TargetSnapshot {
    const cap = Math.min(1000, Math.max(1, Math.floor(maxCount)));
    const visible = this.targets.filter((t) => includeWeb || t.source !== "web");
    return {
      t: Date.now(),
      owner: this.owner,
      targets: visible.slice(0, cap).map((t) => ({ ...t })),
      truncated: visible.length > cap,
    };
  }

  private redact(method: NativeMethod, params: unknown): unknown {
    if (method !== "input.type") return params;
    const focused = this.targets.find((t) => t.id === this.focusedTargetId);
    return focused?.secure ? { text: "[redacted]" } : params;
  }

  private takeToken(): boolean {
    if (!this.rateLimit) return true;
    const now = this.now();
    this.tokens = Math.min(
      this.rateLimit.capacity,
      this.tokens + ((now - this.lastRefill) / 1000) * this.rateLimit.refillPerSecond,
    );
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private now(): number {
    return this.rateLimit?.now?.() ?? Date.now();
  }

  private invalid(detail: string): NativeError {
    return new NativeError(NativeErrorCode.invalidParams, `Invalid params: ${detail}`);
  }
}
