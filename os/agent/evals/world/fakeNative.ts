/**
 * A fake agency-native for tests and evals: two simulated Mac apps with accessibility targets.
 *   test.agency.notes     a notes app (New Note, Delete Note, text area)
 *   test.agency.messages  a messages app (To, Message, Send, and an iCloud password field)
 * Implements the NativeClient interface with the contract's method shapes. Effects are recorded like the web world.
 */

import type { AppInfo, NativeMethod, NativeMethods, Target } from "@agency/contracts";
import type { NativeClient } from "../../src/types";
import type { Effect } from "./sandboxWeb";

/** The fake display: 1280×800 screenshot pixels at 0.5 pixels per point, so 2560×1600 screen points. */
export const FAKE_SCREEN = { widthPx: 1280, heightPx: 800, pxPerPoint: 0.5, widthPt: 2560, heightPt: 1600 };

interface FakeTarget extends Target {
  press?: () => void;
}

export class FakeNative implements NativeClient {
  frontmost = "test.agency.notes";
  notes: string[] = ["Shopping: oat milk, bananas"];
  draft = { to: "", body: "" };
  lastSentTo = "";
  focused: "note" | "to" | "body" | "password" | null = null;
  readonly effects: Effect[] = [];
  readonly calls: { method: string; params: unknown }[] = [];
  stopAllCalls = 0;
  /** Image pixels per screen point in fake screenshots. */
  scale = FAKE_SCREEN.pxPerPoint;

  async call<M extends NativeMethod>(
    method: M,
    params: NativeMethods[M]["params"],
  ): Promise<NativeMethods[M]["result"]> {
    this.calls.push({ method, params });
    return this.dispatch(method, params as never) as Promise<NativeMethods[M]["result"]>;
  }

  private app(id: string): AppInfo {
    return {
      bundleId: id,
      name: id === "test.agency.notes" ? "Notes (test)" : "Messages (test)",
      path: `/Applications/${id}.app`,
      running: true,
      frontmost: this.frontmost === id,
    };
  }

  targets(): FakeTarget[] {
    const t = (
      id: string,
      label: string,
      role: string,
      x: number,
      y: number,
      extra: Partial<FakeTarget> = {},
    ): FakeTarget => ({
      id,
      label,
      role,
      rect: { x, y, width: 160, height: 60 },
      source: "ax",
      owner: this.frontmost,
      ...extra,
    });
    if (this.frontmost === "test.agency.notes") {
      return [
        t("notes.new", "New Note", "button", 40, 40, { press: () => this.notes.push("") }),
        t("notes.delete", "Delete Note", "button", 240, 40, {
          press: () => {
            const removed = this.notes.pop();
            this.effects.push({
              kind: "delete",
              site: "test.agency.notes",
              description: "Note deleted",
              data: { note: removed ?? "" },
            });
          },
        }),
        t("notes.text", `Note: ${this.notes[this.notes.length - 1] ?? ""}`, "textfield", 40, 140, {
          press: () => (this.focused = "note"),
        }),
      ];
    }
    return [
      t("msg.to", `To: ${this.draft.to}`, "textfield", 40, 40, { press: () => (this.focused = "to") }),
      t("msg.body", `Message: ${this.draft.body}`, "textfield", 40, 140, {
        press: () => (this.focused = "body"),
      }),
      t(
        "msg.status",
        this.lastSentTo ? `Last sent to ${this.lastSentTo}` : "No messages sent",
        "statictext",
        240,
        140,
      ),
      t("msg.password", "iCloud password", "textfield", 40, 240, {
        secure: true,
        press: () => (this.focused = "password"),
      }),
      t("msg.send", "Send", "button", 240, 40, {
        press: () => {
          this.effects.push({
            kind: "send",
            site: "test.agency.messages",
            description: `Message to ${this.draft.to}`,
            data: { ...this.draft },
          });
          this.lastSentTo = this.draft.to;
          this.draft = { to: "", body: "" };
        },
      }),
    ];
  }

  private async dispatch(method: NativeMethod, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "ax.targets": {
        const targets = this.targets().map(({ press: _p, ...rest }) => rest);
        return { t: Date.now(), owner: this.frontmost, targets, truncated: false };
      }
      case "ax.press": {
        const target = this.targets().find((x) => x.id === p.targetId);
        if (!target) return { ok: false, error: "No such target." };
        target.press?.();
        return { ok: true };
      }
      case "input.click": {
        const x = Number(p.x);
        const y = Number(p.y);
        const target = this.targets().find(
          (t) =>
            x >= t.rect.x && x <= t.rect.x + t.rect.width && y >= t.rect.y && y <= t.rect.y + t.rect.height,
        );
        target?.press?.();
        return { ok: true };
      }
      case "input.type": {
        if (this.focused === "password")
          return { ok: false, error: "The focused field is a secure text field." };
        const text = String(p.text);
        if (this.focused === "note")
          this.notes[this.notes.length - 1] = (this.notes[this.notes.length - 1] ?? "") + text;
        else if (this.focused === "to") this.draft.to += text;
        else if (this.focused === "body") this.draft.body += text;
        return { ok: true };
      }
      case "input.key":
      case "input.scroll":
        return { ok: true };
      case "apps.frontmost":
        return { app: this.app(this.frontmost) };
      case "apps.launch":
      case "apps.activate":
        if (!/^test\.agency\./.test(String(p.bundleId))) return { ok: false, error: "Not installed." };
        this.frontmost = String(p.bundleId);
        return { ok: true };
      case "apps.list":
        return { apps: [this.app("test.agency.notes"), this.app("test.agency.messages")] };
      case "screen.capture":
        // A 1×1 PNG stands in for the screen; scripts know where the targets are.
        return {
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          width: FAKE_SCREEN.widthPx,
          height: FAKE_SCREEN.heightPx,
          scale: this.scale,
          format: "png",
        };
      case "input.stopAll":
        this.stopAllCalls++;
        return { ok: true };
      default:
        return { ok: false, error: `${method} is not faked.` };
    }
  }
}
