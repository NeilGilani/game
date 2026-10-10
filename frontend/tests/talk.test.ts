import { describe, expect, it } from "vitest";
import { backspace, deleteWord, GROUPS, LETTERS, typeChar } from "../src/talk/keyboard";
import { withSaved, MAX_SAVED } from "../src/talk/phrases";
import { applySuggestion, Predictor, splitDraft, tokenize } from "../src/talk/predict";

describe("word prediction", () => {
  it("completes a prefix with common words first", () => {
    const p = new Predictor();
    const s = p.suggest("th", "of", 4);
    expect(s.length).toBe(4);
    expect(s[0]).toBe("the");
    // At the start of a message, openers come first.
    expect(p.suggest("th", null)[0]).toBe("thank");
    expect(s.every((w) => w.startsWith("th"))).toBe(true);
  });

  it("never suggests the exact word already typed", () => {
    expect(new Predictor().suggest("the", null)).not.toContain("the");
  });

  it("learns the person's own words and ranks them up", () => {
    const p = new Predictor();
    expect(p.suggest("bi", null)).not.toContain("bipap");
    p.learn("Please check my BiPAP");
    p.learn("the bipap is leaking");
    expect(p.suggest("bi", null)[0]).toBe("bipap");
  });

  it("uses the previous word to suggest what usually follows", () => {
    const p = new Predictor();
    for (let i = 0; i < 3; i++) p.learn("call jordan");
    expect(p.suggest("", "call")[0]).toBe("jordan");
    expect(p.suggest("j", "call")[0]).toBe("jordan");
  });

  it("suggests sensible next words before anything is learned", () => {
    const p = new Predictor();
    expect(p.suggest("", null).slice(0, 2)).toEqual(["i", "please"]);
    expect(p.suggest("", "my")).toContain("mask");
    expect(p.suggest("", "i")[0]).toBe("need");
    expect(p.suggest("t", "i'm")[0]).toBe("tired");
  });

  it("lets the person's own habits outrank the built-in pairs", () => {
    const p = new Predictor();
    for (let i = 0; i < 4; i++) p.learn("my bipap");
    expect(p.suggest("", "my")[0]).toBe("bipap");
  });

  it("can forget a word", () => {
    const p = new Predictor();
    p.learn("teh teh teh");
    expect(p.suggest("te", null)).toContain("teh");
    p.forget("teh");
    expect(p.suggest("te", null)).not.toContain("teh");
  });

  it("round-trips through a snapshot", () => {
    const p = new Predictor();
    p.learn("suction please");
    const q = new Predictor(JSON.parse(JSON.stringify(p.snapshot())));
    expect(q.suggest("su", null)[0]).toBe("suction");
  });

  it("tokenizes keeping apostrophes", () => {
    expect(tokenize("I can't, OK? Don't!")).toEqual(["i", "can't", "ok", "don't"]);
  });

  it("splits a draft into previous word and prefix", () => {
    expect(splitDraft("I need wa")).toEqual({ previous: "need", prefix: "wa" });
    expect(splitDraft("I need ")).toEqual({ previous: "need", prefix: "" });
    expect(splitDraft("")).toEqual({ previous: null, prefix: "" });
  });

  it("applies a suggestion with spacing and capitals", () => {
    expect(applySuggestion("I need wa", "water")).toBe("I need water ");
    expect(applySuggestion("", "please")).toBe("Please ");
    expect(applySuggestion("Hi. ", "i'm")).toBe("Hi. I'm ");
    expect(applySuggestion("yes,", "please")).toBe("yes, please ");
    expect(applySuggestion("so i", "i")).toBe("so I ");
  });
});

describe("eye-typing keyboard", () => {
  it("covers every letter exactly once in both layouts", () => {
    const grouped = GROUPS.flat()
      .filter((c) => /[a-z]/.test(c))
      .sort();
    expect(grouped.join("")).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(LETTERS.filter((c) => /[a-z]/.test(c)).join("")).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  it("capitalises sentence starts and a lone I", () => {
    let t = "";
    for (const c of "hi") t = typeChar(t, c);
    t = typeChar(t, ".");
    t = typeChar(t, "i");
    expect(t).toBe("Hi. I");
  });

  it("tucks punctuation against the word", () => {
    expect(typeChar("Yes ", ",")).toBe("Yes, ");
    expect(typeChar("Really ", "?")).toBe("Really? ");
    expect(typeChar("don", "'")).toBe("don'");
  });

  it("deletes characters and words", () => {
    expect(backspace("abc")).toBe("ab");
    expect(backspace("Yes, ")).toBe("Yes");
    expect(deleteWord("I need water ")).toBe("I need ");
    expect(deleteWord("I need wat")).toBe("I need ");
    expect(deleteWord("Hello")).toBe("");
  });
});

describe("saved phrases", () => {
  it("adds to the front without duplicates and caps the list", () => {
    let list = withSaved([], "Check my mask");
    list = withSaved(list, "Hello");
    list = withSaved(list, "check my mask");
    expect(list).toEqual(["check my mask", "Hello"]);
    for (let i = 0; i < 60; i++) list = withSaved(list, `p${i}`);
    expect(list.length).toBe(MAX_SAVED);
    expect(withSaved(list, "   ")).toBe(list);
  });
});

describe("pain reports", () => {
  it("builds clear sentences with the 0 to 10 scale", async () => {
    const { painSentence, SEVERITY } = await import("../src/talk/pain");
    expect(painSentence("pain", "back", SEVERITY[2])).toBe("My back hurts. It's bad, 6 out of 10.");
    expect(painSentence("pain", "eyes", SEVERITY[0])).toBe("My eyes hurt. It's a little, 2 out of 10.");
    expect(painSentence("itch", "left leg or foot")).toBe("My left leg or foot itches. Please scratch it.");
    expect(painSentence("itch", "shoulders")).toBe("My shoulders itch. Please scratch them.");
    expect(painSentence("cramp", "neck", SEVERITY[4])).toBe(
      "I have a cramp in my neck. It's the worst, 10 out of 10.",
    );
    expect(painSentence("numb", "right arm or hand")).toBe("My right arm or hand feels numb and tingly.");
  });
});
