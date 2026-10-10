/**
 * The memory tree (Instance 6) over the coordinator's HTTP API. The agent asks for the minimum it needs
 * (a few suggestions for one surface) and logs choices and outcomes back.
 */

import type { ChoiceOption, SelectionEvent, Suggestion, Surface, TaskRequest } from "@agency/contracts";

export interface MemoryClient {
  suggestions(surface: Surface, limit: number): Promise<Suggestion[]>;
  log(event: SelectionEvent): Promise<void>;
}

export class HttpMemoryClient implements MemoryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async suggestions(surface: Surface, limit: number): Promise<Suggestion[]> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/memory/suggestions?surface=${encodeURIComponent(surface)}&limit=${limit}`,
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as Suggestion[]) : [];
  }

  async log(event: SelectionEvent): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/api/memory/events`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
  }

  private headers(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }
}

export class FakeMemoryClient implements MemoryClient {
  readonly logged: SelectionEvent[] = [];
  constructor(private readonly items: Partial<Record<Surface, Suggestion[]>> = {}) {}
  async suggestions(surface: Surface, limit: number): Promise<Suggestion[]> {
    return (this.items[surface] ?? []).slice(0, limit);
  }
  async log(event: SelectionEvent): Promise<void> {
    this.logged.push(event);
  }
}

/** Memory never blocks a task: failures return nothing and are ignored. */
export async function safeSuggestions(
  memory: MemoryClient | null,
  surface: Surface,
  limit = 6,
): Promise<Suggestion[]> {
  if (!memory) return [];
  try {
    return await memory.suggestions(surface, limit);
  } catch {
    return [];
  }
}

export async function safeLog(memory: MemoryClient | null, event: SelectionEvent): Promise<void> {
  if (!memory) return;
  try {
    await memory.log(event);
  } catch {
    /* memory is optional */
  }
}

const SURFACE_WORDS: [Surface, RegExp][] = [
  ["food", /\b(food|eat|dinner|lunch|breakfast|order|pizza|thai|coffee|meal|restaurant|grocer)/i],
  ["call", /\b(call|phone|ring)\b/i],
  ["papers", /\b(form|letter|document|sign|paper|benefit|bill)\b/i],
  ["shopping", /\b(buy|shop|purchase|amazon|store)\b/i],
  ["browse", /\b(browse|youtube|website|web|read news)\b/i],
  ["talk", /\b(message|text|email|reply|tell)\b/i],
  ["apps", /\b(app|open)\b/i],
];

export function surfaceFor(request: TaskRequest): Surface {
  const text = `${request.goal} ${Object.values(request.selections ?? {}).join(" ")}`;
  return SURFACE_WORDS.find(([, re]) => re.test(text))?.[0] ?? "home";
}

/**
 * Re-rank options with memory: options matching a suggestion's label go first, with its reason.
 * Matching is by case-insensitive label containment.
 */
export function rankWithMemory(options: ChoiceOption[], suggestions: Suggestion[]): ChoiceOption[] {
  const scored = options.map((o, index) => {
    const label = o.label.toLowerCase();
    const s = suggestions.find((x) => {
      const l = x.label.toLowerCase();
      return (
        l === label || l.includes(label) || label.includes(l) || x.path.some((p) => p.toLowerCase() === label)
      );
    });
    return { o: s ? { ...o, suggestedBecause: s.reason } : o, score: s?.score ?? -1, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.o);
}
