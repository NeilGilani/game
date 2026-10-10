/**
 * The flow engine: pure functions over a FlowDef. No React, no timers, no network, so every flow is checked by
 * Vitest (validateFlow) and the runner screen stays thin.
 */
import type { Suggestion } from "../state/contracts";
import type { FlowDef, FlowEnd, FlowOption, FlowOutcome, FlowScreen, Selections } from "./types";

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
/** Options per page. Fewer than MAX when a screen has to page, so nothing is ever scrolled. */
export const PAGE_SIZE = 6;
export const USUAL_ID = "__usual";
export const TYPE_ID = "__type";

export interface FlowState {
  flowId: string;
  screenId: string;
  selections: Selections;
  /** Labels chosen so far, for memory ("food › Thai Basil › Pad thai"). */
  path: string[];
  history: { screenId: string; selections: Selections; path: string[]; typing: boolean }[];
  page: number;
  /** On the screen's typing step. */
  typing: boolean;
  outcome: FlowOutcome | null;
}

export function startFlow(flow: FlowDef, prefill: Selections = {}): FlowState {
  return {
    flowId: flow.id,
    screenId: flow.start,
    selections: { ...prefill },
    path: [],
    history: [],
    page: 0,
    typing: false,
    outcome: null,
  };
}

export function screenOf(flow: FlowDef, state: FlowState): FlowScreen {
  const screen = flow.screens[state.screenId];
  if (!screen) throw new Error(`Flow ${flow.id} has no screen ${state.screenId}`);
  return screen;
}

export function promptOf(screen: FlowScreen, s: Selections): string {
  return typeof screen.prompt === "function" ? screen.prompt(s) : screen.prompt;
}

/** The option offering memory's usual, shown first on the first screen. */
export function usualOption(usual: Suggestion): FlowOption | null {
  if (!usual.task) return null;
  return {
    id: USUAL_ID,
    label: `Your usual: ${usual.label}`,
    sub: usual.reason,
    icon: "sparkle",
    end: { type: "task", goal: usual.task.goal, selections: usual.task.selections },
  };
}

/** All options on this screen: the usual first (first screen only), then the screen's own, then "Type it". */
export function optionsOf(flow: FlowDef, state: FlowState, usual: Suggestion | null = null): FlowOption[] {
  const screen = screenOf(flow, state);
  const own = typeof screen.options === "function" ? screen.options(state.selections) : screen.options;
  const first =
    state.screenId === flow.start && state.history.length === 0 && usual ? usualOption(usual) : null;
  const typeIt: FlowOption[] = screen.text
    ? [{ id: TYPE_ID, label: screen.text.label, icon: "edit", sub: "With the keyboard" }]
    : [];
  return [...(first ? [first] : []), ...own, ...typeIt];
}

export interface Page {
  items: FlowOption[];
  page: number;
  pages: number;
}

/** One page of options. Pages are fixed: nothing moves while the person is looking. */
export function pageOf(options: FlowOption[], page: number, size = PAGE_SIZE): Page {
  const pages = Math.max(1, Math.ceil(options.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { items: options.slice(p * size, p * size + size), page: p, pages };
}

export function resolveEnd(end: FlowEnd, selections: Selections, usual = false): FlowOutcome {
  switch (end.type) {
    case "task":
    case "pack": {
      const merged = { ...selections, ...(end.selections ?? {}) };
      const goal = typeof end.goal === "function" ? end.goal(merged) : end.goal;
      return end.type === "pack"
        ? { type: "task", goal, selections: { ...merged, pack: end.pack }, pack: end.pack }
        : { type: "task", goal, selections: merged, ...(usual ? { usual } : {}) };
    }
    case "launch":
      return { type: "launch", bundleId: end.bundleId, name: end.name };
    case "route":
      return { type: "route", path: end.path };
  }
}

function push(state: FlowState): FlowState["history"][number] {
  return { screenId: state.screenId, selections: state.selections, path: state.path, typing: state.typing };
}

/** The person chose an option. Unknown options leave the state unchanged. */
export function choose(
  flow: FlowDef,
  state: FlowState,
  optionId: string,
  usual: Suggestion | null = null,
): FlowState {
  if (state.outcome) return state;
  const option = optionsOf(flow, state, usual).find((o) => o.id === optionId);
  if (!option) return state;
  if (option.id === TYPE_ID)
    return { ...state, history: [...state.history, push(state)], typing: true, page: 0 };
  const selections = { ...state.selections, ...(option.set ?? {}) };
  const path = [...state.path, option.label];
  if (option.end) {
    return {
      ...state,
      selections,
      path,
      outcome: resolveEnd(option.end, selections, option.id === USUAL_ID),
    };
  }
  if (option.next && flow.screens[option.next]) {
    return {
      ...state,
      history: [...state.history, push(state)],
      screenId: option.next,
      selections,
      path,
      page: 0,
      typing: false,
    };
  }
  return state;
}

/** The person typed something on a screen's typing step. Blank text is ignored. */
export function submitText(flow: FlowDef, state: FlowState, text: string): FlowState {
  const input = screenOf(flow, state).text;
  const value = text.trim().slice(0, input?.maxLength ?? 200);
  if (!input || !state.typing || !value) return state;
  const selections = { ...state.selections, [input.key]: value };
  const path = [...state.path, value];
  if (input.end)
    return { ...state, selections, path, typing: false, outcome: resolveEnd(input.end, selections) };
  if (input.next && flow.screens[input.next]) {
    return {
      ...state,
      history: [...state.history, push({ ...state, typing: false })],
      screenId: input.next,
      selections,
      path,
      page: 0,
      typing: false,
    };
  }
  return state;
}

/** Back one screen. At the first screen there's nowhere to go back to (the runner offers Home). */
export function back(state: FlowState): FlowState {
  const prev = state.history[state.history.length - 1];
  if (!prev) return state;
  return {
    ...state,
    screenId: prev.screenId,
    selections: prev.selections,
    path: prev.path,
    typing: prev.typing,
    history: state.history.slice(0, -1),
    page: 0,
    outcome: null,
  };
}

export function setPage(state: FlowState, page: number): FlowState {
  return { ...state, page };
}

/** Problems with a flow definition. Every flow ships with an empty list (checked in tests). */
export function validateFlow(flow: FlowDef, samples: Selections[] = [{}]): string[] {
  const problems: string[] = [];
  const where = (s: FlowScreen) => `${flow.id}/${s.id}`;
  if (!flow.screens[flow.start]) problems.push(`${flow.id}: start screen ${flow.start} is missing`);
  const reached = new Set<string>([flow.start]);
  for (const [id, screen] of Object.entries(flow.screens)) {
    if (screen.id !== id) problems.push(`${flow.id}/${id}: id doesn't match its key`);
    const lists =
      typeof screen.options === "function"
        ? samples.map((s) => (screen.options as (s: Selections) => FlowOption[])(s))
        : [screen.options];
    for (const opts of lists) {
      const count = opts.length + (screen.text ? 1 : 0);
      if (count < MIN_OPTIONS || count > MAX_OPTIONS)
        problems.push(`${where(screen)}: ${count} options (needs ${MIN_OPTIONS} to ${MAX_OPTIONS})`);
      const ids = new Set<string>();
      for (const o of opts) {
        if (ids.has(o.id)) problems.push(`${where(screen)}: duplicate option ${o.id}`);
        ids.add(o.id);
        if (!o.label.trim()) problems.push(`${where(screen)}/${o.id}: empty label`);
        if (o.label.length > 40) problems.push(`${where(screen)}/${o.id}: label longer than 40 characters`);
        if (!!o.next === !!o.end) problems.push(`${where(screen)}/${o.id}: needs exactly one of next or end`);
        if (o.next) {
          if (!flow.screens[o.next])
            problems.push(`${where(screen)}/${o.id}: next screen ${o.next} is missing`);
          reached.add(o.next);
        }
      }
    }
    if (screen.text) {
      if (!!screen.text.next === !!screen.text.end)
        problems.push(`${where(screen)}: text needs exactly one of next or end`);
      if (screen.text.next) {
        if (!flow.screens[screen.text.next])
          problems.push(`${where(screen)}: text next ${screen.text.next} is missing`);
        reached.add(screen.text.next);
      }
    }
  }
  const start = flow.screens[flow.start];
  if (flow.usualPath && start && typeof start.options !== "function") {
    // Room for "Your usual?" first without paging.
    const count = start.options.length + (start.text ? 1 : 0);
    if (count > MAX_OPTIONS - 1)
      problems.push(`${flow.id}/${start.id}: ${count} options leaves no room for the usual`);
  }
  for (const id of Object.keys(flow.screens))
    if (!reached.has(id)) problems.push(`${flow.id}/${id}: no option leads here`);
  return problems;
}
