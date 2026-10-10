/**
 * Adventure flows: a task as a short series of big choices, like a choose-your-own-adventure book.
 *
 * A flow is data. Each screen asks one thing and offers 2 to 6 big picture options (paged, never scrolled). Every
 * path ends in one of: a TaskRequest for the agent, a task pack (Instance 8), launching a Mac app, or another screen
 * of AGENCY. Free text is a last resort and always offers ready-made phrases first.
 */
import type { Surface } from "../state/contracts";

export type Selections = Record<string, string>;

export type FlowEnd =
  /** Hand the task to the agent. `selections` are merged over the flow's own. */
  | { type: "task"; goal: string | ((s: Selections) => string); selections?: Selections }
  /** A task pack (os/tasks, Instance 8): sent to the agent as a TaskRequest with `selections.pack`. */
  | { type: "pack"; pack: string; goal: string | ((s: Selections) => string); selections?: Selections }
  /** Open a Mac app through agency-native. */
  | { type: "launch"; bundleId: string; name: string }
  /** Go to another AGENCY screen (Talk, the Apps screen, an errand). */
  | { type: "route"; path: string };

export interface FlowOption {
  id: string;
  label: string;
  /** One short line under the label: a price, who someone is, what happens. */
  sub?: string;
  /** Name of an icon from components/Icon. */
  icon?: string;
  /** A big glyph as the picture (food, apps) when there's no image. */
  glyph?: string;
  image?: string;
  /** Facts for comparison cards ("Price", "Arrives"...). */
  facts?: { label: string; value: string }[];
  /** Choices this option records, e.g. { restaurant: "Thai Basil" }. */
  set?: Selections;
  /** Where it leads: another screen of this flow, or an end. Exactly one. */
  next?: string;
  end?: FlowEnd;
}

export interface FlowTextInput {
  /** Selection key the text is stored under. */
  key: string;
  label: string;
  placeholder?: string;
  maxLength?: number;
  next?: string;
  end?: FlowEnd;
}

export interface FlowScreen {
  id: string;
  prompt: string | ((s: Selections) => string);
  /** One plain sentence under the prompt, when it helps. */
  help?: string;
  /** "compare" lays the options out as comparison cards. */
  layout?: "choose" | "compare";
  options: FlowOption[] | ((s: Selections) => FlowOption[]);
  /** Typing, for when no option fits. Shown on its own screen. */
  text?: FlowTextInput;
}

export interface FlowDef {
  id: string;
  title: string;
  icon: string;
  /** Memory surface for suggestions and events. */
  surface: Surface;
  /** Memory path asked for "Your usual?" on the first screen, e.g. "food". */
  usualPath?: string;
  start: string;
  screens: Record<string, FlowScreen>;
}

/** What a finished flow asks the shell to do. */
export type FlowOutcome =
  | { type: "task"; goal: string; selections: Selections; pack?: string; usual?: boolean }
  | { type: "launch"; bundleId: string; name: string }
  | { type: "route"; path: string };
