import { describe, expect, it } from "vitest";
import { NgramModel, currentWord, tokenize } from "../src/keyboard/ngram";

describe("n-gram prediction", () => {
  it("completes prefixes from the seed vocabulary", () => {
    const m = new NgramModel();
    expect(m.predict(null, "wat").map((p) => p.word)).toContain("water");
  });

  it("learns what the person types and uses the previous word", () => {
    const m = new NgramModel();
    m.learn("I need my blanket. I need my blanket now.");
    expect(m.predict("my", "")[0]?.word).toBe("blanket");
    expect(m.predict("my", "bl")[0]?.word).toBe("blanket");
  });

  it("splits the current word", () => {
    expect(currentWord("I need wa")).toEqual({ previous: "need", prefix: "wa" });
    expect(currentWord("hello ")).toEqual({ previous: "hello", prefix: "" });
    expect(tokenize("Don't stop!")).toEqual(["don't", "stop"]);
  });
});
