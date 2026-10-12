import { describe, expect, it } from "vitest";
import type { GuardOutcome } from "../src/guard";
import { appFor, createAppsPack } from "../src/packs/apps";
import type { GuardedTools } from "../src/tools/guarded";
import type { PackContext } from "../src/types";

const req = (goal: string, selections?: Record<string, string>) => ({
  id: "t",
  goal,
  origin: "flow" as const,
  ...(selections ? { selections } : {}),
});

describe("apps pack (no model)", () => {
  const pack = createAppsPack();

  it("takes opening an app and playing in Music", () => {
    expect(pack.matches(req("Open Safari"))).toBe(true);
    expect(pack.matches(req("Play Calm music in the Music app", { kind: "watch", app: "Music" }))).toBe(true);
    expect(pack.steps(req("Play Calm music in the Music app", { app: "Music" })).map((s) => s.id)).toEqual([
      "open",
      "play",
    ]);
    expect(pack.steps(req("Open Notes")).map((s) => s.id)).toEqual(["open"]);
  });

  it("leaves everything else to the model", () => {
    expect(pack.matches(req("Open Netflix in Chrome and continue watching"))).toBe(false);
    expect(pack.matches(req("Send Jordan a message in the Messages app"))).toBe(false);
    expect(pack.matches(req("Open my bank account"))).toBe(false);
  });

  it("only opens apps it knows by name", () => {
    expect(appFor(req("Open Music"))).toEqual({ name: "Music", bundleId: "com.apple.Music" });
    expect(appFor(req("Open rm -rf"))).toBeNull();
  });

  it("doesn't take a goal that asks for more than opening the app (it would report it done)", () => {
    expect(pack.matches(req("Open a new note in the Notes app"))).toBe(false);
    expect(pack.matches(req("Open the Notes app and write a shopping list"))).toBe(false);
    expect(pack.matches(req("Start a FaceTime call with Mom in the FaceTime app"))).toBe(false);
    expect(pack.matches(req("Open my email", { app: "Mail" }))).toBe(false);
    expect(pack.matches(req("Open the Music app."))).toBe(true);
    expect(pack.matches(req("switch to google chrome"))).toBe(true);
  });

  it("opens the app the goal names, not a leftover flow choice", () => {
    expect(appFor(req("Open Notes", { app: "Music" }))).toEqual({
      name: "Notes",
      bundleId: "com.apple.Notes",
    });
  });
});

/** A stand-in for the guarded tools: the frontmost app and its controls, and what was done. */
function fakeTools(state: {
  front: string;
  targets: { id: string; role: string; label: string }[];
  /** What pressing Play does (default: Music starts playing at once). */
  onPlay?: () => void;
  launchFront?: string;
}) {
  const done: string[] = [];
  const ok = (value: string): GuardOutcome<string> => ({
    status: "done",
    value,
    classification: { risk: "reversible", reason: "test" },
  });
  const tools = {
    openApp: async (bundleId: string) => {
      done.push(`open ${bundleId}`);
      state.front = state.launchFront ?? bundleId;
      return ok("opened");
    },
    readApp: async () => ({ owner: state.front, targets: state.targets }),
    press: async (id: string) => {
      done.push(`press ${id} in ${state.front}`);
      if (state.onPlay) state.onPlay();
      else state.targets = [{ id: "pause", role: "button", label: "Pause" }];
      return ok("pressed");
    },
    key: async (key: string) => {
      done.push(`key ${key} in ${state.front}`);
      return ok("pressed");
    },
  };
  return { tools: tools as unknown as GuardedTools, done };
}

function ctx(tools: GuardedTools): PackContext {
  return {
    request: req("Play my morning playlist in Music", { app: "Music" }),
    tools,
    ask: async () => ({ optionId: null }),
    values: {},
  };
}

describe("apps pack: Play in Music", () => {
  const pack = createAppsPack({ settleMs: 1, checks: 3 });
  const play = pack
    .steps(req("Play my morning playlist in Music", { app: "Music" }))
    .find((s) => s.id === "play")!;

  it("never presses Play or the space bar in another app; brings Music forward first", async () => {
    const state = {
      front: "com.google.Chrome",
      targets: [{ id: "yt-play", role: "button", label: "Play" }],
      launchFront: "com.google.Chrome", // Music won't come forward
    };
    const { tools, done } = fakeTools(state);
    const out = await play.run(ctx(tools));
    expect(out.verified).toBe(false);
    expect(out.summary).toMatch(/isn't in front/);
    expect(done).toEqual(["open com.apple.Music"]);
  });

  it("presses Music's own Play once Music is in front, and confirms by reading Pause back", async () => {
    const state = { front: "com.apple.Music", targets: [{ id: "m-play", role: "button", label: "Play" }] };
    const { tools, done } = fakeTools(state);
    const out = await play.run(ctx(tools));
    expect(out).toMatchObject({ verified: true, summary: "Music is playing." });
    expect(done).toEqual(["press m-play in com.apple.Music"]);
  });

  it("waits a moment for Music to swap Play for Pause instead of failing at once", async () => {
    let reads = 0;
    const state = {
      front: "com.apple.Music",
      targets: [{ id: "m-play", role: "button", label: "Play" }],
      onPlay: () => undefined,
    };
    const { tools } = fakeTools(state);
    const readApp = tools.readApp.bind(tools);
    (tools as { readApp: GuardedTools["readApp"] }).readApp = async (n) => {
      reads += 1;
      if (reads === 3) state.targets = [{ id: "m-pause", role: "button", label: "Pause" }];
      return readApp(n);
    };
    expect((await play.run(ctx(tools))).verified).toBe(true);
  });

  it("says so when nothing starts (no song chosen)", async () => {
    const state = {
      front: "com.apple.Music",
      targets: [{ id: "m-play", role: "button", label: "Play" }],
      onPlay: () => undefined,
    };
    const { tools } = fakeTools(state);
    const out = await play.run(ctx(tools));
    expect(out.verified).toBe(false);
    expect(out.summary).toMatch(/didn't start playing/);
  });

  it("doesn't press anything when Music is already playing", async () => {
    const state = { front: "com.apple.Music", targets: [{ id: "m-pause", role: "button", label: "Pause" }] };
    const { tools, done } = fakeTools(state);
    expect(await play.run(ctx(tools))).toMatchObject({
      verified: true,
      summary: "Music is already playing.",
    });
    expect(done).toEqual([]);
  });

  it("the open step waits for a cold start before calling it a failure", async () => {
    const open = pack.steps(req("Open Music")).find((s) => s.id === "open")!;
    const state = { front: "com.apple.finder", targets: [], launchFront: "com.apple.finder" };
    const { tools } = fakeTools(state);
    let reads = 0;
    (tools as { readApp: GuardedTools["readApp"] }).readApp = async () => {
      reads += 1;
      return { owner: reads >= 2 ? "com.apple.Music" : "com.apple.finder", targets: [] };
    };
    expect((await open.run({ ...ctx(tools), request: req("Open Music") })).verified).toBe(true);
  });
});
