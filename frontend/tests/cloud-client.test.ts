import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";
import type { Goal } from "../src/api/types";

const goal: Goal = {
  goal_type: "equipment_repair",
  outcome: "Repair my wheelchair",
  deadline: null,
  preferences: {},
  entities: {},
  constraints: [],
  missing_info: [],
  approvals_required: [],
  prohibited: [],
  options: {},
};

describe("cloud request budgets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => null });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    { name: "interpretation", run: () => api.interpret({ free_text: "Please repair my wheelchair" }) },
    { name: "case creation", run: () => api.createCase(goal) },
    { name: "cloud access check", run: () => api.checkCloud() },
    { name: "explanation", run: () => api.explain("approval_demo") },
  ])("keeps a slow cloud $name alive past the old 12-second timeout", async ({ run }) => {
    let signal: AbortSignal | undefined;
    let complete: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      }),
    );
    const pending = run();
    await vi.advanceTimersByTimeAsync(90000);
    expect(signal?.aborted).toBe(false);
    complete!(new Response(JSON.stringify({ ready: true }), { status: 200 }));
    expect(await pending).toEqual({ ready: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still aborts ordinary health requests promptly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    const result = expect(api.health()).rejects.toThrow("Can't reach the coordinator.");
    await vi.advanceTimersByTimeAsync(4000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
