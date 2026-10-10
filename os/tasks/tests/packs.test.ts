import { describe, expect, it } from "vitest";
import { checkPackDeclaration } from "../src/core/pack";
import { createFakeWorld } from "../src/fakes";
import { FakeSpeaker } from "../src/talk/speech";
import { createTalkPack } from "../src/packs/talk";
import { runPack } from "./helpers";
import * as all from "../src/index";

describe("pack declarations", () => {
  it("every pack declares tools, policies, approvals, verification and honesty", () => {
    const world = createFakeWorld();
    const packs = (world.agent as unknown as { packs: all.TaskPack[] }).packs;
    expect(packs.map((p) => p.id)).toEqual(["talk", "call", "documents", "ordering"]);
    for (const p of packs) {
      expect(checkPackDeclaration(p)).toEqual([]);
      expect(p.honesty.real.length + p.honesty.simulated.length + p.honesty.untested.length).toBeGreaterThan(
        0,
      );
    }
  });
  it("routes goals to packs", () => {
    const packs = (createFakeWorld().agent as unknown as { packs: all.TaskPack[] }).packs;
    const pick = (goal: string) => all.choosePack(packs, { id: "x", goal, origin: "home" })?.id ?? null;
    expect(pick("Call the pharmacy")).toBe("call");
    expect(pick("Order my usual Friday dinner")).toBe("ordering");
    expect(pick("Sign the benefits form")).toBe("documents");
    expect(pick("Fly me to the moon")).toBeNull();
  });
  it("the index exports the public API", () => {
    expect(typeof all.createFakeWorld).toBe("function");
    expect(typeof all.checkOutgoingNumber).toBe("function");
  });
});

describe("talk pack", () => {
  it("says the chosen words and refuses card numbers", async () => {
    const speaker = new FakeSpeaker();
    const pack = createTalkPack({ speaker });
    const ok = await runPack(pack, { goal: "Say", origin: "talk", selections: { text: "Good morning" } });
    expect(ok.last).toMatchObject({ type: "task.done", verified: true });
    expect(speaker.spoken).toEqual([{ text: "Good morning" }]);
    const no = await runPack(pack, {
      goal: "Say",
      origin: "talk",
      selections: { text: "4111 1111 1111 1111" },
    });
    expect(no.last.type).toBe("task.failed");
  });
});
