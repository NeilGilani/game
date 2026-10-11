import { describe, expect, it } from "vitest";
import { LIKELY, caseFocus, contextFor, likely, nextInForm, taskFocus } from "../src/input/context";

describe("context priors for eye control", () => {
  it("is neutral by default", () => {
    expect(contextFor({ label: "Thai" })).toEqual({
      prior: 1,
      consequential: false,
      gate: false,
      protect: false,
    });
  });

  it("reads strong and weak likelihood", () => {
    expect(contextFor({ label: "Yes", likely: "strong" }).prior).toBe(LIKELY.strong);
    expect(contextFor({ label: "Your usual: Pad thai", likely: "weak" }).prior).toBe(LIKELY.weak);
    expect(contextFor({ label: "water", likely: "" }).prior).toBe(LIKELY.weak);
    expect(contextFor({ label: "x", likely: "2" }).prior).toBe(2);
    expect(contextFor({ label: "x", likely: "nonsense" }).prior).toBe(1);
    expect(contextFor({ label: "Name", formNext: true }).prior).toBe(LIKELY.strong);
  });

  it("marks anything that pays, sends, shares, signs or calls as consequential", () => {
    for (const label of [
      "Pay $12.50",
      "Order Pad thai",
      "Send message",
      "Share my location",
      "Sign",
      "Call Mom",
      "Delete note",
      "Approve",
    ]) {
      expect(contextFor({ label }).consequential).toBe(true);
    }
    for (const label of ["Thai", "Back", "Home", "Carry on", "Helper settings", "Sending times"]) {
      expect(contextFor({ label }).consequential).toBe(false);
    }
    expect(contextFor({ label: "Read and sign", consequential: true }).consequential).toBe(true);
  });

  it("never boosts an approval gate, even when marked likely", () => {
    const c = contextFor({ label: "Yes, pay", likely: "strong", gate: true });
    expect(c.prior).toBe(1);
    expect(c.gate).toBe(true);
    expect(c.consequential).toBe(true);
  });

  it("protects Stop and Help", () => {
    expect(contextFor({ label: "Stop this task" }).protect).toBe(true);
    expect(contextFor({ label: "Help" }).protect).toBe(true);
    expect(contextFor({ label: "Lifeline" }).protect).toBe(true);
    expect(contextFor({ label: "Resume eye control", protect: true }).protect).toBe(true);
    expect(contextFor({ label: "Helper settings" }).protect).toBe(false);
  });

  it("spreads data-likely only when there is a level", () => {
    expect(likely("strong")).toEqual({ "data-likely": "strong" });
    expect(likely(false)).toEqual({});
    expect(likely(null)).toEqual({});
  });
});

describe("planner state -> what is likely", () => {
  it("agent task: answer a question, resume, leave a result; nothing during an approval", () => {
    const q = { id: "q", prompt: "Which?", options: [] } as never;
    expect(taskFocus({ phase: "question", question: q })).toBe("answer");
    expect(taskFocus({ phase: "question", question: null })).toBeNull();
    expect(taskFocus({ phase: "paused", question: null })).toBe("resume");
    expect(taskFocus({ phase: "done", question: null })).toBe("finish");
    expect(taskFocus({ phase: "stopped", question: null })).toBe("finish");
    expect(taskFocus({ phase: "approval", question: null })).toBeNull();
    expect(taskFocus({ phase: "working", question: null })).toBeNull();
  });

  it("coordinator case: from backend/agency/engine next_actions", () => {
    expect(caseFocus([{ kind: "next" }])).toBeNull();
    expect(caseFocus([{ kind: "question" }, { kind: "next" }])).toBe("answer");
    expect(caseFocus([{ kind: "approval" }])).toBe("review");
    // Paused comes first in next_actions and wins.
    expect(caseFocus([{ kind: "paused" }, { kind: "question" }])).toBe("resume");
  });
});

describe("forms: the next field is likely", () => {
  const f = (id: string, empty: boolean, required = false) => ({
    id,
    kind: "field" as const,
    empty,
    required,
  });
  const submit = { id: "go", kind: "submit" as const, empty: false, required: false };

  it("picks the first empty field", () => {
    expect(nextInForm([f("name", false, true), f("street", true, true), f("city", true, true), submit])).toBe(
      "street",
    );
  });

  it("picks submit once every required field is filled", () => {
    expect(nextInForm([f("name", false, true), f("note", true), submit])).toBe("go");
  });

  it("doesn't pick submit for an untouched form", () => {
    expect(nextInForm([f("note", true), submit])).toBe("note");
    expect(nextInForm([submit])).toBeNull();
  });
});
