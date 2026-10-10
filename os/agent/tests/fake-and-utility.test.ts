import type { AgentEvent } from "@agency/contracts";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit";
import { FakeAgent } from "../src/fake/fakeAgent";
import { findApiKey } from "../src/model/keys";
import { hitTest, parseCombo } from "../src/tools/computer";
import { AGENT_NATIVE_METHODS, nativeOverRpc, RpcPort, settingsFromFile } from "../src/utility";

function drive(agent: FakeAgent, taskId: string, approval: "approve" | "decline" | "change") {
  const events: AgentEvent[] = [];
  let changes = 0;
  agent.onEvent((e) => {
    events.push(e);
    if (e.type === "task.question")
      queueMicrotask(
        () =>
          void agent.handle({
            type: "task.answer",
            taskId,
            questionId: e.question.id,
            optionId: e.question.options[0]!.id,
          }),
      );
    if (e.type === "approval.required") {
      const decision = approval === "change" && changes++ > 0 ? "approve" : approval;
      queueMicrotask(
        () =>
          void agent.handle({
            type: "approval.decide",
            taskId,
            decision: { approvalId: e.approval.id, fingerprint: e.approval.fingerprint, decision },
          }),
      );
    }
  });
  return events;
}

describe("FakeAgent", () => {
  it("walks the scripted task through every event type to a verified done", async () => {
    const agent = new FakeAgent({ stepDelayMs: 0 });
    const events = drive(agent, "f1", "approve");
    await agent.handle({
      type: "task.start",
      request: { id: "f1", goal: "Order my usual Friday dinner", origin: "home" },
    });
    const types = new Set(events.map((e) => e.type));
    for (const t of [
      "task.started",
      "task.plan",
      "task.step",
      "task.question",
      "approval.required",
      "task.done",
    ])
      expect(types.has(t as AgentEvent["type"])).toBe(true);
    const q = events.find((e) => e.type === "task.question");
    expect(q?.type === "task.question" && q.question.options[0]?.suggestedBecause).toBeTruthy();
    const a = events.find((e) => e.type === "approval.required");
    expect(a?.type === "approval.required" && a.approval).toMatchObject({
      kind: "purchase",
      simulated: true,
    });
    expect(events.at(-1)).toMatchObject({ type: "task.done", verified: true });
  });

  it("declining fails the task; change asks what to change and asks again", async () => {
    const a1 = new FakeAgent({ stepDelayMs: 0 });
    const e1 = drive(a1, "f2", "decline");
    await a1.handle({ type: "task.start", request: { id: "f2", goal: "x", origin: "home" } });
    expect(e1.at(-1)).toMatchObject({ type: "task.failed", recoverable: true });

    const a2 = new FakeAgent({ stepDelayMs: 0 });
    const e2 = drive(a2, "f3", "change");
    await a2.handle({ type: "task.start", request: { id: "f3", goal: "x", origin: "home" } });
    expect(e2.filter((e) => e.type === "approval.required")).toHaveLength(2);
    expect(e2.at(-1)).toMatchObject({ type: "task.done" });
  });

  it("ignores an approval with the wrong fingerprint", async () => {
    const agent = new FakeAgent({ stepDelayMs: 0 });
    const events: AgentEvent[] = [];
    agent.onEvent((e) => {
      events.push(e);
      if (e.type === "task.question")
        queueMicrotask(
          () =>
            void agent.handle({
              type: "task.answer",
              taskId: "f4",
              questionId: e.question.id,
              optionId: e.question.options[0]!.id,
            }),
        );
      if (e.type === "approval.required") {
        queueMicrotask(
          () =>
            void agent.handle({
              type: "approval.decide",
              taskId: "f4",
              decision: { approvalId: e.approval.id, fingerprint: "forged", decision: "approve" },
            }),
        );
        setTimeout(() => void agent.handle({ type: "task.stop", taskId: "f4" }), 5);
      }
    });
    await agent.handle({ type: "task.start", request: { id: "f4", goal: "x", origin: "home" } });
    expect(events.some((e) => e.type === "task.done")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "task.stopped" });
  });

  it("pauses, resumes and stops", async () => {
    const agent = new FakeAgent({ stepDelayMs: 1 });
    const events: AgentEvent[] = [];
    agent.onEvent((e) => events.push(e));
    const run = agent.handle({ type: "task.start", request: { id: "f5", goal: "x", origin: "home" } });
    await agent.handle({ type: "task.pause", taskId: "f5" });
    await new Promise((r) => setTimeout(r, 20));
    const n = events.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(events.length).toBe(n);
    await agent.handle({ type: "task.resume", taskId: "f5" });
    await new Promise((r) => setTimeout(r, 10));
    await agent.handle({ type: "stop.all" });
    await run;
    expect(events.at(-1)).toMatchObject({ type: "task.stopped", by: "person" });
  });
});

describe("utility process plumbing", () => {
  it("round-trips rpc calls and errors", async () => {
    const sent: { id: number; method: string }[] = [];
    const rpc = new RpcPort((m) => sent.push(m as { id: number; method: string }));
    const p1 = rpc.call("native", "apps.frontmost", {});
    const p2 = rpc.call("bridge", "snapshot", {});
    rpc.settle({ id: sent[0]!.id, result: { app: null } });
    rpc.settle({ id: sent[1]!.id, error: "Bridge not connected" });
    await expect(p1).resolves.toEqual({ app: null });
    await expect(p2).rejects.toThrow("Bridge not connected");
  });

  it("times out an rpc that never answers", async () => {
    const rpc = new RpcPort(() => undefined, 10);
    await expect(rpc.call("native", "ax.targets", {})).rejects.toThrow(/in time/);
  });

  it("forwards only allowlisted native methods", async () => {
    const sent: unknown[] = [];
    const native = nativeOverRpc(new RpcPort((m) => sent.push(m), 10));
    await expect(native.call("permissions.request", { kind: "camera" })).rejects.toThrow(/not available/);
    await expect(native.call("speech.say", { text: "hi" })).rejects.toThrow(/not available/);
    expect(sent).toHaveLength(0);
    expect(AGENT_NATIVE_METHODS).not.toContain("permissions.request");
  });

  it("reads caregiver settings from a file and falls back to safe defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-"));
    const file = join(dir, "s.json");
    writeFileSync(file, JSON.stringify({ maxPurchase: 25 }));
    expect(settingsFromFile(file)()).toMatchObject({ maxPurchase: 25, simulatedOnly: true });
    writeFileSync(file, "{broken");
    expect(settingsFromFile(file)()).toMatchObject({ maxPurchase: 50, simulatedOnly: true });
    expect(settingsFromFile(undefined)().simulatedOnly).toBe(true);
  });
});

describe("API key lookup", () => {
  it("prefers the environment, then the macOS keychain, else none", async () => {
    expect(await findApiKey({ ANTHROPIC_API_KEY: " sk-env " }, "darwin", async () => "sk-kc")).toEqual({
      key: "sk-env",
      source: "env",
    });
    expect(await findApiKey({}, "darwin", async () => "sk-kc\n")).toEqual({
      key: "sk-kc",
      source: "keychain",
    });
    expect(await findApiKey({}, "linux", async () => "sk-kc")).toEqual({ key: null, source: "none" });
    expect(await findApiKey({}, "darwin", async () => null)).toEqual({ key: null, source: "none" });
  });
});

describe("computer tier helpers", () => {
  it("parses key combos", () => {
    expect(parseCombo("ctrl+shift+Escape")).toEqual({ key: "Escape", modifiers: ["ctrl", "shift"] });
    expect(parseCombo("super+a")).toEqual({ key: "a", modifiers: ["cmd"] });
    expect(parseCombo("Return")).toEqual({ key: "Return", modifiers: [] });
  });
  it("hit-tests the smallest containing target", () => {
    const big = {
      id: "win",
      label: "Window",
      role: "window",
      source: "ax" as const,
      rect: { x: 0, y: 0, width: 1000, height: 1000 },
    };
    const btn = {
      id: "b",
      label: "OK",
      role: "button",
      source: "ax" as const,
      rect: { x: 10, y: 10, width: 50, height: 20 },
    };
    expect(hitTest([big, btn], 20, 20)?.id).toBe("b");
    expect(hitTest([big, btn], 500, 500)?.id).toBe("win");
    expect(hitTest([btn], 500, 500)).toBeUndefined();
  });
});

describe("AuditLog", () => {
  it("appends redacted JSON lines with owner-only permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-"));
    const file = join(dir, "audit", "a.jsonl");
    const log = new AuditLog(file, () => new Date("2026-10-10T12:00:00Z"));
    log.record({ taskId: "t", kind: "refused", message: "Typed password: hunter2 and 4242 4242 4242 4242" });
    const line = JSON.parse(readFileSync(file, "utf8").trim()) as { at: string; message: string };
    expect(line.at).toBe("2026-10-10T12:00:00.000Z");
    expect(line.message).not.toMatch(/hunter2|4242 4242/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
