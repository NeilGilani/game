import { afterEach, describe, expect, it, vi } from "vitest";
import { logSelection, memoryApi } from "../src/memory/api";
import { FakeMemoryApi } from "../src/memory/fake";
import {
  childrenOf,
  detailsText,
  leafCount,
  pageOf,
  relativeDay,
  usualHeadline,
  usualTitle,
} from "../src/memory/model";
import type { Suggestion, TreeNode } from "../src/memory/types";

const FRIDAY_7PM = new Date(2026, 9, 9, 19, 0);

function node(id: string, label: string, parentId: string | null, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    kind: parentId ? "choice" : "area",
    label,
    parentId,
    attributes: {},
    pinned: false,
    hidden: false,
    sensitive: false,
    createdAt: "",
    updatedAt: "",
    effectiveHidden: false,
    effectiveSensitive: false,
    ...extra,
  };
}

const usual: Suggestion = {
  nodeId: "n4",
  path: ["food", "delivery", "Thai Basil", "Pad thai"],
  label: "Pad thai",
  score: 0.8,
  reason: "You chose this 4 of your last 5 Friday evenings.",
  task: {
    goal: "food › delivery › Thai Basil › Pad thai",
    selections: { restaurant: "Thai Basil", spice: "mild", choice: "Pad thai" },
  },
};

describe("memory view model", () => {
  it("builds the usual card text from the path and details", () => {
    expect(usualHeadline(usual)).toBe("Thai Basil, Pad thai, mild");
    expect(usualTitle(usual, FRIDAY_7PM)).toBe("Usual Friday dinner");
    const monday = new Date(2026, 9, 12, 8, 0);
    expect(usualTitle({ ...usual, reason: "You chose this 4 of the last 5 times." }, monday)).toBe(
      "Usual breakfast",
    );
    expect(
      usualTitle(
        { ...usual, path: ["call", "Jordan"], reason: "You chose this 3 of your last 4 Sunday mornings." },
        new Date(2026, 9, 11, 10),
      ),
    ).toBe("Usual Sunday morning call");
  });

  it("orders children: kept first, hidden last, then by name", () => {
    const tree = [
      node("a", "food", null),
      node("b", "zucchini", "a"),
      node("c", "apple", "a", { hidden: true }),
      node("d", "mango", "a", { pinned: true }),
      node("e", "banana", "a"),
    ];
    expect(childrenOf(tree, "a").map((n) => n.label)).toEqual(["mango", "banana", "zucchini", "apple"]);
    expect(childrenOf(tree, null).map((n) => n.label)).toEqual(["food"]);
    expect(leafCount(tree, "a")).toBe(4);
  });

  it("pages instead of scrolling", () => {
    const items = Array.from({ length: 14 }, (_, i) => i);
    expect(pageOf(items, 0, 6)).toEqual({ items: [0, 1, 2, 3, 4, 5], page: 0, pages: 3 });
    expect(pageOf(items, 2, 6).items).toEqual([12, 13]);
    expect(pageOf(items, 9, 6).page).toBe(2);
    expect(pageOf([], 0, 6)).toEqual({ items: [], page: 0, pages: 1 });
  });

  it("shows details without bookkeeping or repeats", () => {
    expect(
      detailsText({ type: "restaurant", spice: "mild", sensitive: "true", size: "large" }, "Pad thai (mild)"),
    ).toBe("large");
    expect(detailsText({ spice: "hot" }, "Pad thai")).toBe("hot");
  });

  it("says when in plain words", () => {
    expect(relativeDay(null, FRIDAY_7PM)).toBe("never");
    expect(relativeDay(new Date(2026, 9, 9, 8).toISOString(), FRIDAY_7PM)).toBe("today");
    expect(relativeDay(new Date(2026, 9, 8, 22).toISOString(), FRIDAY_7PM)).toBe("yesterday");
    expect(relativeDay(new Date(2026, 9, 5, 12).toISOString(), FRIDAY_7PM)).toBe("on Monday");
    expect(relativeDay(new Date(2026, 2, 3, 12).toISOString(), FRIDAY_7PM)).toBe("on 3 March");
  });
});

describe("FakeMemoryApi (for other instances' tests)", () => {
  const dinner = {
    path: ["food", "delivery", "Thai Basil", "Pad thai"],
    surface: "food" as const,
    outcome: "chosen" as const,
  };

  it("learns, explains by counting, and offers a usual after four of five", async () => {
    const api = new FakeMemoryApi(() => FRIDAY_7PM);
    await api.seed([dinner, dinner, dinner]);
    expect(await api.usual(["food", "delivery"])).toBeNull();
    await api.seed([dinner]);
    const u = await api.usual(["food", "delivery"]);
    expect(u?.label).toBe("Pad thai");
    expect(u?.reason).toBe("You chose this 4 of the last 4 times.");
    const s = await api.suggestions("food");
    expect(s[0]?.reason).toBe("You chose this 4 times.");
  });

  it("drops secrets, honours hide, pin, private mode and forget", async () => {
    const api = new FakeMemoryApi(() => FRIDAY_7PM);
    const r = await api.record({ ...dinner, attributes: { password: "x", spice: "mild" } });
    expect(r.dropped).toEqual(["password"]);
    await api.record({ path: ["call", "Pharmacy"], surface: "call", outcome: "chosen" });
    await api.record({ path: ["call", "Jordan"], surface: "call", outcome: "chosen" });
    const tree = await api.tree();
    const pharmacy = tree.find((n) => n.label === "Pharmacy")!;
    expect(pharmacy.sensitive).toBe(true);
    await api.saveSettings({ ...(await api.settings()), privateMode: true });
    expect((await api.suggestions("call")).map((s) => s.label)).toEqual(["Jordan"]);
    expect((await api.tree()).find((n) => n.id === pharmacy.id)?.label).toBe("Private");
    const jordan = tree.find((n) => n.label === "Jordan")!;
    await api.patch(jordan.id, { hidden: true });
    expect(await api.suggestions("call")).toEqual([]);
    const food = tree.find((n) => n.label === "food")!;
    expect((await api.forget(food.id)).forgotten).toBe(4);
    expect((await api.tree()).some((n) => n.label === "Pad thai")).toBe(false);
    await api.forgetAll();
    expect(await api.tree()).toEqual([]);
  });

  it("summaries need opt-in and the exact previewed facts", async () => {
    const api = new FakeMemoryApi(() => FRIDAY_7PM);
    await api.seed([dinner, dinner]);
    const preview = await api.summaryPreview();
    expect(preview.facts).toEqual(["food > delivery > Thai Basil > Pad thai: chosen 2 times"]);
    await expect(api.summarize(preview.factsHash)).rejects.toThrow(/off/);
    await api.saveSettings({ ...(await api.settings()), summariesEnabled: true });
    await expect(api.summarize("0".repeat(64))).rejects.toThrow(/changed/);
    expect((await api.summarize(preview.factsHash)).notes).toHaveLength(1);
  });
});

describe("memory HTTP client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls the contract endpoints", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method ?? "GET", body: init.body as string | undefined });
        return new Response(JSON.stringify(url.includes("/events") ? { stored: true } : []), { status: 200 });
      }),
    );
    await memoryApi.suggestions("food", 6);
    await memoryApi.usual(["food", "a/b"]);
    await memoryApi.patch("n1", { pinned: true });
    await memoryApi.forget("n1");
    await memoryApi.forgetAll();
    expect(await logSelection({ path: ["talk", "Hi"], surface: "talk", outcome: "chosen" })).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/memory/suggestions?surface=food&limit=6",
      "GET /api/memory/usual?p=food&p=a%2Fb",
      "PATCH /api/memory/nodes/n1",
      "DELETE /api/memory/nodes/n1",
      "POST /api/memory/forget-all",
      "POST /api/memory/events",
    ]);
    expect(JSON.parse(calls[4]!.body!)).toEqual({ confirm: true });
  });

  it("logSelection never throws when the coordinator is away", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    expect(await logSelection({ path: ["talk", "Hi"], surface: "talk", outcome: "chosen" })).toBe(false);
  });
});
