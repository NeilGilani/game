import { describe, expect, it } from "vitest";
import type { NativeEvent } from "../../contracts/src/native";
import type { Target } from "../../contracts/src/targets";
import { FakeNative, NativeError, NativeErrorCode, keyRefusal } from "./fakeNative";

const button = (id: string, x = 0): Target => ({
  id,
  rect: { x, y: 0, width: 120, height: 96 },
  role: "button",
  label: id,
  source: "ax",
  owner: "com.example",
});
const message: Target = {
  id: "msg",
  rect: { x: 0, y: 200, width: 300, height: 96 },
  role: "textfield",
  label: "Message",
  source: "ax",
};
const password: Target = {
  id: "pw",
  rect: { x: 0, y: 400, width: 300, height: 96 },
  role: "textfield",
  label: "Password",
  source: "ax",
  secure: true,
};

async function rejects(p: Promise<unknown>): Promise<NativeError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof NativeError) return e;
    throw e;
  }
  throw new Error("expected a NativeError");
}

describe("FakeNative", () => {
  it("returns snapshots with a cap and truncated flag", async () => {
    const native = new FakeNative({
      targets: [button("a"), button("b", 200), button("c", 400)],
      owner: "com.example",
    });
    const all = await native.call("ax.targets", {});
    expect(all.targets.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(all.owner).toBe("com.example");
    expect(all.truncated).toBe(false);
    const capped = await native.call("ax.targets", { maxCount: 2 });
    expect(capped.targets).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it("presses targets and focuses text fields", async () => {
    const native = new FakeNative({ targets: [button("ok"), message] });
    expect(await native.call("ax.press", { targetId: "ok" })).toEqual({ ok: true });
    expect(await native.call("ax.press", { targetId: "msg" })).toEqual({ ok: true });
    expect(native.focusedTargetId).toBe("msg");
    const gone = await native.call("ax.press", { targetId: "nope" });
    expect(gone.ok).toBe(false);
    expect(native.pressed).toEqual(["ok", "msg"]);
  });

  it("types into ordinary fields but never into password fields, and never records refused text", async () => {
    const native = new FakeNative({ targets: [message, password] });
    expect((await native.call("input.type", { text: "hi" })).ok).toBe(false); // nothing focused
    await native.call("ax.press", { targetId: "msg" });
    expect(await native.call("input.type", { text: "hello" })).toEqual({ ok: true });
    await native.call("ax.press", { targetId: "pw" });
    const refused = await native.call("input.type", { text: "hunter2" });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/password/i);
    expect(native.typed).toEqual(["hello"]);
    expect(JSON.stringify(native.calls)).not.toContain("hunter2");
  });

  it("refuses quit, lock and delete key combos", async () => {
    const native = new FakeNative();
    expect(await native.call("input.key", { key: "c", modifiers: ["cmd"] })).toEqual({ ok: true });
    expect((await native.call("input.key", { key: "q", modifiers: ["cmd"] })).ok).toBe(false);
    expect((await native.call("input.key", { key: "backspace", modifiers: ["cmd"] })).ok).toBe(false);
    expect(native.keys).toEqual([{ key: "c", modifiers: ["cmd"] }]);
    expect(keyRefusal("q", ["ctrl", "cmd"])).toMatch(/lock/);
    expect(keyRefusal("q")).toBeNull();
  });

  it("gates methods on permissions with a plain message, but never stopAll", async () => {
    const native = new FakeNative({ permissions: { accessibility: "denied" } });
    const e = await rejects(native.call("ax.targets", {}));
    expect(e.code).toBe(NativeErrorCode.permissionMissing);
    expect(e.message).toContain("Privacy & Security > Accessibility");
    expect(await native.call("input.stopAll", {})).toEqual({ ok: true });
  });

  it("stopAll cancels synthetic input that hasn't happened yet", async () => {
    const native = new FakeNative({ actionDelayMs: 20 });
    const click = native.call("input.click", { x: 1, y: 1 });
    await native.call("input.stopAll", {});
    const e = await rejects(click);
    expect(e.code).toBe(NativeErrorCode.stopped);
    expect(native.clicks).toEqual([]);
    expect(await native.call("input.click", { x: 2, y: 2 })).toEqual({ ok: true });
    expect(native.stopCount).toBe(1);
  });

  it("rate-limits synthetic input when configured", async () => {
    let now = 0;
    const native = new FakeNative({ rateLimit: { capacity: 2, refillPerSecond: 1, now: () => now } });
    await native.call("input.click", { x: 1, y: 1 });
    await native.call("input.click", { x: 1, y: 1 });
    expect((await rejects(native.call("input.click", { x: 1, y: 1 }))).code).toBe(
      NativeErrorCode.rateLimited,
    );
    now = 1000;
    expect(await native.call("input.click", { x: 1, y: 1 })).toEqual({ ok: true });
    // Reads are never rate-limited.
    await native.call("ax.targets", {});
  });

  it("emits events for targets, frontmost apps, permissions and speech", async () => {
    const native = new FakeNative();
    const events: NativeEvent[] = [];
    const off = native.onEvent((e) => events.push(e));
    native.setTargets([button("x")], "com.example");
    expect(await native.call("apps.launch", { bundleId: "com.google.Chrome" })).toEqual({ ok: true });
    expect((await native.call("apps.frontmost", {})).app?.bundleId).toBe("com.google.Chrome");
    native.setPermission("camera", "denied");
    native.hear("ignored: not listening");
    await native.call("speech.listen", { on: true });
    native.hear("Hello, pharmacy", false);
    native.hear("Hello, pharmacy here");
    off();
    native.setTargets([]);
    expect(events.map((e) => e.type)).toEqual([
      "targets-changed",
      "frontmost-changed",
      "targets-changed",
      "permission-changed",
      "speech-partial",
      "speech-final",
    ]);
  });

  it("lists apps, launches only installed ones and has no quit", async () => {
    const native = new FakeNative();
    const { apps } = await native.call("apps.list", { includeIcons: true });
    expect(apps.every((a) => typeof a.iconPng === "string")).toBe(true);
    expect((await native.call("apps.launch", { bundleId: "com.nope" })).ok).toBe(false);
    const e = await rejects(native.call("apps.quit" as never, {} as never));
    expect(e.code).toBe(NativeErrorCode.methodNotFound);
  });

  it("drags and hides apps", async () => {
    const native = new FakeNative();
    expect((await native.call("input.drag", { from: { x: 1, y: 2 }, to: { x: 30, y: 40 } })).ok).toBe(true);
    expect(native.drags).toEqual([{ from: { x: 1, y: 2 }, to: { x: 30, y: 40 } }]);
    expect((await native.call("apps.hide", { bundleId: "com.apple.finder" })).ok).toBe(true);
    expect((await native.call("apps.hide", { bundleId: "com.google.Chrome" })).ok).toBe(false); // not running
  });

  it("speaks, lists voices, captures and checks listening permissions", async () => {
    const native = new FakeNative({ permissions: { microphone: "denied" } });
    await native.call("speech.say", { text: "Hi" });
    expect(native.spoken).toEqual(["Hi"]);
    expect((await native.call("speech.voices", {})).voices.length).toBeGreaterThan(0);
    const shot = await native.call("screen.capture", { format: "png" });
    expect(shot.width).toBe(1);
    const listen = await native.call("speech.listen", { on: true });
    expect(listen.ok).toBe(false);
    expect(listen.error).toContain("Microphone");
  });
});
