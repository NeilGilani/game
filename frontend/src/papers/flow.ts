/**
 * The Papers flow's first choices go to the real Papers screens when there are real documents to work on (the Mac
 * app with a folder chosen, or a plain browser with the file picker). In practice mode they keep going to the
 * practice documents.
 */
import type { FlowOption } from "../flows/types";
import { papersMode } from "./source";

const REAL = new Set(["explain", "fill", "sign"]);
const REAL_SUB: Record<string, string> = { fill: "You check every answer" };

export function realPapers(options: FlowOption[]): FlowOption[] {
  if (papersMode() === "practice") return options;
  return options.map((o): FlowOption => {
    if (!REAL.has(o.id)) return o;
    const { next: _next, ...rest } = o;
    void _next;
    return { ...rest, sub: REAL_SUB[o.id] ?? o.sub, end: { type: "route", path: `/papers/${o.id}` } };
  });
}
