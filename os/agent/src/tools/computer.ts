/**
 * Tier (d): Claude computer use, the general fallback for any app. Implements the members of
 * `computer_toolset_20260801` on top of agency-native. Every member with an effect goes through the guard;
 * a pixel click is resolved to the accessibility element under it so it can be classified by its label, and
 * a click on something without a label is treated as consequential (we ask rather than guess).
 *
 * Screenshots go to the model only during an active task, are kept in memory only for that task's
 * conversation, and are never written to disk.
 */

import type { Modifier, ScreenRect, Target } from "@agency/contracts";
import type { GuardOutcome } from "../guard";
import type { NativeClient } from "../types";
import { isSimulatedApp, ToolError, type GuardedTools } from "./guarded";

/** Members we can't implement faithfully with agency-native are switched off rather than faked. */
export const COMPUTER_TOOLSET = {
  type: "computer_toolset_20260801" as const,
  configs: {
    zoom: { enabled: false },
    hold_key: { enabled: false },
    left_mouse_down: { enabled: false },
    left_mouse_up: { enabled: false },
    left_click_drag: { enabled: false },
    middle_click: { enabled: false },
    triple_click: { enabled: false },
  },
};

export type ComputerResult =
  | { kind: "text"; text: string; isError?: boolean }
  | { kind: "image"; data: string; mediaType: "image/png" | "image/jpeg" };

/** Longest screenshot edge sent to the model; 1280 keeps cost down and stays inside image limits. */
const MAX_WIDTH = 1280;

export class ComputerTier {
  /** Image pixels per global screen point, from the last screenshot. */
  private pxPerPoint = 1;
  private hasScreenshot = false;

  constructor(private readonly native: NativeClient, private readonly tools: GuardedTools) {}

  async run(member: string, input: Record<string, unknown>): Promise<ComputerResult> {
    switch (member) {
      case "screenshot":
        return this.screenshot();
      case "cursor_position":
        return { kind: "text", text: "Cursor position is not tracked; take a screenshot instead.", isError: true };
      case "wait": {
        const seconds = Math.min(10, Math.max(0, Number(input.duration ?? 1)));
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return { kind: "text", text: "OK" };
      }
      case "mouse_move":
        return { kind: "text", text: "OK" };
      case "left_click":
      case "right_click":
      case "double_click":
        return this.click(member, input);
      case "type":
        return this.fromOutcome(await this.tools.runAction(
          async () => ({ tier: "computer", op: "computer.type", input: { text: String(input.text ?? "") }, target: await this.frontTarget() }),
          async () => {
            const r = await this.native.call("input.type", { text: String(input.text ?? "") });
            if (!r.ok) throw new ToolError(r.error ?? "Typing was refused (the field may be a password field).");
            return "OK";
          },
        ));
      case "key": {
        const combo = String(input.text ?? "");
        const repeat = Math.min(20, Math.max(1, Number(input.repeat ?? 1)));
        const { key, modifiers } = parseCombo(combo);
        return this.fromOutcome(await this.tools.runAction(
          async () => ({ tier: "computer", op: "computer.key", input: { key: combo.toLowerCase(), repeat }, target: await this.frontTarget() }),
          async () => {
            for (let i = 0; i < repeat; i++) await this.native.call("input.key", { key, modifiers });
            return "OK";
          },
        ));
      }
      case "scroll": {
        const [x, y] = this.toPoint(input.coordinate);
        const amount = Math.min(20, Math.max(1, Number(input.scroll_amount ?? 3))) * 40;
        const dir = String(input.scroll_direction ?? "down");
        const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
        const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
        return this.fromOutcome(await this.tools.runAction(
          async () => ({ tier: "computer", op: "computer.scroll", target: { point: [x, y] } }),
          async () => {
            await this.native.call("input.scroll", { x, y, dx, dy });
            return "OK";
          },
        ));
      }
      default:
        return { kind: "text", text: `The ${member} action is not available here.`, isError: true };
    }
  }

  private async screenshot(): Promise<ComputerResult> {
    const shot = await this.native.call("screen.capture", { maxWidth: MAX_WIDTH, format: "jpeg" });
    this.pxPerPoint = shot.scale > 0 ? shot.scale : 1;
    this.hasScreenshot = true;
    return { kind: "image", data: shot.data, mediaType: shot.format === "png" ? "image/png" : "image/jpeg" };
  }

  private async click(member: "left_click" | "right_click" | "double_click", input: Record<string, unknown>): Promise<ComputerResult> {
    if (!this.hasScreenshot) return { kind: "text", text: "Take a screenshot first so coordinates match the screen.", isError: true };
    const [x, y] = this.toPoint(input.coordinate);
    return this.fromOutcome(await this.tools.runAction(
      async () => {
        const snap = await this.native.call("ax.targets", { maxCount: 500 });
        const hit = hitTest(snap.targets, x, y);
        const owner = hit?.owner ?? snap.owner ?? undefined;
        return {
          tier: "computer",
          op: `computer.${member}`,
          target: { point: [x, y], ref: hit?.id, label: hit?.label, role: hit?.role, secure: hit?.secure, origin: owner, simulated: isSimulatedApp(owner) },
          input: { modifiers: input.text ?? null },
        };
      },
      async () => {
        await this.native.call("input.click", { x, y, button: member === "right_click" ? "right" : "left", count: member === "double_click" ? 2 : 1 });
        return "OK";
      },
    ));
  }

  private async frontTarget() {
    const front = await this.native.call("apps.frontmost", {});
    const id = front.app?.bundleId;
    return { origin: id, label: front.app?.name, simulated: isSimulatedApp(id) };
  }

  private toPoint(coordinate: unknown): [number, number] {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) throw new ToolError("A coordinate [x, y] is needed.");
    const [px, py] = coordinate.map(Number) as [number, number];
    return [Math.round(px / this.pxPerPoint), Math.round(py / this.pxPerPoint)];
  }

  private fromOutcome(o: GuardOutcome<string>): ComputerResult {
    if (o.status === "done") return { kind: "text", text: o.value };
    if (o.status === "change") return { kind: "text", text: `The person wants a change before this: ${o.change}`, isError: true };
    return { kind: "text", text: `Not done: ${o.reason}`, isError: true };
  }
}

/** The smallest target whose rectangle contains the point. */
export function hitTest(targets: Target[], x: number, y: number): Target | undefined {
  const inside = (r: ScreenRect) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  return targets.filter((t) => inside(t.rect)).sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
}

const MOD: Record<string, Modifier> = { ctrl: "ctrl", control: "ctrl", cmd: "cmd", command: "cmd", super: "cmd", meta: "cmd", alt: "alt", option: "alt", shift: "shift", fn: "fn" };

export function parseCombo(combo: string): { key: string; modifiers: Modifier[] } {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  const modifiers = parts.map((p) => MOD[p.toLowerCase()]).filter((m): m is Modifier => !!m);
  return { key, modifiers };
}
