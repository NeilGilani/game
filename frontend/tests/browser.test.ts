/** AGENCY Browser's pure parts in the shell: the address box, labels on the page, the lens, gliding scroll. */
import { describe, expect, it } from "vitest";
import { overlaps, type Rect } from "../src/browser/geometry";
import { groupTargets, labelSets, layoutLabels, readingOrder, type LabelTarget } from "../src/browser/labels";
import { decideAt, directTargets, lensAt, spreadHits, zoomCells } from "../src/browser/magnifier";
import { displayUrl, parseOmnibox, searchUrl, suggestions } from "../src/browser/omnibox";
import { glideSpeed } from "../src/browser/glide";

describe("the address box: an address or a search", () => {
  it("opens full addresses as they are", () => {
    expect(parseOmnibox("https://www.bbc.co.uk/news")).toEqual({
      kind: "url",
      url: "https://www.bbc.co.uk/news",
    });
    expect(parseOmnibox("http://example.org")).toEqual({ kind: "url", url: "http://example.org/" });
  });
  it("adds https to things that look like a site, http to this computer", () => {
    expect(parseOmnibox("bbc.co.uk")).toEqual({ kind: "url", url: "https://bbc.co.uk/" });
    expect(parseOmnibox("www.example.org/recipes?q=soup")).toEqual({
      kind: "url",
      url: "https://www.example.org/recipes?q=soup",
    });
    expect(parseOmnibox("example.com:8443")).toEqual({ kind: "url", url: "https://example.com:8443/" });
    expect(parseOmnibox("localhost:5173")).toEqual({ kind: "url", url: "http://localhost:5173/" });
    expect(parseOmnibox("food.localhost:8787/cart")).toEqual({
      kind: "url",
      url: "http://food.localhost:8787/cart",
    });
    expect(parseOmnibox("192.168.1.10")).toEqual({ kind: "url", url: "https://192.168.1.10/" });
  });
  it("searches for everything else, with the chosen engine", () => {
    expect(parseOmnibox("weather tomorrow")).toEqual({
      kind: "search",
      url: "https://www.google.com/search?q=weather%20tomorrow",
      query: "weather tomorrow",
    });
    expect(parseOmnibox("pharmacy near me", "duckduckgo")).toMatchObject({
      kind: "search",
      url: "https://duckduckgo.com/?q=pharmacy%20near%20me",
    });
    expect(parseOmnibox("hello", "bing")).toMatchObject({ url: "https://www.bing.com/search?q=hello" });
    expect(parseOmnibox("e.g. a sentence.")).toMatchObject({ kind: "search" });
    expect(parseOmnibox("3.14")).toMatchObject({ kind: "search" });
    expect(parseOmnibox("   ")).toEqual({ kind: "empty" });
  });
  it("refuses files, scripts, data and AGENCY's own pages, plainly", () => {
    for (const t of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "chrome://settings",
      "agency://shell/",
      "about:blank",
      "mailto:a@b.example",
      "https://user:pw@bank.example/",
    ])
      expect(parseOmnibox(t).kind, t).toBe("blocked");
  });
  it("suggests the address, a search, asking AGENCY, and matching sites and history", () => {
    const out = suggestions("garden", {
      engine: "google",
      favourites: [{ title: "Garden club", url: "https://garden.example/" }],
      history: [
        { title: "How the garden grew", url: "https://news.example/garden" },
        { title: "Garden club", url: "https://garden.example/" },
        { title: "Weather", url: "https://weather.example/" },
      ],
    });
    expect(out.map((s) => s.kind)).toEqual(["search", "ask", "favourite", "history"]);
    expect(out[0]!.value).toBe(searchUrl("garden", "google"));
    expect(out[1]).toMatchObject({ kind: "ask", value: "garden" });
    expect(suggestions("bbc.co.uk", { engine: "google", favourites: [], history: [] })[0]).toMatchObject({
      kind: "open",
      value: "https://bbc.co.uk/",
    });
    expect(suggestions("", { engine: "google", favourites: [], history: [], limit: 3 })).toEqual([]);
    expect(displayUrl("https://www.example.org/a/b")).toBe("example.org/a/b");
  });
});

const T = (
  ref: string,
  x: number,
  y: number,
  w = 80,
  h = 20,
  kind: LabelTarget["kind"] = "link",
  name = ref,
): LabelTarget => ({
  ref,
  name,
  kind,
  rect: { x, y, width: w, height: h },
});

function noOverlaps(rects: Rect[]): boolean {
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) if (overlaps(rects[i]!, rects[j]!)) return false;
  return true;
}

describe("labels on the page", () => {
  const viewport = { width: 1000, height: 600 };

  it("reads top to bottom, then left to right, with a line's items together", () => {
    const order = readingOrder([T("c", 10, 100), T("b", 300, 12), T("a", 10, 10), T("d", 10, 300)]);
    expect(order.map((t) => t.ref)).toEqual(["a", "b", "c", "d"]);
  });

  it("never overlaps labels, or their hit areas, even on a crowded page", () => {
    // A dense grid of small links, like a catalogue.
    const targets: LabelTarget[] = [];
    for (let r = 0; r < 20; r++)
      for (let c = 0; c < 10; c++) targets.push(T(`s${r}-${c}`, 10 + c * 98, 10 + r * 16, 60, 13));
    const sets = labelSets(targets, viewport);
    expect(sets.length).toBeGreaterThan(1);
    for (const set of sets) {
      expect(noOverlaps(set.map((l) => l.hit))).toBe(true);
      for (const l of set) {
        expect(l.chip.width).toBeGreaterThanOrEqual(60);
        expect(l.chip.height).toBeGreaterThanOrEqual(52);
        expect(l.chip.x).toBeGreaterThanOrEqual(0);
        expect(l.chip.y).toBeGreaterThanOrEqual(0);
        expect(l.chip.x + l.chip.width).toBeLessThanOrEqual(viewport.width);
        expect(l.chip.y + l.chip.height).toBeLessThanOrEqual(viewport.height);
      }
    }
    // Numbering runs on across sets, and every target is in exactly one set (up to the limit of sets).
    const codes = sets.flat().map((l) => Number(l.code));
    expect(codes).toEqual(codes.map((_, i) => i + 1));
    expect(new Set(sets.flat().map((l) => l.ref)).size).toBe(sets.flat().length);
  });

  it("keeps a label next to its own element", () => {
    const { placed } = layoutLabels([T("a", 400, 300, 120, 24)], viewport);
    const l = placed[0]!;
    const near =
      Math.abs(l.chip.x + l.chip.width / 2 - 460) < 200 && Math.abs(l.chip.y + l.chip.height / 2 - 312) < 120;
    expect(near).toBe(true);
  });

  it("doesn't hide a small link's words, or its neighbours, when there is room", () => {
    const row = [T("a", 100, 20, 60, 18), T("b", 180, 20, 60, 18), T("c", 260, 20, 60, 18)];
    const { placed } = layoutLabels(row, viewport);
    for (const l of placed) for (const t of row) expect(overlaps(l.chip, t.rect)).toBe(false);
  });

  it("puts a big card's label on its corner", () => {
    const { placed } = layoutLabels([T("card", 100, 100, 300, 200, "button")], viewport);
    expect(placed[0]!.chip.x).toBe(104);
    expect(placed[0]!.chip.y).toBe(104);
  });

  it("groups the side list by kind and merges repeated names", () => {
    const groups = groupTargets([
      T("r1", 10, 100, 60, 18, "link", "Read more"),
      T("r2", 10, 200, 60, 18, "link", "Read more"),
      T("home", 10, 10, 60, 18, "link", "Home"),
      T("go", 300, 10, 60, 30, "button", "Search"),
      T("q", 100, 10, 160, 30, "field", ""),
    ]);
    expect(groups.map((g) => g.title)).toEqual(["Boxes to type in", "Buttons", "Links"]);
    expect(groups[0]!.entries[0]!.name).toBe("Text box");
    expect(groups[2]!.entries).toEqual([
      { name: "Home", refs: ["home"] },
      { name: "Read more", refs: ["r1", "r2"] },
    ]);
  });
});

describe("zoom to choose and the lens", () => {
  const viewport = { width: 1000, height: 600 };
  const big = { ref: "big", name: "Big button", rect: { x: 100, y: 100, width: 200, height: 100 } };
  const tiny = Array.from({ length: 12 }, (_, i) => ({
    ref: `t${i}`,
    name: `Shelf ${i}`,
    rect: { x: 600 + (i % 4) * 40, y: 300 + Math.floor(i / 4) * 14, width: 34, height: 11 },
  }));
  const all = [big, ...tiny];

  it("chooses a big, clear button directly", () => {
    expect(decideAt({ x: 200, y: 150 }, all, viewport)).toEqual({ kind: "direct", target: big });
    expect(directTargets(all).map((t) => t.ref)).toEqual(["big"]);
  });

  it("opens a lens over crowded small links, magnified enough to choose", () => {
    const d = decideAt({ x: 660, y: 315 }, all, viewport);
    expect(d.kind).toBe("lens");
    if (d.kind !== "lens") return;
    const { lens } = d;
    expect(lens.zoom).toBeGreaterThanOrEqual(2);
    expect(lens.zoom).toBeLessThanOrEqual(4);
    // Everything offered is inside the lens, and its hit area is bigger than the link and overlaps no other.
    expect(lens.items.length).toBeGreaterThanOrEqual(8);
    for (const it of lens.items) {
      expect(it.rect.x).toBeGreaterThanOrEqual(lens.box.x - 0.01);
      expect(it.rect.y + it.rect.height).toBeLessThanOrEqual(lens.box.y + lens.box.height + 0.01);
      expect(it.hit.width).toBeGreaterThanOrEqual(it.rect.width);
    }
    expect(noOverlaps(lens.items.map((i) => i.hit))).toBe(true);
    // The magnified part of the page is centred on the links, inside the page.
    expect(lens.source.x).toBeGreaterThanOrEqual(0);
    expect(lens.source.x + lens.source.width).toBeLessThanOrEqual(viewport.width);
  });

  it("grows hit areas only into free space", () => {
    const box = { x: 0, y: 0, width: 400, height: 400 };
    const items = [
      {
        ref: "a",
        name: "a",
        rect: { x: 100, y: 100, width: 20, height: 20 },
        hit: { x: 100, y: 100, width: 20, height: 20 },
      },
      {
        ref: "b",
        name: "b",
        rect: { x: 125, y: 100, width: 20, height: 20 },
        hit: { x: 125, y: 100, width: 20, height: 20 },
      },
      {
        ref: "c",
        name: "c",
        rect: { x: 300, y: 300, width: 20, height: 20 },
        hit: { x: 300, y: 300, width: 20, height: 20 },
      },
    ];
    const out = spreadHits(items, box, 64);
    expect(noOverlaps(out.map((i) => i.hit))).toBe(true);
    expect(out[2]!.hit.width).toBeGreaterThanOrEqual(60);
  });

  it("covers the page with places to look", () => {
    const cells = zoomCells(viewport, 150);
    const area = cells.reduce((n, c) => n + c.width * c.height, 0);
    expect(Math.round(area)).toBe(viewport.width * viewport.height);
    expect(noOverlaps(cells)).toBe(true);
  });

  it("an empty spot still opens a lens (nothing to choose there is said plainly)", () => {
    const lens = lensAt({ x: 900, y: 550 }, all, viewport);
    expect(lens.items).toEqual([]);
  });
});

describe("gliding scroll", () => {
  it("starts slow and speeds up the longer the eyes stay, to a limit", () => {
    expect(glideSpeed(0)).toBe(240);
    expect(glideSpeed(1500)).toBeGreaterThan(240);
    expect(glideSpeed(1500)).toBeLessThan(glideSpeed(3000));
    expect(glideSpeed(3000)).toBe(1400);
    expect(glideSpeed(60_000)).toBe(1400);
  });
});
