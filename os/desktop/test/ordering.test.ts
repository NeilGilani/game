import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeHost } from "../src/main/bridge";
import { ORDERING_DEFAULT, parseOrdering, readOrdering, writeOrdering } from "../src/main/ordering";
import { quietLog } from "./helpers";

describe("Order for real: the setting main writes for the agent", () => {
  it("accepts only an on/off and a cap from $5 to $500", () => {
    expect(parseOrdering({ enabled: true, maxOrder: 60 })).toEqual({ enabled: true, maxOrder: 60 });
    expect(parseOrdering({ enabled: false, maxOrder: 42.499 })).toEqual({ enabled: false, maxOrder: 42.5 });
    for (const bad of [
      null,
      "on",
      { enabled: "true", maxOrder: 60 },
      { enabled: true },
      { enabled: true, maxOrder: 0 },
      { enabled: true, maxOrder: 4 },
      { enabled: true, maxOrder: 10_000 },
      { enabled: true, maxOrder: Number.NaN },
      { enabled: true, maxOrder: "60" },
    ])
      expect(parseOrdering(bad), JSON.stringify(bad)).toBeNull();
  });

  it("is off by default and when the file is missing or broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-ord-"));
    const file = join(dir, "agent-settings.json");
    expect(readOrdering(file)).toEqual(ORDERING_DEFAULT);
    expect(ORDERING_DEFAULT.enabled).toBe(false);
    writeFileSync(file, "{not json");
    expect(readOrdering(file)).toEqual(ORDERING_DEFAULT);
    writeFileSync(file, JSON.stringify({ realOrdering: { enabled: true, maxOrder: 9999 } }));
    expect(readOrdering(file)).toEqual(ORDERING_DEFAULT);
  });

  it("writes only its own key, keeps a caregiver's other limits, and is private to the user", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-ord-"));
    const file = join(dir, "agent-settings.json");
    writeFileSync(file, JSON.stringify({ maxPurchasePerDay: 80 }));
    writeOrdering(file, { enabled: true, maxOrder: 45 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      maxPurchasePerDay: 80,
      realOrdering: { enabled: true, maxOrder: 45 },
    });
    expect(readOrdering(file)).toEqual({ enabled: true, maxOrder: 45 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("BridgeHost page reads for the ordering pack", () => {
  function host(nodes: unknown[]) {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const h = new BridgeHost({
      dir: "/nonexistent",
      hostScript: null,
      runtime: process.execPath,
      install: false,
      log: quietLog(),
      onTargets: () => undefined,
      onStopped: () => undefined,
    });
    const server = {
      connection: "ready",
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "tabs.list") return { data: [{ tabId: 2, active: true }], origin: "", url: "" };
        if (method === "page.tree")
          return {
            data: { url: "https://www.doordash.com/", title: "DoorDash", nodes },
            origin: "https://www.doordash.com",
            url: "https://www.doordash.com/",
            suspectedInjection: [],
          };
        return { done: true };
      },
    };
    (h as unknown as { server: typeof server }).server = server;
    return { h, calls };
  }

  it("passes link addresses (http and https only), checked state, depth and list options", async () => {
    const { h } = host([
      { ref: "a", role: "link", name: "Thai Basil", href: "https://www.doordash.com/store/1/", state: {}, depth: 2 },
      { ref: "b", role: "link", name: "Bad", href: "javascript:alert(1)", state: {} },
      { ref: "c", role: "radio", name: "Chicken", state: { checked: true } },
      { ref: "d", role: "checkbox", name: "Mixed", state: { checked: "mixed" } },
      { ref: "e", role: "combobox", name: "Qty", value: "1", options: ["1", "2"], state: {} },
      { ref: "f", role: "textbox", name: "Card", value: "4242", state: { secure: true } },
    ]);
    const snap = (await h.agentCall("snapshot", {})) as { nodes: Record<string, unknown>[]; simulated: boolean };
    expect(snap.simulated).toBe(false);
    expect(snap.nodes).toEqual([
      { ref: "a", role: "link", name: "Thai Basil", href: "https://www.doordash.com/store/1/", depth: 2 },
      { ref: "b", role: "link", name: "Bad" },
      { ref: "c", role: "radio", name: "Chicken", checked: true },
      { ref: "d", role: "checkbox", name: "Mixed" },
      { ref: "e", role: "combobox", name: "Qty", value: "1", options: ["1", "2"] },
      // A secure field's value never reaches the agent.
      { ref: "f", role: "textbox", name: "Card", secure: true },
    ]);
  });

  it("chooses in a list through page.select", async () => {
    const { h, calls } = host([]);
    expect(await h.agentCall("select", { ref: "e", option: "2" })).toEqual({ ok: true });
    expect(calls.find((c) => c.method === "page.select")?.params).toEqual({ tabId: 2, ref: "e", option: "2" });
  });
});
