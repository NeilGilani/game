/** Pain and discomfort reports: a few big choices that become one clear sentence. */

export type Kind = "pain" | "itch" | "cramp" | "numb";

export const KINDS: { id: Kind; label: string; sub: string }[] = [
  { id: "pain", label: "Pain", sub: "It hurts" },
  { id: "itch", label: "Itch", sub: "Please scratch it" },
  { id: "cramp", label: "Cramp or spasm", sub: "A muscle is tight" },
  { id: "numb", label: "Numb or tingling", sub: "Pins and needles" },
];

export const AREAS = [
  "head",
  "eyes",
  "mouth or throat",
  "neck",
  "shoulders",
  "chest",
  "stomach",
  "back",
  "left arm or hand",
  "right arm or hand",
  "left leg or foot",
  "right leg or foot",
] as const;

/** Five steps of the 0 to 10 scale clinicians ask about, in words and numbers. */
export const SEVERITY = [
  { level: 2, label: "A little" },
  { level: 4, label: "Some" },
  { level: 6, label: "Bad" },
  { level: 8, label: "Very bad" },
  { level: 10, label: "The worst" },
] as const;

export type Severity = (typeof SEVERITY)[number];

export function needsSeverity(kind: Kind): boolean {
  return kind === "pain" || kind === "cramp";
}

/** Plural areas ("eyes", "shoulders") take "hurt"/"itch"; the rest take "hurts"/"itches". */
function isPlural(area: string): boolean {
  return area === "eyes" || area === "shoulders";
}

/** The sentence for a report, e.g. "My back hurts. It's bad, 6 out of 10." */
export function painSentence(kind: Kind, area: string, severity?: Severity): string {
  const plural = isPlural(area);
  const scale = severity ? ` It's ${severity.label.toLowerCase()}, ${severity.level} out of 10.` : "";
  switch (kind) {
    case "itch":
      return `My ${area} ${plural ? "itch" : "itches"}. Please scratch ${plural ? "them" : "it"}.`;
    case "numb":
      return `My ${area} ${plural ? "feel" : "feels"} numb and tingly.`;
    case "cramp":
      return `I have a cramp in my ${area}.${scale}`;
    default:
      return `My ${area} ${plural ? "hurt" : "hurts"}.${scale}`;
  }
}
