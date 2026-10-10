/**
 * What Home and the flows need from the memory tree (backend/agency/memory, Instance 6), over the HTTP contract in
 * os/contracts/src/memory.ts. When the coordinator doesn't have the memory API yet (404) or tests force it
 * (`agency.fakes=memory`), a small local fake stands in, seeded with the fictional Riley's habits and labelled.
 *
 * Memory never decides anything: it only orders choices and offers "Your usual?" first, with its reason.
 */
import { accessToken, coordinatorUrl } from "../api/client";
import type { SelectionEvent, Suggestion, Surface } from "./contracts";
import { fakeForced } from "./host";

export interface MemorySource {
  suggestions(surface: Surface, limit?: number): Promise<Suggestion[]>;
  usual(path: string): Promise<Suggestion | null>;
  record(event: SelectionEvent): Promise<void>;
  /** "coordinator" or "demo" (the local fake). */
  readonly kind: () => "coordinator" | "demo";
}

class NotAvailable extends Error {}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const token = accessToken();
  if (token) headers.set("X-Agency-Token", token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(`${coordinatorUrl()}${path}`, { ...init, headers, signal: controller.signal });
    if (r.status === 404 || r.status === 405) throw new NotAvailable();
    if (!r.ok) throw new Error(`memory ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** The fictional demo profile's habits. Clearly demo data; replaced by the real memory tree when it's there. */
export const DEMO_SUGGESTIONS: Suggestion[] = [
  {
    nodeId: "demo-food-thai",
    path: ["food", "delivery", "Thai Basil", "Pad thai (mild)"],
    label: "Pad thai from Thai Basil",
    score: 0.86,
    reason: "You chose this 4 of the last 5 Fridays.",
    task: {
      goal: "Order pad thai (mild) from Thai Basil",
      selections: {
        kind: "food",
        restaurant: "Thai Basil",
        dish: "Pad thai",
        spice: "mild",
        price: "$24.80",
      },
    },
  },
  {
    nodeId: "demo-call-jordan",
    path: ["call", "Jordan"],
    label: "Call Jordan",
    score: 0.72,
    reason: "You call Jordan most evenings.",
    task: { goal: "Call Jordan", selections: { kind: "call", person: "Jordan", reason: "To chat" } },
  },
  {
    nodeId: "demo-watch-music",
    path: ["watch", "Music", "Morning playlist"],
    label: "Your morning playlist",
    score: 0.61,
    reason: "You played it 3 mornings this week.",
    task: {
      goal: "Play my morning playlist in Music",
      selections: { kind: "watch", app: "Music", where: "Music" },
    },
  },
];

const DEMO_USUALS: Record<string, Suggestion> = {
  food: DEMO_SUGGESTIONS[0]!,
  call: DEMO_SUGGESTIONS[1]!,
  watch: DEMO_SUGGESTIONS[2]!,
};

class DemoMemory {
  events: SelectionEvent[] = [];
  async suggestions(surface: Surface, limit = 6): Promise<Suggestion[]> {
    return surface === "home" ? DEMO_SUGGESTIONS.slice(0, limit) : [];
  }
  async usual(path: string): Promise<Suggestion | null> {
    return DEMO_USUALS[path.split("/")[0] ?? ""] ?? null;
  }
  async record(event: SelectionEvent): Promise<void> {
    this.events.push(event);
  }
}

export function createMemory(): MemorySource {
  const demo = new DemoMemory();
  let useDemo = fakeForced("memory");
  const fallback =
    <T>(run: () => Promise<T>, local: () => Promise<T>) =>
    async (): Promise<T> => {
      if (useDemo) return local();
      try {
        return await run();
      } catch (err) {
        if (err instanceof NotAvailable) {
          useDemo = true;
          return local();
        }
        throw err;
      }
    };
  return {
    kind: () => (useDemo ? "demo" : "coordinator"),
    suggestions: (surface, limit = 6) =>
      fallback(
        () => call<Suggestion[]>(`/api/memory/suggestions?surface=${surface}&limit=${limit}`),
        () => demo.suggestions(surface, limit),
      )(),
    usual: (path) =>
      fallback(
        () => call<Suggestion | null>(`/api/memory/usual?path=${encodeURIComponent(path)}`),
        () => demo.usual(path),
      )(),
    record: async (event) => {
      try {
        await fallback(
          () =>
            call<unknown>("/api/memory/events", { method: "POST", body: JSON.stringify(event) }).then(
              () => undefined,
            ),
          () => demo.record(event),
        )();
      } catch {
        /* Remembering is best effort: never block the person's choice on it. */
      }
    },
  };
}

let shared: MemorySource | null = null;
export function memory(): MemorySource {
  shared ??= createMemory();
  return shared;
}
