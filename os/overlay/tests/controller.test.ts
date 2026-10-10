import { describe, expect, it } from "vitest";
import { center } from "../src/core/geometry";
import { GAP, MIN_TARGET } from "../src/core/layout";
import { gapBetween, overlapArea } from "./reexports";
import { axTarget, setup, snapshot } from "./helpers";

describe("protected rail", () => {
  it("has Help, Stop, Home, Keyboard and Pause, big and spaced", () => {
    const { ctrl } = setup();
    const rail = ctrl.buttons().filter((b) => b.kind === "rail");
    expect(rail.filter((b) => b.protected).map((b) => b.id)).toEqual([
      "overlay:help",
      "overlay:stop",
      "overlay:home",
      "overlay:keyboard",
      "overlay:pause",
    ]);
    for (const b of rail) expect(Math.min(b.rect.width, b.rect.height)).toBeGreaterThanOrEqual(MIN_TARGET);
    for (let i = 1; i < rail.length; i++)
      expect(gapBetween(rail[i - 1]!.rect, rail[i]!.rect)).toBeGreaterThanOrEqual(GAP);
  });

  it("Help sends a Lifeline help request first, then surfaces the shell", () => {
    const { ctrl, host, lookAt } = setup();
    lookAt("overlay:help");
    expect(host.calls.slice(0, 2)).toEqual([
      { kind: "lifeline", params: { type: "lifeline.help", source: "help_button" } },
      { kind: "lifeline", params: { type: "lifeline.surface" } },
    ]);
    expect(ctrl.view().notice?.text).toMatch(/help/i);
  });

  it("Stop calls stopAll and cancels scrolling and one-shot modes", () => {
    const { ctrl, host, lookAt, away } = setup();
    lookAt("overlay:more");
    away();
    lookAt("menu:drag");
    expect(ctrl.view().pointer).toBe("drag");
    away();
    lookAt("overlay:stop");
    expect(host.stopped).toBe(1);
    expect(ctrl.view().pointer).toBe("press");
  });

  it("while paused only protected targets respond, and Help still works", () => {
    const { ctrl, host, lookAt, away } = setup();
    ctrl.setTargets(snapshot([axTarget("ok", 600, 400, 200, 100)]));
    lookAt("overlay:pause");
    expect(ctrl.view().paused).toBe(true);
    away(1600);
    lookAt("ok", 3000);
    expect(host.nativeCalls("ax.press")).toHaveLength(0);
    expect(ctrl.buttons().some((b) => b.id === "overlay:more")).toBe(true);
    lookAt("overlay:more", 3000);
    expect(ctrl.view().panel).toBeNull();
    away();
    lookAt("overlay:help");
    expect(host.calls.some((c) => c.kind === "lifeline")).toBe(true);
  });

  it("resuming takes a longer look than pausing", () => {
    const { ctrl, lookAt, away } = setup();
    lookAt("overlay:pause");
    away();
    lookAt("overlay:pause", 1300); // a normal dwell is 1200 ms
    expect(ctrl.view().paused).toBe(true);
    away();
    lookAt("overlay:pause", 1900);
    expect(ctrl.view().paused).toBe(false);
  });

  it("Stop works from a mouse click (helper) as well as by eye", () => {
    const { host, ctrl } = setup();
    ctrl.activate("overlay:stop");
    expect(host.stopped).toBe(1);
  });
});

describe("dwell on app controls", () => {
  it("presses with AXPress", async () => {
    const { host, ctrl, lookAt, flush } = setup();
    ctrl.setTargets(snapshot([axTarget("open", 600, 400, 200, 100)]));
    lookAt("open");
    await flush();
    expect(host.nativeCalls("ax.press")).toEqual([
      { kind: "native", method: "ax.press", params: { targetId: "open" } },
    ]);
    expect(host.nativeCalls("input.click")).toHaveLength(0);
  });

  it("falls back to a click at the centre and says so", async () => {
    const { host, ctrl, lookAt, flush } = setup({}, { pressFails: ["open"] });
    ctrl.setTargets(snapshot([axTarget("open", 600, 400, 200, 100)]));
    lookAt("open");
    await flush();
    await flush();
    expect(host.nativeCalls("input.click")[0]?.params).toEqual({ x: 700, y: 450 });
    expect(ctrl.view().notice?.text).toMatch(/clicked it instead/);
  });

  it("presses web targets through the bridge", async () => {
    const { host, ctrl, lookAt, flush } = setup();
    ctrl.setTargets(snapshot([axTarget("w1", 600, 400, 200, 100, { source: "web" })]));
    lookAt("w1");
    await flush();
    expect(host.calls.some((c) => c.kind === "pressWeb")).toBe(true);
  });

  it("does not dwell the shell's own targets (the shell runs its own dwell)", () => {
    const { host, ctrl, lookAt } = setup();
    ctrl.setTargets(snapshot([axTarget("s1", 600, 400, 200, 100, { source: "shell" })]));
    lookAt("s1");
    expect(host.calls).toHaveLength(0);
  });

  it("does not activate with poor tracking confidence", () => {
    const { host, ctrl, look } = setup();
    ctrl.setTargets(snapshot([axTarget("open", 600, 400, 200, 100)]));
    look(700, 450, 3000, 0.3);
    expect(host.nativeCalls()).toHaveLength(0);
  });

  it("asks which one instead of guessing between small neighbours", async () => {
    const { host, ctrl, look, lookAt, away, flush } = setup();
    ctrl.setTargets(
      snapshot([
        axTarget("bold", 600, 400, 20, 20),
        axTarget("italic", 626, 400, 20, 20),
        axTarget("under", 652, 400, 20, 20),
      ]),
    );
    look(636, 410, 1600);
    expect(host.nativeCalls("ax.press")).toHaveLength(0);
    const v = ctrl.view();
    expect(v.panel?.kind).toBe("picker");
    expect(v.panel?.title).toBe("Which one?");
    const items = v.buttons.filter((b) => b.id.startsWith("pick:"));
    expect(items.map((b) => b.label).sort()).toEqual(["bold", "italic", "under"]);
    // The picker never covers the area being looked at.
    for (const t of ["bold", "italic", "under"]) {
      expect(overlapArea(v.panel!.rect, { x: 600, y: 400, width: 72, height: 20 })).toBe(0);
      void t;
    }
    away();
    lookAt("pick:italic");
    await flush();
    expect(host.nativeCalls("ax.press")[0]?.params).toEqual({ targetId: "italic" });
    expect(ctrl.view().panel).toBeNull();
  });

  it("shows a zoomed map when there are too many candidates", () => {
    const { ctrl, look } = setup();
    const ts = Array.from({ length: 10 }, (_, i) =>
      axTarget(`t${i}`, 600 + (i % 5) * 18, 400 + Math.floor(i / 5) * 18, 14, 14),
    );
    ctrl.setTargets(snapshot(ts));
    look(640, 410, 1600);
    const v = ctrl.view();
    expect(v.panel?.kind).toBe("picker");
    expect(v.map?.boxes.length).toBeGreaterThan(6);
    expect(v.buttons.filter((b) => b.id.startsWith("pick:")).every((b) => typeof b.n === "number")).toBe(
      true,
    );
    expect(v.panel!.pages).toBeGreaterThan(1);
  });

  it("ignores app controls hidden under the overlay's own buttons", () => {
    const { host, ctrl, look } = setup();
    const help = ctrl.buttons().find((b) => b.id === "overlay:help")!;
    const c = center(help.rect);
    ctrl.setTargets(snapshot([axTarget("under", c.x - 10, c.y - 10, 20, 20)]));
    look(c.x, c.y, 1600);
    expect(host.nativeCalls("ax.press")).toHaveLength(0);
    expect(host.calls[0]?.kind).toBe("lifeline");
  });

  it("publishes its clickable regions so the window is click-through elsewhere", () => {
    const { host, ctrl } = setup();
    ctrl.setDisplay({ x: 0, y: 0, width: 1470, height: 956 });
    expect(host.regions.length).toBe(6);
  });
});

describe("pointer modes are one-shot", () => {
  it("right-click then back to press", async () => {
    const { host, ctrl, lookAt, away, flush } = setup();
    ctrl.setTargets(snapshot([axTarget("file", 600, 400, 200, 100)]));
    lookAt("overlay:more");
    away();
    lookAt("menu:right-click");
    away();
    lookAt("file");
    await flush();
    expect(host.nativeCalls("input.click")[0]?.params).toEqual({ x: 700, y: 450, button: "right" });
    expect(ctrl.view().pointer).toBe("press");
  });

  it("double-click", async () => {
    const { host, ctrl, lookAt, away } = setup();
    ctrl.setTargets(snapshot([axTarget("file", 600, 400, 200, 100)]));
    ctrl.activate("overlay:more");
    lookAt("menu:double-click");
    away();
    lookAt("file");
    expect(host.nativeCalls("input.click")[0]?.params).toEqual({ x: 700, y: 450, count: 2 });
  });

  it("drag picks up then drops, and says when dragging is unavailable", async () => {
    const withDrag = setup({}, { withDrag: true });
    withDrag.ctrl.setTargets(
      snapshot([axTarget("file", 300, 300, 200, 100), axTarget("folder", 800, 600, 200, 100)]),
    );
    withDrag.ctrl.activate("overlay:more");
    withDrag.ctrl.activate("menu:drag");
    withDrag.ctrl.activate("file");
    expect(withDrag.ctrl.view().dragging).toBe(true);
    withDrag.ctrl.activate("folder");
    await withDrag.flush();
    expect(withDrag.host.calls.find((c) => c.kind === "drag")?.params).toEqual({
      from: { x: 400, y: 350 },
      to: { x: 900, y: 650 },
    });

    const without = setup();
    without.ctrl.setTargets(
      snapshot([axTarget("file", 300, 300, 200, 100), axTarget("folder", 800, 600, 200, 100)]),
    );
    without.ctrl.activate("menu:drag");
    without.ctrl.activate("file");
    without.ctrl.activate("folder");
    expect(without.ctrl.view().notice?.text).toMatch(/isn't available/);
  });
});

describe("modes", () => {
  it("numbers mode labels every control in reading order and pages them", async () => {
    const { host, ctrl, lookAt, away, flush } = setup();
    const ts = Array.from({ length: 9 }, (_, i) =>
      axTarget(`b${i}`, 100 + (i % 3) * 300, 100 + Math.floor(i / 3) * 200, 100, 40),
    );
    ctrl.setTargets(snapshot(ts));
    ctrl.activate("overlay:more");
    ctrl.activate("menu:numbers");
    const v = ctrl.view();
    expect(v.badges.map((b) => b.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(v.panel?.pages).toBe(2);
    expect(v.buttons.filter((b) => b.id.startsWith("num:")).map((b) => b.n)).toEqual([1, 2, 3, 4, 5, 6]);
    lookAt("panel:next");
    away();
    expect(
      ctrl
        .view()
        .buttons.filter((b) => b.id.startsWith("num:"))
        .map((b) => b.n),
    ).toEqual([7, 8, 9]);
    lookAt("num:b7");
    await flush();
    expect(host.nativeCalls("ax.press")[0]?.params).toEqual({ targetId: "b7" });
  });

  it("scroll zones page while looked at, and stop when the gaze leaves", () => {
    const { host, ctrl, lookAt, away } = setup({ scrollRepeatMs: 1000 });
    ctrl.activate("overlay:more");
    ctrl.activate("menu:scroll");
    lookAt("zone:down", 1300);
    expect(host.nativeCalls("input.scroll")).toHaveLength(1);
    expect((host.nativeCalls("input.scroll")[0]?.params as { dy: number }).dy).toBeLessThan(0);
    lookAt("zone:down", 2100);
    const n = host.nativeCalls("input.scroll").length;
    expect(n).toBeGreaterThanOrEqual(3);
    away(3000);
    expect(host.nativeCalls("input.scroll")).toHaveLength(n);
  });

  it("app switcher activates running apps and launches others", async () => {
    const { host, ctrl, flush } = setup();
    ctrl.activate("overlay:more");
    ctrl.activate("menu:apps");
    await flush();
    const items = ctrl.view().buttons.filter((b) => b.id.startsWith("app:"));
    expect(items[0]?.label).toBe("Finder"); // running first
    ctrl.activate("app:com.google.Chrome");
    ctrl.activate("overlay:more");
    ctrl.activate("menu:apps");
    await flush();
    ctrl.activate("app:com.apple.mail");
    await flush();
    expect(host.nativeCalls("apps.activate")[0]?.params).toEqual({ bundleId: "com.google.Chrome" });
    expect(host.nativeCalls("apps.launch")[0]?.params).toEqual({ bundleId: "com.apple.mail" });
    expect(host.nativeCalls().some((c) => /quit|terminate/.test(c.method ?? ""))).toBe(false);
  });

  it("can move the rail to the other side", () => {
    const { ctrl } = setup();
    ctrl.activate("overlay:more");
    ctrl.activate("menu:side");
    expect(ctrl.view().railSide).toBe("left");
    expect(ctrl.buttons().find((b) => b.id === "overlay:help")!.rect.x).toBeLessThan(100);
  });
});

describe("keyboard", () => {
  it("opens when a text field is chosen, away from the field, and types into it", async () => {
    const { host, ctrl, flush } = setup();
    const field = axTarget("to", 300, 820, 600, 40, { role: "textfield", label: "To" });
    ctrl.setTargets(snapshot([field]));
    ctrl.activate("to");
    const kb = ctrl.view().keyboard!;
    expect(kb).not.toBeNull();
    expect(overlapArea(kb.rect, field.rect)).toBe(0);
    ctrl.activate("key:h");
    ctrl.activate("key:i");
    await flush();
    expect(host.nativeCalls("input.type").map((c) => (c.params as { text: string }).text)).toEqual([
      "H",
      "i",
    ]);
    expect(ctrl.currentComposition).toBe("Hi");
  });

  it("predicts words and completes them with a space", async () => {
    const { host, ctrl, flush } = setup();
    ctrl.activate("overlay:keyboard");
    ctrl.activate("key:w");
    ctrl.activate("key:a");
    const pred = ctrl.buttons().filter((b) => b.id.startsWith("key:predict"));
    expect(pred.map((b) => b.label)).toContain("water");
    const slot = pred.find((b) => b.label === "water")!;
    ctrl.activate(slot.id);
    await flush();
    expect(ctrl.currentComposition).toBe("Water ");
    expect(host.nativeCalls("input.type").at(-1)?.params).toEqual({ text: "ter " });
  });

  it("offers memory phrases on an empty line and logs only the chosen phrase", async () => {
    const { host, ctrl, flush } = setup({}, { phrases: ["Please turn me over", "I'm thirsty"] });
    ctrl.activate("overlay:keyboard");
    await flush();
    const p = ctrl.buttons().find((b) => b.label === "Please turn me over")!;
    ctrl.activate(p.id);
    await flush();
    expect(host.nativeCalls("input.type").at(-1)?.params).toEqual({ text: "Please turn me over" });
    expect(host.calls.filter((c) => c.kind === "logSelection")).toEqual([
      {
        kind: "logSelection",
        params: { path: ["keyboard", "Please turn me over"], surface: "keyboard", outcome: "chosen" },
      },
    ]);
  });

  it("never types, shows or logs anything for a password field", async () => {
    const { host, ctrl, flush } = setup({}, { phrases: ["hello"] });
    const pw = axTarget("pw", 300, 200, 400, 40, { role: "textfield", label: "Password", secure: true });
    ctrl.setTargets(snapshot([pw]));
    ctrl.activate("pw");
    await flush();
    const v = ctrl.view();
    expect(v.keyboard?.secure).toBe(true);
    expect(v.notice?.text).toMatch(/never types passwords/);
    expect(v.buttons.filter((b) => b.kind === "key").map((b) => b.id)).toEqual(["key:hide"]);
    ctrl.activate("key:a");
    await flush();
    expect(host.nativeCalls("input.type")).toHaveLength(0);
    expect(host.calls.some((c) => c.kind === "logSelection")).toBe(false);
    expect(ctrl.currentComposition).toBe("");
  });

  it("reports a native refusal in plain words and forgets the refused text", async () => {
    const { ctrl, flush } = setup({}, { secureFocused: true });
    ctrl.activate("overlay:keyboard");
    ctrl.activate("key:a");
    await flush();
    await flush();
    expect(ctrl.view().notice?.text).toMatch(/password/);
    expect(ctrl.currentComposition).toBe("");
  });

  it("Return takes a longer look (it may send a message)", () => {
    const { ctrl } = setup();
    ctrl.activate("overlay:keyboard");
    expect(ctrl.buttons().find((b) => b.id === "key:return")?.dwellScale).toBe(1.5);
  });

  it("app controls under the keyboard are not selectable", () => {
    const { host, ctrl, look } = setup();
    ctrl.activate("overlay:keyboard");
    const kb = ctrl.view().keyboard!.rect;
    // a gap between keys, over an app button
    ctrl.setTargets(snapshot([axTarget("hidden", kb.x + 4, kb.y + 4, 10, 10)]));
    look(kb.x + 9, kb.y + 9, 2000);
    expect(host.nativeCalls("ax.press")).toHaveLength(0);
  });
});

describe("single switch scanning", () => {
  it("highlights in turn and selects with a press", () => {
    const { ctrl, host } = setup();
    ctrl.handleGaze({ type: "switch", t: 0, source: "key" });
    expect(ctrl.view().scanHighlight).toBe("overlay:help");
    ctrl.tick(1500 + 700 + 1);
    expect(ctrl.view().scanHighlight).toBe("overlay:stop");
    ctrl.handleGaze({ type: "switch", t: 2300, source: "key" });
    expect(host.stopped).toBe(1);
  });
});
