import { afterEach, describe, expect, it, vi } from "vitest";
import { apps, NEEDS_MAC_APP, resetAppsForTests } from "../src/state/native";

type Call = { method: string; params: unknown };

function fakeHost(answers: Record<string, (params: unknown) => unknown>) {
  const calls: Call[] = [];
  const agency = {
    role: "shell",
    agent: { send: () => {}, onEvent: () => () => {} },
    native: {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        const answer = answers[method];
        if (!answer) throw new Error(`unexpected ${method}`);
        return answer(params);
      },
    },
  };
  vi.stubGlobal("window", { agency });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetAppsForTests();
});

describe("opening Mac apps", () => {
  it("in a browser, says it needs the Mac app instead of pretending", async () => {
    vi.stubGlobal("window", {});
    const source = apps();
    expect(source.simulated).toBe(true);
    expect((await source.list()).length).toBeGreaterThan(0);
    expect(await source.launch("com.apple.mail")).toEqual({ ok: false, error: NEEDS_MAC_APP });
    expect(await source.activate("com.google.Chrome")).toEqual({ ok: false, error: NEEDS_MAC_APP });
  });

  it("in the Mac app, launches through agency-native", async () => {
    const calls = fakeHost({ "apps.launch": () => ({ ok: true }) });
    expect(apps().simulated).toBe(false);
    expect(await apps().launch("com.apple.mail")).toEqual({ ok: true });
    expect(calls).toEqual([{ method: "apps.launch", params: { bundleId: "com.apple.mail" } }]);
  });

  it("switching to an open app falls back to opening it when macOS refuses the activation", async () => {
    const calls = fakeHost({ "apps.activate": () => ({ ok: false }), "apps.launch": () => ({ ok: true }) });
    expect(await apps().activate("com.google.Chrome")).toEqual({ ok: true });
    expect(calls.map((c) => c.method)).toEqual(["apps.activate", "apps.launch"]);
  });

  it("does not launch again when activation works", async () => {
    const calls = fakeHost({ "apps.activate": () => ({ ok: true }) });
    expect(await apps().activate("com.google.Chrome")).toEqual({ ok: true });
    expect(calls.map((c) => c.method)).toEqual(["apps.activate"]);
  });

  it("a refused or failed host call comes back as a readable failure, never a rejection", async () => {
    fakeHost({
      "apps.launch": () => {
        throw new Error("Error invoking remote method 'agency:native': Error: agency-native is not running");
      },
    });
    expect(await apps().launch("com.apple.mail")).toEqual({
      ok: false,
      error: "agency-native is not running",
    });
  });
});
