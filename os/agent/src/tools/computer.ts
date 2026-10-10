/**
 * Tier (d): computer use, the general fallback for any app. Each provider translates its own computer-use
 * calls (Gemini Computer Use, Claude's computer toolset) into the neutral ComputerAction below, and this tier
 * performs them on agency-native. Every action with an effect goes through the guard: a click is resolved to
 * the accessibility element under it so it can be classified by its label, and a click on something without a
 * label is treated as consequential (we ask rather than guess).
 *
 * Screenshots go to the model only during an active task, are kept in memory only for that task's
 * conversation, and are never written to disk.
 */

import type { Modifier, ScreenRect, Target } from "@agency/contracts";
import type { GuardOutcome } from "../guard";
import type { ActionClaim, NativeClient } from "../types";
import { isSimulatedApp, ToolError, type GuardedTools } from "./guarded";

/**
 * Where a coordinate is measured:
 *   "pixels"     pixels of the last screenshot sent to the model (Claude)
 *   "normalized" 0..999 across the screen, independent of size (Gemini)
 *   "points"     global screen points (scripts and tests)
 */
export interface ScreenPoint {
  x: number;
  y: number;
  space: "pixels" | "normalized" | "points";
}

export type ComputerAction =
  | { kind: "screenshot" }
  | { kind: "wait"; seconds: number }
  | { kind: "move"; at: ScreenPoint }
  | { kind: "click"; at: ScreenPoint; button: "left" | "right"; count: 1 | 2 }
  | { kind: "type"; text: string; pressEnter: boolean }
  | { kind: "key"; combo: string; repeat: number }
  | { kind: "scroll"; at: ScreenPoint | null; direction: "up" | "down" | "left" | "right"; amount: number }
  /** A provider action we don't support (e.g. drag); refused with a plain message, never faked. */
  | { kind: "unsupported"; name: string };

export interface ComputerResult {
  text: string;
  isError?: boolean;
  /** Present for screenshots, and after every action when the provider wants one. */
  image?: { data: string; mediaType: "image/png" | "image/jpeg" };
  /** Frontmost app after the action, reported to providers that want a location (Gemini's url field). */
  app?: string;
}

/** Longest screenshot edge sent to the model; 1280 keeps cost down and stays inside image limits. */
const MAX_WIDTH = 1280;

export class ComputerTier {
  /** Image pixels per global screen point, from the last screenshot. */
  private pxPerPoint = 1;
  /** Screen size in points, from the last screenshot. */
  private screen: { width: number; height: number } | null = null;

  constructor(
    private readonly native: NativeClient,
    private readonly tools: GuardedTools,
    /** Return a fresh screenshot with every result (Gemini Computer Use expects one). */
    private readonly screenshotAfterEach = false,
  ) {}

  /** @param claim the provider's safety signal, already turned into a claim; it can only raise risk. */
  async run(action: ComputerAction, claim?: ActionClaim): Promise<ComputerResult> {
    const result = await this.perform(action, claim);
    if (this.screenshotAfterEach && action.kind !== "screenshot") {
      const shot = await this.capture();
      return { ...result, image: shot.image, app: shot.app };
    }
    return result;
  }

  private async perform(action: ComputerAction, claim?: ActionClaim): Promise<ComputerResult> {
    switch (action.kind) {
      case "screenshot":
        return this.capture();
      case "wait": {
        const seconds = Math.min(10, Math.max(0, action.seconds));
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return { text: "OK" };
      }
      case "move":
        return { text: "OK" };
      case "click":
        return this.click(action, claim);
      case "type": {
        const typed = this.fromOutcome(
          await this.tools.runAction(
            async () => ({
              tier: "computer",
              op: "computer.type",
              input: { text: action.text },
              target: await this.frontTarget(),
              claim,
            }),
            async () => {
              const r = await this.native.call("input.type", { text: action.text });
              if (!r.ok)
                throw new ToolError(r.error ?? "Typing was refused (the field may be a password field).");
              return "OK";
            },
          ),
        );
        if (typed.isError || !action.pressEnter) return typed;
        return this.perform({ kind: "key", combo: "Return", repeat: 1 }, claim);
      }
      case "key": {
        const repeat = Math.min(20, Math.max(1, action.repeat));
        const { key, modifiers } = parseCombo(action.combo);
        return this.fromOutcome(
          await this.tools.runAction(
            async () => ({
              tier: "computer",
              op: "computer.key",
              input: { key: action.combo.toLowerCase(), repeat },
              target: await this.frontTarget(),
              claim,
            }),
            async () => {
              for (let i = 0; i < repeat; i++) await this.native.call("input.key", { key, modifiers });
              return "OK";
            },
          ),
        );
      }
      case "scroll": {
        const [x, y] = action.at ? await this.toPoint(action.at) : await this.center();
        const amount = Math.min(2000, Math.max(10, action.amount));
        const dx = action.direction === "left" ? -amount : action.direction === "right" ? amount : 0;
        // CGEvent convention (contracts/native.ts): positive dy shows content above, so "down" is negative.
        const dy = action.direction === "up" ? amount : action.direction === "down" ? -amount : 0;
        return this.fromOutcome(
          await this.tools.runAction(
            async () => ({ tier: "computer", op: "computer.scroll", target: { point: [x, y] } }),
            async () => {
              await this.native.call("input.scroll", { x, y, dx, dy });
              return "OK";
            },
          ),
        );
      }
      case "unsupported":
        return {
          text: `The ${action.name} action is not available here. Use a click, typing or keys instead.`,
          isError: true,
        };
    }
  }

  private async capture(): Promise<ComputerResult> {
    const shot = await this.native.call("screen.capture", { maxWidth: MAX_WIDTH, format: "png" });
    this.pxPerPoint = shot.scale > 0 ? shot.scale : 1;
    this.screen = { width: shot.width / this.pxPerPoint, height: shot.height / this.pxPerPoint };
    const front = await this.native.call("apps.frontmost", {});
    return {
      text: "OK",
      image: { data: shot.data, mediaType: shot.format === "png" ? "image/png" : "image/jpeg" },
      app: front.app?.bundleId,
    };
  }

  private async click(
    action: Extract<ComputerAction, { kind: "click" }>,
    claim?: ActionClaim,
  ): Promise<ComputerResult> {
    if (action.at.space === "pixels" && !this.screen) {
      return { text: "Take a screenshot first so coordinates match the screen.", isError: true };
    }
    const [x, y] = await this.toPoint(action.at);
    const op =
      action.button === "right"
        ? "computer.right_click"
        : action.count === 2
          ? "computer.double_click"
          : "computer.left_click";
    return this.fromOutcome(
      await this.tools.runAction(
        async () => {
          const snap = await this.native.call("ax.targets", { maxCount: 500 });
          const hit = hitTest(snap.targets, x, y);
          const owner = hit?.owner ?? snap.owner ?? undefined;
          return {
            tier: "computer",
            op,
            target: {
              point: [x, y],
              ref: hit?.id,
              label: hit?.label,
              role: hit?.role,
              secure: hit?.secure,
              origin: owner,
              simulated: isSimulatedApp(owner),
            },
            claim,
          };
        },
        async () => {
          await this.native.call("input.click", { x, y, button: action.button, count: action.count });
          return "OK";
        },
      ),
    );
  }

  private async frontTarget() {
    const front = await this.native.call("apps.frontmost", {});
    const id = front.app?.bundleId;
    return { origin: id, label: front.app?.name, simulated: isSimulatedApp(id) };
  }

  /** Global screen point for a coordinate in any space. Normalized coordinates need the screen size. */
  private async toPoint(p: ScreenPoint): Promise<[number, number]> {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new ToolError("A coordinate [x, y] is needed.");
    if (p.space === "points") return [Math.round(p.x), Math.round(p.y)];
    if (p.space === "pixels") return [Math.round(p.x / this.pxPerPoint), Math.round(p.y / this.pxPerPoint)];
    if (!this.screen) await this.capture();
    const s = this.screen!;
    const nx = Math.min(999, Math.max(0, p.x));
    const ny = Math.min(999, Math.max(0, p.y));
    return [Math.floor((nx / 1000) * s.width), Math.floor((ny / 1000) * s.height)];
  }

  private async center(): Promise<[number, number]> {
    if (!this.screen) await this.capture();
    return [Math.round(this.screen!.width / 2), Math.round(this.screen!.height / 2)];
  }

  private fromOutcome(o: GuardOutcome<string>): ComputerResult {
    if (o.status === "done") return { text: o.value };
    if (o.status === "change")
      return { text: `The person wants a change before this: ${o.change}`, isError: true };
    return { text: `Not done: ${o.reason}`, isError: true };
  }
}

/** The smallest target whose rectangle contains the point. */
export function hitTest(targets: Target[], x: number, y: number): Target | undefined {
  const inside = (r: ScreenRect) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  return targets
    .filter((t) => inside(t.rect))
    .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
}

const MOD: Record<string, Modifier> = {
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "cmd",
  command: "cmd",
  super: "cmd",
  meta: "cmd",
  alt: "alt",
  option: "alt",
  shift: "shift",
  fn: "fn",
};

export function parseCombo(combo: string): { key: string; modifiers: Modifier[] } {
  const parts = combo
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop() ?? "";
  const modifiers = parts.map((p) => MOD[p.toLowerCase()]).filter((m): m is Modifier => !!m);
  return { key, modifiers };
}
