/**
 * Macs ignore case in file names, so "./TicTacToe" can resolve to tictactoe.ts there while Linux finds
 * TicTacToe.tsx. That broke the Mac build once: no two files in one folder may differ only in the case of their name.
 */
import { describe, expect, it } from "vitest";

const files = Object.keys({
  ...import.meta.glob("../src/**/*", { query: "?url" }),
  ...import.meta.glob("./**/*", { query: "?url" }),
});

describe("file names", () => {
  it("never differ only in case within a folder", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const file of files) {
      const stem = file.replace(/\.[^./]+$/, "");
      const other = seen.get(stem.toLowerCase());
      if (other !== undefined && other !== stem) clashes.push(`${other} / ${stem}`);
      seen.set(stem.toLowerCase(), stem);
    }
    expect(files.length).toBeGreaterThan(50);
    expect(clashes).toEqual([]);
  });
});
