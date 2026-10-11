import { describe, expect, it } from "vitest";
import { appFor, createAppsPack } from "../src/packs/apps";

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
});
