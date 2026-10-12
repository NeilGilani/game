/** The page preload's pure parts: reader blocks and pop-up choices. (The DOM parts are covered end to end.) */

import { describe, expect, it } from "vitest";
import {
  article,
  blocksFromLines,
  clean,
  MAX_BLOCKS,
  readingMinutes,
  tidyBlocks,
} from "../src/browser-page/blocks";
import { labelOf, orderChoices, popupKind, toneOf } from "../src/browser-page/popupRules";

describe("reader blocks", () => {
  it("cleans text: no soft hyphens, zero-width characters or runs of spaces", () => {
    expect(clean("  com­muni​ty   garden \n")).toBe("community garden");
  });

  it("drops empty and repeated blocks, keeps order, bounds headings", () => {
    const out = tidyBlocks([
      { type: "heading", level: 9, text: "Title" },
      { type: "paragraph", text: "  " },
      { type: "paragraph", text: "One." },
      { type: "paragraph", text: "One." },
      { type: "image", alt: " A garden " },
      { type: "image", alt: "" },
      { type: "item", text: "Beans", ordered: 1 },
    ]);
    expect(out).toEqual([
      { type: "heading", level: 6, text: "Title" },
      { type: "paragraph", text: "One." },
      { type: "image", alt: "A garden" },
      { type: "item", text: "Beans", ordered: 1 },
    ]);
  });

  it("never lets a huge page flood the shell", () => {
    const many = Array.from({ length: MAX_BLOCKS + 500 }, (_, i) => ({
      type: "paragraph" as const,
      text: `Line ${i}`,
    }));
    expect(tidyBlocks(many)).toHaveLength(MAX_BLOCKS);
  });

  it("estimates reading time at about 200 words a minute", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    expect(readingMinutes([{ type: "paragraph", text: words(10) }])).toBe(1);
    expect(readingMinutes([{ type: "paragraph", text: words(1000) }])).toBe(5);
  });

  it("builds an article without repeating its title, and marks plain page text", () => {
    const a = article(
      "How the garden grew",
      [
        { type: "heading", level: 1, text: "How the garden grew" },
        { type: "paragraph", text: "It started." },
      ],
      {
        byline: "Ruth",
        site: "news.example",
        plainText: false,
      },
    );
    expect(a).toMatchObject({
      title: "How the garden grew",
      byline: "Ruth",
      site: "news.example",
      plainText: false,
      minutes: 1,
    });
    expect(a.blocks).toEqual([{ type: "paragraph", text: "It started." }]);
    expect(article("", [], { plainText: true }).title).toBe("Untitled page");
    expect(blocksFromLines("One\n\n Two \n")).toEqual([
      { type: "paragraph", text: "One" },
      { type: "paragraph", text: "Two" },
    ]);
  });
});

describe("pop-up choices", () => {
  it("knows rejecting, closing and accepting", () => {
    expect(toneOf("Reject all")).toBe("decline");
    expect(toneOf("Only necessary cookies")).toBe("decline");
    expect(toneOf("Do not sell my data")).toBe("decline");
    expect(toneOf("No thanks")).toBe("close");
    expect(toneOf("×")).toBe("close");
    expect(toneOf("Accept all")).toBe("accept");
    expect(toneOf("I agree")).toBe("accept");
    expect(toneOf("Manage options")).toBe("other");
  });

  it("offers the least sharing first, names symbol buttons, no repeats, at most six", () => {
    const out = orderChoices([
      { ref: "a", name: "Accept all" },
      { ref: "b", name: "Cookie settings" },
      { ref: "c", name: "Reject all" },
      { ref: "d", name: "✕" },
      { ref: "e", name: "Reject all" },
      { ref: "f", name: "More 1" },
      { ref: "g", name: "More 2" },
      { ref: "h", name: "More 3" },
    ]);
    expect(out.map((c) => c.label)).toEqual([
      "Reject all",
      "Close",
      "Cookie settings",
      "More 1",
      "More 2",
      "More 3",
    ]);
    expect(labelOf("  ")).toBe("Close");
  });

  it("tells a cookie banner from other pop-ups", () => {
    expect(popupKind("We use cookies to improve your experience", false)).toBe("cookies");
    expect(popupKind("Sign up for our newsletter", true)).toBe("dialog");
    expect(popupKind("Sign up for our newsletter", false)).toBe("overlay");
  });
});
