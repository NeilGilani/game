/**
 * Reader view's content as plain blocks of text (no HTML ever leaves the page), cleaned and bounded. Pure, so it is
 * unit-tested without a browser.
 */

import type { ReaderArticle, ReaderBlock } from "@agency/contracts";

export const MAX_BLOCKS = 1500;
export const MAX_CHARS = 400_000;

export function clean(text: string): string {
  return text
    .replace(/[­​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textOf(b: ReaderBlock): string {
  return b.type === "image" ? b.alt : b.text;
}

/**
 * Drops empty and repeated blocks (the same line twice in a row), merges nothing, keeps order, and stops at the
 * limits so a huge page can't flood the shell.
 */
export function tidyBlocks(blocks: readonly ReaderBlock[]): ReaderBlock[] {
  const out: ReaderBlock[] = [];
  let chars = 0;
  for (const raw of blocks) {
    const b: ReaderBlock =
      raw.type === "image"
        ? { type: "image", alt: clean(raw.alt).slice(0, 300) }
        : { ...raw, text: clean(raw.text).slice(0, 8000) };
    const t = textOf(b);
    if (!t) continue;
    if (b.type === "paragraph" && t.length < 2) continue;
    const prev = out[out.length - 1];
    if (prev && prev.type === b.type && textOf(prev) === t) continue;
    if (b.type === "heading") b.level = Math.min(6, Math.max(1, Math.round(b.level) || 2));
    out.push(b);
    chars += t.length;
    if (out.length >= MAX_BLOCKS || chars >= MAX_CHARS) break;
  }
  return out;
}

/** About 200 words a minute, at least one. */
export function readingMinutes(blocks: readonly ReaderBlock[]): number {
  const words = blocks.reduce((n, b) => n + (textOf(b).match(/\S+/g)?.length ?? 0), 0);
  return Math.max(1, Math.round(words / 200));
}

/** A page's visible text (one line per block), for pages that aren't articles. */
export function blocksFromLines(text: string): ReaderBlock[] {
  return text
    .split(/\n+/)
    .map((l) => clean(l))
    .filter((l) => l.length > 0)
    .map((l): ReaderBlock => ({ type: "paragraph", text: l }));
}

export function article(
  title: string,
  blocks: readonly ReaderBlock[],
  meta: { byline?: string | null; site?: string | null; plainText: boolean },
): ReaderArticle {
  const tidy = tidyBlocks(blocks);
  // The title is shown as the article's heading: don't repeat it as the first block.
  const first = tidy[0];
  if (first && first.type === "heading" && clean(first.text) === clean(title)) tidy.shift();
  return {
    title: clean(title).slice(0, 300) || "Untitled page",
    byline: meta.byline ? clean(meta.byline).slice(0, 200) || null : null,
    site: meta.site ? clean(meta.site).slice(0, 100) || null : null,
    blocks: tidy,
    minutes: readingMinutes(tidy),
    plainText: meta.plainText,
  };
}
