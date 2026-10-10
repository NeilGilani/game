import { describe, expect, it, vi } from "vitest";
import type { AgencyApi } from "../src/contracts";
import { agencyHost, displayFromQuery } from "../src/host/agencyHost";

describe("agencyHost (typed window.agency)", () => {
  it("reads display bounds from the query string, else falls back", () => {
    const fb = { x: 0, y: 0, width: 10, height: 10 };
    expect(displayFromQuery("?display=2&x=-1440&y=0&w=1440&h=900&scale=2", fb)).toEqual({
      x: -1440,
      y: 0,
      width: 1440,
      height: 900,
    });
    expect(displayFromQuery("?display=2", fb)).toBe(fb);
  });

  it("maps Help, Stop, Home and native calls onto AgencyApi", async () => {
    const api = {
      native: { call: vi.fn().mockResolvedValue({ ok: true }) },
      lifeline: { help: vi.fn().mockResolvedValue({ delivered: true }), signal: vi.fn() },
      stopAll: vi.fn().mockResolvedValue({}),
      showHome: vi.fn(),
    } as unknown as AgencyApi;
    const host = agencyHost(api, { x: 0, y: 0, width: 1, height: 1 });
    host.lifeline({ type: "lifeline.help", source: "help_button" });
    host.lifeline({ type: "lifeline.surface" });
    host.stopAll();
    host.home();
    await host.native("ax.press", { targetId: "a" });
    expect(api.lifeline.help).toHaveBeenCalledWith("help_button", undefined);
    expect(api.lifeline.signal).not.toHaveBeenCalled(); // main surfaces the shell itself
    expect(api.stopAll).toHaveBeenCalledTimes(1);
    expect(api.showHome).toHaveBeenCalledTimes(1);
    expect(api.native.call).toHaveBeenCalledWith("ax.press", { targetId: "a" });
  });
});
