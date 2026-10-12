/**
 * Macs ignore case in file names, so "./TicTacToe" can resolve to tictactoe.ts there while Linux finds
 * TicTacToe.tsx. That broke the Mac build once: no two files in one folder may differ only in the case of their name.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function clashes(dir: string): string[] {
  const found: string[] = [];
  const stems = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...clashes(join(dir, entry.name)));
      continue;
    }
    const stem = entry.name.replace(/\.[^.]+$/, "");
    const seen = stems.get(stem.toLowerCase());
    if (seen !== undefined && seen !== stem) found.push(join(dir, `${seen} / ${stem}`));
    stems.set(stem.toLowerCase(), stem);
  }
  return found;
}

describe("file names", () => {
  it("never differ only in case within a folder", () => {
    const root = join(__dirname, "..");
    expect([...clashes(join(root, "src")), ...clashes(join(root, "tests"))]).toEqual([]);
  });
});
