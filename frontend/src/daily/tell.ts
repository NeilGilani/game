/** Where "Tell my carer" goes: one screen that shows exactly what would be sent, to whom, before anything is. */
import type { RequestKind } from "./types";

export const KINDS: RequestKind[] = ["help", "routine", "schedule"];

export function tellPath(kind: RequestKind, text: string): string {
  const q = new URLSearchParams({ kind, text: text.slice(0, 160) });
  return `/day/tell?${q.toString()}`;
}

export function readTell(query: URLSearchParams): { kind: RequestKind; text: string } | null {
  const kind = query.get("kind") as RequestKind | null;
  const text = (query.get("text") ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!kind || !KINDS.includes(kind) || !text) return null;
  return { kind, text };
}

/** Everyday requests: never emergencies. Lifeline is one look away on the same screen. */
export const HELP_REQUESTS: { text: string; icon: string }[] = [
  { text: "I'm cold", icon: "down" },
  { text: "I'm too warm", icon: "up" },
  { text: "Turn me, please", icon: "refresh" },
  { text: "I need the bathroom", icon: "home" },
  { text: "I'm thirsty", icon: "food" },
  { text: "Fix my pillow, please", icon: "head" },
  { text: "Please come when you can", icon: "hand" },
];
