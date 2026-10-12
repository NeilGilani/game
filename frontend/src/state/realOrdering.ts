/**
 * "Order for real" (Settings, For a helper): in the Mac app only, Food and Shopping can order on the person's own
 * signed-in DoorDash or Uber Eats, and Amazon or Instacart, in Chrome. The agent's ordering pack (os/agent) does
 * it, stops at checkout, and pays only after the person approves the exact total.
 *
 * Off by default. Everywhere else (the browser, the web demo, tests) Food and Shopping stay practice, always.
 * The switch lives in two places on purpose: here (so the shell knows where to send the task) and in the Mac
 * app's main process, which writes it for the agent (the agent refuses a real order when main says it's off).
 */
import type { FlowDef, FlowOption, FlowScreen, Selections } from "../flows/types";
import type { TaskRequest } from "./contracts";
import { fakeForced, host } from "./host";

export type FoodSite = "doordash" | "ubereats";
export type ShopSite = "amazon" | "instacart";

export interface RealOrdering {
  enabled: boolean;
  /** The most one order may cost, in dollars. */
  maxOrder: number;
  food: FoodSite;
  shopping: ShopSite;
}

export const REAL_ORDERING_KEY = "agency.realOrdering";
export const DEFAULT_REAL_ORDERING: RealOrdering = {
  enabled: false,
  maxOrder: 60,
  food: "doordash",
  shopping: "amazon",
};
export const CAP_RANGE = { min: 10, max: 500, step: 5 } as const;

export const SITE_NAMES: Record<FoodSite | ShopSite, string> = {
  doordash: "DoorDash",
  ubereats: "Uber Eats",
  amazon: "Amazon",
  instacart: "Instacart",
};

/** Only in the Mac app, with its real agent, and never in the hosted web demo. */
export function realOrderingAvailable(): boolean {
  if (import.meta.env.VITE_WEB_DEMO === "1") return false;
  return host() !== null && !fakeForced("agent");
}

export function loadRealOrdering(): RealOrdering {
  try {
    const raw = JSON.parse(localStorage.getItem(REAL_ORDERING_KEY) ?? "null") as Partial<RealOrdering> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_REAL_ORDERING;
    const cap = Number(raw.maxOrder);
    return {
      enabled: raw.enabled === true,
      maxOrder:
        Number.isFinite(cap) && cap >= CAP_RANGE.min && cap <= CAP_RANGE.max
          ? cap
          : DEFAULT_REAL_ORDERING.maxOrder,
      food: raw.food === "ubereats" ? "ubereats" : "doordash",
      shopping: raw.shopping === "instacart" ? "instacart" : "amazon",
    };
  } catch {
    return DEFAULT_REAL_ORDERING;
  }
}

/** On, and possible here: the shell then sends Food and Shopping to the agent. */
export function realOrderingOn(): boolean {
  return realOrderingAvailable() && loadRealOrdering().enabled;
}

interface OrderingHost {
  host?: {
    realOrdering?: () => Promise<{ enabled: boolean; maxOrder: number }>;
    setRealOrdering?: (s: {
      enabled: boolean;
      maxOrder: number;
    }) => Promise<{ ok: boolean; error?: string; setting?: { enabled: boolean; maxOrder: number } }>;
  };
}

function orderingHost(): OrderingHost["host"] | null {
  return realOrderingAvailable() ? ((host() as unknown as OrderingHost | null)?.host ?? null) : null;
}

/** What the Mac app's main process has (the agent follows that one), or null outside the Mac app. */
export async function hostRealOrdering(): Promise<{ enabled: boolean; maxOrder: number } | null> {
  const h = orderingHost();
  if (!h?.realOrdering) return null;
  try {
    return await h.realOrdering();
  } catch {
    return null;
  }
}

/** Keep this copy in step with the Mac app's (the one the agent follows): never on here when it is off there. */
export function rememberRealOrdering(p: RealOrdering): void {
  try {
    localStorage.setItem(REAL_ORDERING_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** Save here and in the Mac app. Turning it on only sticks when the Mac app accepted it. */
export async function saveRealOrdering(next: RealOrdering): Promise<{ ok: boolean; error?: string }> {
  const h = orderingHost();
  if (!h?.setRealOrdering)
    return {
      ok: false,
      error: "Ordering for real works only in the AGENCY Mac app. Here, Food and Shopping are practice.",
    };
  let r: { ok: boolean; error?: string };
  try {
    r = await h.setRealOrdering({ enabled: next.enabled, maxOrder: next.maxOrder });
  } catch {
    r = { ok: false, error: "The Mac app didn't answer, so nothing changed." };
  }
  rememberRealOrdering(r.ok ? next : { ...next, enabled: false });
  return r;
}

/**
 * The task as it goes to the agent when ordering for real is on: a specific goal on one fixed site, and what to
 * search for. null when it stays practice (off, not the Mac app, not Food or Shopping, nothing to search for).
 * A request that was already real, started again while it is off, goes back to practice.
 */
export function realOrderRequest(request: TaskRequest): TaskRequest | null {
  const s = request.selections ?? {};
  if (s.kind !== "food" && s.kind !== "shopping") return null;
  if (!realOrderingOn()) {
    if (!s.orderSite) return null;
    const rest = { ...s };
    delete rest.orderSite;
    delete rest.orderQuery;
    return { ...request, selections: rest, dryRun: true };
  }
  const prefs = loadRealOrdering();
  const site = s.kind === "food" ? prefs.food : prefs.shopping;
  const query = (s.orderQuery ?? (s.kind === "food" ? s.dish : s.product) ?? "").trim();
  if (!query) return null;
  const name = SITE_NAMES[site];
  const when = s.when && !/^as soon as possible$/i.test(s.when) ? `, ${s.when.toLowerCase()}` : "";
  const goal =
    s.kind === "food"
      ? `Order ${query.toLowerCase()} on ${name}${when}`
      : `Buy ${query.toLowerCase()} on ${name}`;
  const selections: Record<string, string> = { ...s, orderSite: site, orderQuery: query };
  // Fictional prices from the practice flow mean nothing on the real site.
  delete selections.price;
  delete selections.store;
  return { ...request, goal, selections, dryRun: false };
}

const options = (screen: FlowScreen, s: Selections): FlowOption[] =>
  typeof screen.options === "function" ? screen.options(s) : screen.options;

/**
 * Food and Shopping flows when ordering for real: no fictional prices or stores on the way, since the site shows
 * the real ones next. Food asks what to eat as before; Shopping goes straight from the item to the real search.
 */
export function forRealOrdering(flow: FlowDef): FlowDef {
  if ((flow.id !== "food" && flow.id !== "shopping") || !realOrderingOn()) return flow;
  const prefs = loadRealOrdering();
  const screens: Record<string, FlowScreen> = { ...flow.screens };
  if (flow.id === "food") {
    const name = SITE_NAMES[prefs.food];
    const kind = screens.kind;
    if (kind)
      screens.kind = { ...kind, options: (s) => options(kind, s).map((o) => ({ ...o, sub: `On ${name}` })) };
    const dish = screens.dish;
    if (dish)
      screens.dish = {
        ...dish,
        prompt: "What would you like?",
        help: `${name} shows the real restaurants and prices next. You approve the exact total before anything is paid.`,
        options: (s) => options(dish, s).map((o) => ({ ...o, sub: undefined })),
      };
  } else {
    const name = SITE_NAMES[prefs.shopping];
    const item = screens.item;
    if (item)
      screens.item = {
        ...item,
        help: `${name} shows the real choices and prices next. You approve the exact total before anything is paid.`,
        options: (s) =>
          options(item, s).map((o) => ({
            ...o,
            next: undefined,
            end: {
              type: "task" as const,
              goal: (sel: Selections) => `Buy ${sel.product ?? "it"} on ${name}`,
              selections: { kind: "shopping" },
            },
          })),
      };
  }
  return { ...flow, screens };
}
