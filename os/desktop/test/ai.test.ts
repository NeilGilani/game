import { describe, expect, it } from "vitest";
import { aiStatusLabel, applyAiDefaults } from "../src/main/ai";

describe("AI source (main/ai.ts)", () => {
  it("never asks for a key: the agent's status says AI: AGENCY Cloud", () => {
    expect(aiStatusLabel({ model: true, ai: "AI: AGENCY Cloud" })).toBe("AI: AGENCY Cloud");
    expect(aiStatusLabel({ model: true, ai: "AI: Gemini (own key)" })).toBe("AI: Gemini (own key)");
    expect(aiStatusLabel({ model: false })).toBe("AI: off");
    expect(aiStatusLabel({ fake: true })).toBe("AI: fake agent");
    expect(aiStatusLabel(null)).toBe("AI: starting");
  });

  it("keeps automated tests off AGENCY Cloud unless they ask for it", () => {
    const testEnv: NodeJS.ProcessEnv = {};
    applyAiDefaults(testEnv, true);
    expect(testEnv.AGENCY_RELAY).toBe("off");
    const asked: NodeJS.ProcessEnv = { AGENCY_RELAY: "on" };
    applyAiDefaults(asked, true);
    expect(asked.AGENCY_RELAY).toBe("on");
    const app: NodeJS.ProcessEnv = {};
    applyAiDefaults(app, false);
    expect(app.AGENCY_RELAY).toBeUndefined();
  });
});
