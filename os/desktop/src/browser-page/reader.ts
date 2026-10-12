/**
 * Reader view: Mozilla Readability finds the article on a copy of the page; AGENCY keeps only its text, as plain
 * blocks (headings, paragraphs, quotes, list items, picture descriptions). Pages that aren't articles fall back to
 * their visible text.
 */

import type { ReaderArticle, ReaderBlock } from "@agency/contracts";
import { visibleText } from "../../../browser-bridge/src/extension/page/dom.ts";
import { article, blocksFromLines, clean } from "./blocks";
import { Readability } from "./vendor/Readability.js";

const CONTAINERS = /^(DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|SPAN|FIGURE|TBODY|THEAD|TABLE|DETAILS|BODY)$/;

/** Walks Readability's result and turns it into text blocks. Nothing but text is kept. */
export function toBlocks(root: Node): ReaderBlock[] {
  const out: ReaderBlock[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = clean(node.textContent ?? "");
      if (t.length > 1) out.push({ type: "paragraph", text: t });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (/^H[1-6]$/.test(tag)) {
      out.push({ type: "heading", level: Number(tag[1]), text: el.textContent ?? "" });
      return;
    }
    if (tag === "P" || tag === "PRE" || tag === "FIGCAPTION" || tag === "DT" || tag === "DD") {
      out.push({ type: "paragraph", text: el.textContent ?? "" });
      return;
    }
    if (tag === "BLOCKQUOTE") {
      out.push({ type: "quote", text: el.textContent ?? "" });
      return;
    }
    if (tag === "LI") {
      const list = el.parentElement;
      const ordered =
        list?.tagName === "OL" ? [...list.children].filter((c) => c.tagName === "LI").indexOf(el) + 1 : null;
      out.push({ type: "item", text: el.textContent ?? "", ordered });
      return;
    }
    if (tag === "IMG") {
      const alt = el.getAttribute("alt") ?? "";
      if (alt.trim()) out.push({ type: "image", alt });
      return;
    }
    if (tag === "TR") {
      const cells = [...el.children].map((c) => clean(c.textContent ?? "")).filter(Boolean);
      if (cells.length) out.push({ type: "paragraph", text: cells.join(" · ") });
      return;
    }
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "IFRAME" || tag === "SVG") return;
    if (CONTAINERS.test(tag) || el.children.length > 0) {
      for (const c of el.childNodes) walk(c);
      return;
    }
    const t = el.textContent ?? "";
    if (clean(t)) out.push({ type: "paragraph", text: t });
  };
  walk(root);
  return out;
}

export function readArticle(): ReaderArticle | null {
  try {
    const copy = document.cloneNode(true) as Document;
    const parsed = new Readability<Node>(copy, {
      serializer: (n) => n,
      charThreshold: 300,
      maxElemsToParse: 20_000,
    }).parse();
    if (parsed?.content) {
      const a = article(parsed.title || document.title, toBlocks(parsed.content), {
        byline: parsed.byline ?? null,
        site: parsed.siteName ?? location.hostname,
        plainText: false,
      });
      if (a.blocks.length >= 2) return a;
    }
  } catch {
    // Some pages break Readability: fall back to the visible text.
  }
  return pageText();
}

/** The page's visible text as blocks, for pages that aren't articles. */
export function pageText(): ReaderArticle | null {
  if (!document.body) return null;
  const main = document.querySelector("main, [role=main], article") ?? document.body;
  const { text } = visibleText(main, 200_000);
  const blocks = blocksFromLines(text);
  if (!blocks.length) return null;
  return article(document.title, blocks, { site: location.hostname, plainText: true });
}
