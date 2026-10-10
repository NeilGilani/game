import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/contracts";
import { PackAgent } from "../src/core/agent";
import { ApprovalViolation, checkPackDeclaration, type TaskPack } from "../src/core/pack";
import { actionFingerprint } from "../src/core/runner";
import { canonicalJson, sha256Hex } from "../src/core/sha256";

describe("sha256", () => {
  it("matches known vectors and node:crypto", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const n of [55, 56, 63, 64, 65, 1000, 100_003]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });
  it("canonical JSON ignores key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, 2] }, b: 1 }),
    );
    expect(canonicalJson({ a: [undefined] })).toBe('{"a":[null]}');
  });
  it("fingerprint changes with any detail", () => {
    const a = actionFingerprint("call", "call.place", { to: "+15550100" }, true);
    expect(actionFingerprint("call", "call.place", { to: "+15550101" }, true)).not.toBe(a);
    expect(actionFingerprint("call", "call.place", { to: "+15550100" }, false)).not.toBe(a);
  });
});

/** A tiny pack: asks, then asks approval, then runs a consequential tool. */
function demoPack(tamper?: "args" | "reuse" | "skip"): TaskPack & { effects: string[] } {
  const effects: string[] = [];
  return {
    id: "demo",
    title: "Demo",
    description: "",
    surfaces: ["home"],
    goals: ["demo"],
    tools: [
      { name: "look", description: "", risk: "read" },
      { name: "send", description: "", risk: "consequential", kind: "send" },
    ],
    policies: [{ id: "p", rule: "r" }],
    approvals: [{ kind: "send", bindsTo: ["to"] }],
    verification: [{ check: "sent" }],
    honesty: { real: [], simulated: [], untested: [] },
    effects,
    matches: (r) => (r.goal === "demo" ? 1 : 0),
    async run(ctx) {
      ctx.plan([{ id: "s1", title: "Send", risk: "consequential" }]);
      const a = await ctx.ask({
        prompt: "Who?",
        options: [
          { id: "jo", label: "Jo" },
          { id: "sam", label: "Sam" },
        ],
      });
      await ctx.exec("look", {}, async () => "ok");
      if (tamper === "skip") {
        await ctx.exec("send", { to: a.optionId }, async () => effects.push("sent"));
        return { outcome: "x", verified: false };
      }
      const ans = await ctx.approve({
        kind: "send",
        summary: `Send to ${a.optionId}`,
        details: { To: a.optionId! },
        action: { tool: "send", args: { to: a.optionId } },
      });
      if (!ans.approved) return { outcome: "Not sent", verified: true };
      const args = tamper === "args" ? { to: "mallory" } : { to: a.optionId };
      await ctx.exec("send", args, async () => effects.push(`sent:${args.to}`), ans.grant);
      if (tamper === "reuse") await ctx.exec("send", args, async () => effects.push("again"), ans.grant);
      return { outcome: "Sent", verified: true };
    },
  };
}

async function drive(pack: TaskPack, decide: "approve" | "decline" | "wrong-fingerprint" | "stop") {
  const agent = new PackAgent([pack]);
  const events: AgentEvent[] = [];
  agent.subscribe((e) => {
    events.push(e);
    if (e.type === "task.question")
      agent.send({ type: "task.answer", taskId: e.taskId, questionId: e.question.id, optionId: "jo" });
    if (e.type === "approval.required") {
      if (decide === "stop") return agent.send({ type: "stop.all" });
      agent.send({
        type: "approval.decide",
        taskId: e.taskId,
        decision: {
          approvalId: e.approval.id,
          fingerprint: decide === "wrong-fingerprint" ? "0".repeat(64) : e.approval.fingerprint,
          decision: decide === "decline" ? "decline" : "approve",
        },
      });
    }
  });
  const done = agent.start({ id: "t1", goal: "demo", origin: "home" });
  if (decide === "wrong-fingerprint") {
    await new Promise((r) => setTimeout(r, 20));
    agent.send({ type: "task.stop", taskId: "t1" });
  }
  await done;
  return { events, agent };
}

describe("PackRun approvals", () => {
  it("declaration check passes for a well-formed pack", () => {
    expect(checkPackDeclaration(demoPack())).toEqual([]);
  });
  it("runs only the approved action, once", async () => {
    const pack = demoPack();
    const { events, agent } = await drive(pack, "approve");
    expect(pack.effects).toEqual(["sent:jo"]);
    expect(events.at(-1)).toMatchObject({ type: "task.done", verified: true });
    const approval = events.find((e) => e.type === "approval.required");
    expect(approval && approval.type === "approval.required" && approval.approval.simulated).toBe(true);
    expect(agent.auditLog.map((a) => `${a.tool}:${a.result}`)).toEqual(["look:ok", "send:ok"]);
  });
  it("declined approvals do nothing", async () => {
    const pack = demoPack();
    await drive(pack, "decline");
    expect(pack.effects).toEqual([]);
  });
  it("blocks a changed action, a reused grant and a missing grant", async () => {
    for (const tamper of ["args", "reuse", "skip"] as const) {
      const pack = demoPack(tamper);
      const { events, agent } = await drive(pack, "approve");
      expect(pack.effects.filter((e) => e !== "sent:jo")).toEqual([]);
      expect(events.at(-1)?.type).toBe("task.failed");
      expect(agent.auditLog.some((a) => a.result === "blocked")).toBe(true);
    }
  });
  it("ignores a decision for a different fingerprint", async () => {
    const pack = demoPack();
    const { events } = await drive(pack, "wrong-fingerprint");
    expect(pack.effects).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "task.stopped" });
  });
  it("stop ends the task and nothing runs after it", async () => {
    const pack = demoPack();
    const { events } = await drive(pack, "stop");
    expect(pack.effects).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "task.stopped", by: "person" });
  });
  it("ApprovalViolation is a named error", () => {
    expect(new ApprovalViolation("x").name).toBe("ApprovalViolation");
  });
});
