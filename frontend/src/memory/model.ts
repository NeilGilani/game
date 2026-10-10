/** Pure helpers for the memory explorer (unit-tested in tests/memory.test.ts). */
import type { Suggestion, TreeNode } from "./types";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const HIDDEN_DETAILS = new Set(["type", "sensitive", "choice"]);

export function capitalize(text: string): string {
  return text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text;
}

/** Children of a node (or the areas when parentId is null): kept first, then hidden last, then by name. */
export function childrenOf(tree: TreeNode[], parentId: string | null): TreeNode[] {
  return tree
    .filter((n) => n.parentId === parentId)
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(a.hidden) - Number(b.hidden) ||
        a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
}

/** How many things a node holds: its leaves (or 1 if it is one). */
export function leafCount(tree: TreeNode[], id: string): number {
  const kids = tree.filter((n) => n.parentId === id);
  if (kids.length === 0) return 1;
  return kids.reduce((sum, k) => sum + leafCount(tree, k.id), 0);
}

export function pageOf<T>(items: T[], page: number, perPage: number) {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(Math.max(0, page), pages - 1);
  return { items: items.slice(current * perPage, current * perPage + perPage), page: current, pages };
}

/** "spice: mild" style details, without bookkeeping fields and without repeating the name. */
export function detailsText(attributes: Record<string, string>, label = ""): string {
  const name = label.toLocaleLowerCase();
  return Object.entries(attributes)
    .filter(([k, v]) => !HIDDEN_DETAILS.has(k) && v && !name.includes(v.toLocaleLowerCase()))
    .map(([, v]) => v)
    .join(", ");
}

/** "Thai Basil, Pad thai (mild)": the path below the area and routine, then extra details. */
export function usualHeadline(s: Suggestion): string {
  const parts = s.path.length > 2 ? s.path.slice(2) : s.path.slice(-1);
  const extras = Object.entries(s.task?.selections ?? {})
    .filter(
      ([k, v]) =>
        !HIDDEN_DETAILS.has(k) &&
        v &&
        !parts.some((p) => p.toLocaleLowerCase().includes(v.toLocaleLowerCase())),
    )
    .map(([, v]) => v);
  return [...parts, ...extras].join(", ");
}

function daypartOf(hour: number): string {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "midday";
  if (hour >= 14 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

const MEALS: Record<string, string> = {
  morning: "breakfast",
  midday: "lunch",
  afternoon: "snack",
  evening: "dinner",
  night: "late snack",
};

/** "Usual Friday dinner" when the reason is about Fridays; "Usual call" otherwise. */
export function usualTitle(s: Suggestion, now: Date): string {
  const area = (s.path[0] ?? "").toLocaleLowerCase();
  const day = WEEKDAYS[now.getDay()]!;
  const onThisDay = s.reason.includes(day) ? `${day} ` : "";
  const part = daypartOf(now.getHours());
  if (area === "food") return `Usual ${onThisDay}${MEALS[part]}`;
  const mentionsPart = s.reason.includes(part) || s.reason.includes("lunchtime");
  const when = onThisDay || mentionsPart ? `${onThisDay}${mentionsPart ? part + " " : ""}` : "";
  return `Usual ${when}${area || "choice"}`.trim();
}

export function relativeDay(iso: string | null, now: Date): string {
  if (!iso) return "never";
  const then = new Date(iso);
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `on ${WEEKDAYS[then.getDay()]}`;
  return `on ${then.getDate()} ${MONTHS[then.getMonth()]}`;
}

export function dateText(iso: string): string {
  const d = new Date(iso);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export const KIND_LABELS: Record<string, string> = {
  area: "Area",
  routine: "Routine",
  task: "Task",
  choice: "Choice",
  entity: "Place or person",
  phrase: "Phrase",
};

/** Half-life choices, in plain words. */
export const FADE_CHOICES = [
  { days: 14, label: "Quickly", sub: "Old habits fade in about 2 weeks" },
  { days: 30, label: "Normally", sub: "Old habits fade in about a month" },
  { days: 90, label: "Slowly", sub: "Old habits fade in about 3 months" },
] as const;
