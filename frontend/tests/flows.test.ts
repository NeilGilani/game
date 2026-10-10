import { describe, expect, it } from "vitest";
import {
  MAX_OPTIONS,
  TYPE_ID,
  USUAL_ID,
  back,
  choose,
  optionsOf,
  pageOf,
  promptOf,
  screenOf,
  startFlow,
  submitText,
  validateFlow,
  type FlowState,
} from "../src/flows/engine";
import { FLOWS, VALIDATION_SAMPLES } from "../src/flows/library";
import type { FlowDef, FlowOption } from "../src/flows/types";
import type { Suggestion } from "../src/state/contracts";

const usual: Suggestion = {
  nodeId: "n1",
  path: ["food", "delivery", "Thai Basil", "Pad thai (mild)"],
  label: "Pad thai from Thai Basil",
  score: 0.9,
  reason: "You chose this 4 of the last 5 Fridays.",
  task: {
    goal: "Order pad thai (mild) from Thai Basil",
    selections: { kind: "food", restaurant: "Thai Basil" },
  },
};

const flow = (id: string): FlowDef => FLOWS[id]!;

describe("every flow is well formed", () => {
  it.each(Object.keys(FLOWS))(
    "%s: 2 to 6 options per screen, every path ends, every screen is reachable",
    (id) => {
      expect(validateFlow(flow(id), VALIDATION_SAMPLES)).toEqual([]);
    },
  );

  it("covers every flow Home needs", () => {
    expect(Object.keys(FLOWS).sort()).toEqual(
      ["apps", "browse", "call", "food", "messages", "papers", "shopping", "watch"].sort(),
    );
  });

  it("every path of every flow ends in a task, an app or a screen, within 5 choices", () => {
    for (const f of Object.values(FLOWS)) {
      const ends: string[] = [];
      const walk = (state: FlowState, depth: number) => {
        expect(depth).toBeLessThanOrEqual(5);
        for (const o of optionsOf(f, state)) {
          const next =
            o.id === TYPE_ID ? submitText(f, choose(f, state, o.id), "hello") : choose(f, state, o.id);
          expect(next).not.toBe(state);
          if (next.outcome) ends.push(next.outcome.type);
          else walk(next, depth + 1);
        }
      };
      walk(startFlow(f), 1);
      expect(ends.length).toBeGreaterThan(0);
    }
  });
});

describe("validation catches mistakes", () => {
  const base: FlowDef = {
    id: "t",
    title: "T",
    icon: "x",
    surface: "home",
    start: "a",
    screens: {
      a: {
        id: "a",
        prompt: "A?",
        options: [
          { id: "1", label: "One", next: "b" },
          { id: "2", label: "Two", end: { type: "route", path: "/" } },
        ],
      },
      b: { id: "b", prompt: "B?", options: [{ id: "x", label: "X", end: { type: "route", path: "/" } }] },
      lost: {
        id: "lost",
        prompt: "?",
        options: [
          { id: "y", label: "Y", next: "nowhere" },
          { id: "z", label: "Z", next: "a", end: { type: "route", path: "/" } },
        ],
      },
    },
  };

  it("reports too few options, missing screens, ambiguous options and unreachable screens", () => {
    const problems = validateFlow(base);
    expect(problems).toContain("t/b: 1 options (needs 2 to 6)");
    expect(problems).toContain("t/lost/y: next screen nowhere is missing");
    expect(problems).toContain("t/lost/z: needs exactly one of next or end");
    expect(problems).toContain("t/lost: no option leads here");
  });

  it("reports too many options", () => {
    const seven: FlowOption[] = Array.from({ length: 7 }, (_, i) => ({
      id: `o${i}`,
      label: `Option ${i}`,
      end: { type: "route", path: "/" },
    }));
    expect(validateFlow({ ...base, screens: { a: { id: "a", prompt: "?", options: seven } } })).toContain(
      `t/a: 7 options (needs 2 to ${MAX_OPTIONS})`,
    );
  });
});

describe("walking a flow", () => {
  it("food: three choices make a task request for the agent", () => {
    const f = flow("food");
    let s = startFlow(f);
    expect(promptOf(screenOf(f, s), s.selections)).toBe("What would you like to eat?");
    s = choose(f, s, "thai");
    expect(promptOf(screenOf(f, s), s.selections)).toBe("What from Thai Basil?");
    expect(optionsOf(f, s).map((o) => o.label)).toEqual(["Pad thai", "Green curry", "Tom yum soup"]);
    s = choose(f, s, "d0");
    s = choose(f, s, "asap");
    expect(s.outcome).toEqual({
      type: "task",
      goal: "Order Pad thai from Thai Basil, as soon as possible",
      selections: {
        restaurant: "Thai Basil",
        dish: "Pad thai",
        price: "$24.80",
        when: "As soon as possible",
        kind: "food",
      },
    });
    expect(s.path).toEqual(["Thai", "Pad thai", "As soon as possible"]);
  });

  it("offers memory's usual first, with its reason, on the first screen only", () => {
    const f = flow("food");
    const s = startFlow(f);
    const first = optionsOf(f, s, usual)[0]!;
    expect(first.id).toBe(USUAL_ID);
    expect(first.label).toBe("Your usual: Pad thai from Thai Basil");
    expect(first.sub).toBe("You chose this 4 of the last 5 Fridays.");
    const done = choose(f, s, USUAL_ID, usual);
    expect(done.outcome).toEqual({
      type: "task",
      goal: "Order pad thai (mild) from Thai Basil",
      selections: { kind: "food", restaurant: "Thai Basil" },
      usual: true,
    });
    const later = choose(f, s, "thai", usual);
    expect(optionsOf(f, later, usual).some((o) => o.id === USUAL_ID)).toBe(false);
  });

  it("a suggestion without a task isn't offered as the usual", () => {
    const f = flow("food");
    const noTask: Suggestion = { ...usual };
    delete noTask.task;
    expect(optionsOf(f, startFlow(f), noTask).some((o) => o.id === USUAL_ID)).toBe(false);
  });

  it("back returns to the previous screen and forgets what was chosen there", () => {
    const f = flow("food");
    const s = choose(f, choose(f, startFlow(f), "pizza"), "d1");
    expect(s.screenId).toBe("when");
    const b = back(s);
    expect(b.screenId).toBe("dish");
    expect(b.selections).toEqual({ restaurant: "Slice House" });
    const bb = back(b);
    expect(bb.screenId).toBe("kind");
    expect(bb.selections).toEqual({});
    expect(back(bb)).toBe(bb);
  });

  it("typing is a separate step, and blank text is ignored", () => {
    const f = flow("messages");
    let s = choose(f, startFlow(f), "jordan");
    expect(optionsOf(f, s).at(-1)!.id).toBe(TYPE_ID);
    s = choose(f, s, TYPE_ID);
    expect(s.typing).toBe(true);
    expect(submitText(f, s, "   ")).toBe(s);
    expect(back(s).typing).toBe(false);
    const done = submitText(f, s, "  See you at 6  ");
    expect(done.outcome).toMatchObject({
      type: "task",
      goal: 'Send Jordan a message: "See you at 6"',
      selections: { kind: "message", person: "Jordan", text: "See you at 6" },
    });
  });

  it("task packs carry the pack name", () => {
    const f = flow("papers");
    const s = choose(f, choose(f, startFlow(f), "sign"), "lease");
    expect(s.outcome).toMatchObject({ type: "task", pack: "documents", goal: "Sign the lease renewal" });
    expect(s.outcome?.type === "task" && s.outcome.selections.pack).toBe("documents");
  });

  it("apps and watch can launch a Mac app or open another screen", () => {
    expect(choose(flow("apps"), startFlow(flow("apps")), "mail").outcome).toEqual({
      type: "launch",
      bundleId: "com.apple.mail",
      name: "Mail",
    });
    expect(choose(flow("apps"), startFlow(flow("apps")), "all").outcome).toEqual({
      type: "route",
      path: "/apps?view=all",
    });
  });

  it("shopping ends on comparison cards with facts", () => {
    const f = flow("shopping");
    const s = choose(f, choose(f, startFlow(f), "medical"), "p0");
    expect(screenOf(f, s).layout).toBe("compare");
    const cards = optionsOf(f, s);
    expect(cards.map((c) => c.label)).toEqual(["CareSupply", "MedDirect"]);
    expect(cards[0]!.facts).toEqual([
      { label: "Price", value: "$24.00" },
      { label: "Arrives", value: "Tomorrow" },
      { label: "Rating", value: "4.9 of 5" },
    ]);
    expect(choose(f, s, "o1").outcome).toMatchObject({
      goal: "Buy Suction catheters from MedDirect for $21.50",
    });
  });

  it("unknown options and choices after the end change nothing", () => {
    const f = flow("food");
    const s = startFlow(f);
    expect(choose(f, s, "nope")).toBe(s);
    const ended = choose(f, choose(f, choose(f, s, "thai"), "d0"), "asap");
    expect(choose(f, ended, "asap")).toBe(ended);
  });
});

describe("paging", () => {
  const opts = Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, label: `${i}` }));
  it("splits into fixed pages and clamps", () => {
    expect(pageOf(opts, 0).items.map((o) => o.id)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(pageOf(opts, 1)).toMatchObject({ page: 1, pages: 2 });
    expect(pageOf(opts, 1).items.map((o) => o.id)).toEqual(["6", "7"]);
    expect(pageOf(opts, 9).page).toBe(1);
    expect(pageOf([], 0)).toEqual({ items: [], page: 0, pages: 1 });
  });
});
