import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NativeEvent } from "@agency/contracts";
import { NativeRpcClient, RpcError } from "../src/main/jsonrpc";

describe("NativeRpcClient", () => {
  it("correlates responses split across chunks and in any order", async () => {
    const sent: string[] = [];
    const client = new NativeRpcClient(() => undefined);
    client.attach({ write: (l) => sent.push(l) });
    const a = client.call("apps.frontmost", {});
    const b = client.call("input.stopAll", {});
    const [ra, rb] = sent.map((l) => JSON.parse(l) as { id: number; method: string });
    expect(ra!.method).toBe("apps.frontmost");
    const reply =
      JSON.stringify({ jsonrpc: "2.0", id: rb!.id, result: { ok: true } }) +
      "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: ra!.id, result: { app: null } }) +
      "\n";
    client.receive(reply.slice(0, 10));
    client.receive(reply.slice(10));
    await expect(b).resolves.toEqual({ ok: true });
    await expect(a).resolves.toEqual({ app: null });
  });

  it("rejects on errors, timeouts and detach", async () => {
    const sent: string[] = [];
    const client = new NativeRpcClient(() => undefined, 20);
    client.attach({ write: (l) => sent.push(l) });
    const err = client.call("ax.press", { targetId: "x" });
    const id = (JSON.parse(sent[0]!) as { id: number }).id;
    client.receive(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "nope" } }) + "\n");
    await expect(err).rejects.toBeInstanceOf(RpcError);
    await expect(client.call("apps.frontmost", {})).rejects.toThrow(/timed out/);
    const pending = client.call("apps.frontmost", {}, 10_000);
    client.detach();
    await expect(pending).rejects.toThrow(/stopped/);
    await expect(client.call("apps.frontmost", {})).rejects.toThrow(/not running/);
  });

  it("delivers notifications as NativeEvents and ignores garbage", () => {
    const events: NativeEvent[] = [];
    const client = new NativeRpcClient((e) => events.push(e));
    client.receive("not json\n");
    client.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "targets-changed", owner: "com.apple.finder" },
      }) + "\n",
    );
    expect(events).toEqual([{ type: "targets-changed", owner: "com.apple.finder" }]);
  });

  it("talks to the fake native helper over real stdio", async () => {
    const child = spawn(process.execPath, [join(__dirname, "..", "fakes", "fake-native.cjs")], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const events: NativeEvent[] = [];
    const client = new NativeRpcClient((e) => events.push(e));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => client.receive(c));
    client.attach({ write: (l) => child.stdin.write(l) });
    try {
      await expect(client.call("input.stopAll", {})).resolves.toEqual({ ok: true });
      const snap = await client.call("ax.targets", { maxCount: 10 });
      expect(snap.targets.length).toBeGreaterThan(0);
      await expect(client.call("ax.press", { targetId: snap.targets[0]!.id })).resolves.toEqual({ ok: true });
      // It can't open apps, so it says so instead of reporting a success while nothing opens.
      for (const method of ["apps.launch", "apps.activate"] as const) {
        const r = await client.call(method, { bundleId: "com.apple.Music" });
        expect(r.ok).toBe(false);
        expect((r as { error?: string }).error).toMatch(/stand-in macOS helper/);
      }
      await new Promise((r) => setTimeout(r, 300));
      expect(events.some((e) => e.type === "frontmost-changed")).toBe(true);
    } finally {
      child.kill();
    }
  });
});
