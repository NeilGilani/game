import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFlow, choose } from "../src/flows/engine";
import { FLOWS } from "../src/flows/library";
import type { FlowOption } from "../src/flows/types";
import { connect, practiceTask } from "../src/state/agent";
import type { AgentCommand, TaskRequest } from "../src/state/contracts";
import {
  forRealOrdering,
  loadRealOrdering,
  REAL_ORDERING_KEY,
  realOrderRequest,
  saveRealOrdering,
} from "../src/state/realOrdering";

function storage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
}

/** The Mac app's host as the shell sees it, with main's ordering setting. */
function macHost(setting = { enabled: true, maxOrder: 60 }) {
  const sentToMac: AgentCommand[] = [];
  const saved: unknown[] = [];
  vi.stubGlobal("window", {
    agency: {
      role: "shell",
      agent: { send: (c: AgentCommand) => sentToMac.push(c), onEvent: () => () => {} },
      native: { call: async () => ({ ok: true }) },
      stopAll: async () => undefined,
      onStopAll: () => () => {},
      host: {
        realOrdering: async () => setting,
        setRealOrdering: async (s: { enabled: boolean; maxOrder: number }) => {
          saved.push(s);
          return { ok: true, setting: s };
        },
      },
    },
  });
  return { sentToMac, saved };
}

const ON = JSON.stringify({ enabled: true, maxOrder: 60, food: "doordash", shopping: "amazon" });

const food: TaskRequest = {
  id: "t1",
  goal: "Order Pad thai from Thai Basil, as soon as possible",
  origin: "flow",
  dryRun: true,
  selections: {
    kind: "food",
    restaurant: "Thai Basil",
    dish: "Pad thai",
    price: "$24.80",
    when: "As soon as possible",
  },
};
const shopping: TaskRequest = {
  id: "t2",
  goal: "Buy Paper towels from BigBox for $9.49",
  origin: "flow",
  dryRun: true,
  selections: {
    kind: "shopping",
    category: "household",
    product: "Paper towels",
    store: "BigBox",
    price: "$9.49",
  },
};

beforeEach(() => vi.stubGlobal("window", {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Food and Shopping: practice unless ordering for real is on in the Mac app", () => {
  it("off (the default): stays practice, even in the Mac app", () => {
    storage();
    const mac = macHost();
    expect(loadRealOrdering().enabled).toBe(false);
    expect(realOrderRequest(food)).toBeNull();
    const link = connect();
    link.send({ type: "task.start", request: food });
    expect(practiceTask(food)).toBe(true);
    expect(mac.sentToMac).toEqual([]);
  });

  it("on in the Mac app: a specific goal on one fixed site, for real, sent to the Mac's agent", () => {
    storage({ [REAL_ORDERING_KEY]: ON });
    const mac = macHost();
    const real = realOrderRequest(food)!;
    expect(real).toMatchObject({
      goal: "Order pad thai on DoorDash",
      dryRun: false,
      selections: { kind: "food", orderSite: "doordash", orderQuery: "Pad thai", restaurant: "Thai Basil" },
    });
    // The practice flow's made-up price is not passed on.
    expect(real.selections!.price).toBeUndefined();
    expect(practiceTask(real)).toBe(false);
    connect().send({ type: "task.start", request: real });
    expect(mac.sentToMac).toEqual([{ type: "task.start", request: real }]);

    const buy = realOrderRequest(shopping)!;
    expect(buy).toMatchObject({
      goal: "Buy paper towels on Amazon",
      dryRun: false,
      selections: { kind: "shopping", orderSite: "amazon", orderQuery: "Paper towels" },
    });
    expect(buy.selections!.store).toBeUndefined();
  });

  it("other sites from Settings; a later time is kept in the goal (the agent asks about it)", () => {
    storage({
      [REAL_ORDERING_KEY]: JSON.stringify({
        enabled: true,
        maxOrder: 40,
        food: "ubereats",
        shopping: "instacart",
      }),
    });
    macHost();
    expect(realOrderRequest({ ...food, selections: { ...food.selections, when: "At 7 pm" } })!.goal).toBe(
      "Order pad thai on Uber Eats, at 7 pm",
    );
    expect(realOrderRequest(shopping)!.selections!.orderSite).toBe("instacart");
  });

  it("never real in the browser, with the fake agent forced, or in the web demo", () => {
    storage({ [REAL_ORDERING_KEY]: ON });
    expect(realOrderRequest(food)).toBeNull(); // no Mac app
    macHost();
    vi.stubEnv("VITE_WEB_DEMO", "1");
    expect(realOrderRequest(food)).toBeNull();
    vi.unstubAllEnvs();
    storage({ [REAL_ORDERING_KEY]: ON, "agency.fakes": "agent" });
    expect(realOrderRequest(food)).toBeNull();
  });

  it("other kinds of task are left alone", () => {
    storage({ [REAL_ORDERING_KEY]: ON });
    macHost();
    expect(
      realOrderRequest({ id: "c", goal: "Call Mom", origin: "flow", selections: { kind: "call" } }),
    ).toBeNull();
    expect(realOrderRequest({ id: "m", goal: "Open Music", origin: "flow" })).toBeNull();
  });

  it("Try again on a real order after it was turned off goes back to practice", () => {
    storage({ [REAL_ORDERING_KEY]: ON });
    macHost();
    const real = realOrderRequest(food)!;
    storage();
    const back = realOrderRequest(real)!;
    expect(back.dryRun).toBe(true);
    expect(back.selections!.orderSite).toBeUndefined();
    expect(practiceTask(back)).toBe(true);
  });

  it("saving tells the Mac app; it stays off here when the Mac app refuses", async () => {
    const m = storage();
    const mac = macHost();
    expect(
      (await saveRealOrdering({ enabled: true, maxOrder: 45, food: "doordash", shopping: "amazon" })).ok,
    ).toBe(true);
    expect(mac.saved).toEqual([{ enabled: true, maxOrder: 45 }]);
    expect(loadRealOrdering()).toMatchObject({ enabled: true, maxOrder: 45 });

    (
      window as unknown as { agency: { host: { setRealOrdering: () => Promise<unknown> } } }
    ).agency.host.setRealOrdering = async () => ({ ok: false, error: "no" });
    expect(
      (await saveRealOrdering({ enabled: true, maxOrder: 45, food: "doordash", shopping: "amazon" })).ok,
    ).toBe(false);
    expect(JSON.parse(m.get(REAL_ORDERING_KEY)!).enabled).toBe(false);
  });

  it("can't be saved outside the Mac app", async () => {
    storage();
    const r = await saveRealOrdering({ enabled: true, maxOrder: 60, food: "doordash", shopping: "amazon" });
    expect(r.ok).toBe(false);
    expect(loadRealOrdering().enabled).toBe(false);
  });
});

describe("the flows when ordering for real", () => {
  const opts = (o: FlowOption[] | ((s: Record<string, string>) => FlowOption[]), s = {}) =>
    typeof o === "function" ? o(s) : o;

  it("practice flows are unchanged when it's off", () => {
    storage();
    macHost();
    expect(forRealOrdering(FLOWS.food!)).toBe(FLOWS.food);
    expect(forRealOrdering(FLOWS.shopping!)).toBe(FLOWS.shopping);
  });

  it("no made-up prices or stores on the way; Shopping goes from the item straight to the real search", () => {
    storage({ [REAL_ORDERING_KEY]: ON });
    macHost();
    const f = forRealOrdering(FLOWS.food!);
    expect(opts(f.screens.kind!.options).every((o) => o.sub === "On DoorDash")).toBe(true);
    expect(
      opts(f.screens.dish!.options, { restaurant: "Thai Basil" }).every((o) => o.sub === undefined),
    ).toBe(true);

    const s = forRealOrdering(FLOWS.shopping!);
    let state = startFlow(s);
    state = choose(s, state, "household");
    state = choose(s, state, "p0");
    expect(state.outcome).toMatchObject({
      type: "task",
      goal: "Buy Paper towels on Amazon",
      selections: { kind: "shopping", product: "Paper towels" },
    });
  });
});
