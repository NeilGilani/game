/**
 * The memory tree (Instance 6) as the packs use it, per os/contracts/src/memory.ts.
 * The HTTP client talks to the coordinator; the fake keeps everything in memory and
 * produces suggestions from counts so tests and demos work without the backend.
 */

import type { SelectionEvent, Suggestion, Surface } from "../contracts";

export interface MemoryClient {
  log(event: SelectionEvent): Promise<void>;
  suggestions(surface: Surface, limit?: number): Promise<Suggestion[]>;
  usual(path: string): Promise<Suggestion | null>;
}

export function httpMemory(
  baseUrl: string,
  headers: () => Record<string, string> = () => ({}),
): MemoryClient {
  const url = (p: string) => `${baseUrl.replace(/\/$/, "")}${p}`;
  return {
    async log(event) {
      await fetch(url("/api/memory/events"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify(event),
      }).catch(() => undefined);
    },
    async suggestions(surface, limit = 6) {
      const r = await fetch(url(`/api/memory/suggestions?surface=${surface}&limit=${limit}`), {
        headers: headers(),
      });
      if (!r.ok) return [];
      return (await r.json()) as Suggestion[];
    },
    async usual(path) {
      const r = await fetch(url(`/api/memory/usual?path=${encodeURIComponent(path)}`), {
        headers: headers(),
      });
      if (!r.ok) return null;
      return (await r.json()) as Suggestion | null;
    },
  };
}

/** Never fails: memory is a convenience, so its absence must not block a task. */
export function safeMemory(inner: MemoryClient): MemoryClient {
  return {
    log: (e) => inner.log(e).catch(() => undefined),
    suggestions: (s, l) => inner.suggestions(s, l).catch(() => []),
    usual: (p) => inner.usual(p).catch(() => null),
  };
}

export class FakeMemory implements MemoryClient {
  readonly events: SelectionEvent[] = [];
  constructor(
    private readonly seeded: Partial<Record<Surface, Suggestion[]>> = {},
    private readonly usuals: Record<string, Suggestion> = {},
  ) {}

  async log(event: SelectionEvent): Promise<void> {
    this.events.push(event);
  }

  async suggestions(surface: Surface, limit = 6): Promise<Suggestion[]> {
    const counts = new Map<string, { n: number; path: string[] }>();
    for (const e of this.events) {
      if (e.surface !== surface || e.outcome === "rejected" || e.outcome === "abandoned") continue;
      const key = e.path.join("/");
      counts.set(key, { n: (counts.get(key)?.n ?? 0) + 1, path: e.path });
    }
    const learned: Suggestion[] = [...counts.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([key, { n, path }]) => ({
        nodeId: `fake:${key}`,
        path,
        label: path.at(-1) ?? key,
        score: Math.min(1, n / 10),
        reason: `You chose this ${n} time${n === 1 ? "" : "s"} recently.`,
      }));
    return [...(this.seeded[surface] ?? []), ...learned].slice(0, limit);
  }

  async usual(path: string): Promise<Suggestion | null> {
    return this.usuals[path] ?? null;
  }
}
