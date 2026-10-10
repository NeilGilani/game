import type { ApprovalDecision, ApprovalRequest } from "@agency/contracts";
import { describe, expect, it } from "vitest";
import { ApprovalGate, fingerprintAction } from "../src/approvals";
import { AuditLog } from "../src/audit";
import { ActionGuard, SpendLedger, type GuardContext } from "../src/guard";
import { DEFAULT_SETTINGS, type SafetySettings } from "../src/policy/settings";
import type { AgentAction } from "../src/types";

const ORIGIN = "http://shop.sandbox.agency.test";
const pay = (total = "$20.00", extra: Partial<AgentAction> = {}): AgentAction => ({
  tier: "bridge",
  op: "bridge.click",
  target: { ref: "place", label: "Place order", role: "button", origin: ORIGIN, simulated: true },
  facts: { Total: total },
  ...extra,
});

function setup(
  settings: Partial<SafetySettings> = {},
  decide: (r: ApprovalRequest) => Partial<ApprovalDecision> = () => ({}),
) {
  const gate = new ApprovalGate();
  const audit = new AuditLog();
  const guard = new ActionGuard(gate, audit, () => ({ ...DEFAULT_SETTINGS, ...settings }), new SpendLedger());
  const asked: ApprovalRequest[] = [];
  const ctx: GuardContext = {
    taskId: "t1",
    dryRun: true,
    requestApproval: async (r) => {
      asked.push(r);
      return { approvalId: r.id, fingerprint: r.fingerprint, decision: "approve", ...decide(r) };
    },
    checkpoint: async () => undefined,
  };
  return { gate, audit, guard, ctx, asked };
}

describe("ApprovalGate", () => {
  it("binds approval to the fingerprint and uses it once", () => {
    const gate = new ApprovalGate();
    const r = gate.open("t", {
      kind: "purchase",
      summary: "Pay",
      details: {},
      fingerprint: "fp1",
      simulated: true,
    });
    expect(gate.decide("t", { approvalId: r.id, fingerprint: "fp2", decision: "approve" })).toMatchObject({
      ok: false,
    });
    expect(gate.decide("t", { approvalId: r.id, fingerprint: "fp1", decision: "approve" })).toMatchObject({
      ok: true,
      status: "approved",
    });
    expect(gate.consume("t", "fp2")).toBeNull();
    expect(gate.consume("other-task", "fp1")).toBeNull();
    expect(gate.consume("t", "fp1")).toBe(r.id);
    expect(gate.consume("t", "fp1")).toBeNull();
  });
  it("rejects decisions for unknown or already decided requests", () => {
    const gate = new ApprovalGate();
    expect(gate.decide("t", { approvalId: "nope", fingerprint: "x", decision: "approve" }).ok).toBe(false);
    const r = gate.open("t", { kind: "send", summary: "", details: {}, fingerprint: "f", simulated: true });
    gate.decide("t", { approvalId: r.id, fingerprint: "f", decision: "decline" });
    expect(gate.decide("t", { approvalId: r.id, fingerprint: "f", decision: "approve" }).ok).toBe(false);
    expect(gate.consume("t", "f")).toBeNull();
  });
  it("supersedes older pending requests and revokes on stop", () => {
    const gate = new ApprovalGate();
    const a = gate.open("t", { kind: "send", summary: "", details: {}, fingerprint: "a", simulated: true });
    const b = gate.open("t", { kind: "send", summary: "", details: {}, fingerprint: "b", simulated: true });
    expect(gate.decide("t", { approvalId: a.id, fingerprint: "a", decision: "approve" }).ok).toBe(false);
    gate.decide("t", { approvalId: b.id, fingerprint: "b", decision: "approve" });
    gate.revokeTask("t");
    expect(gate.consume("t", "b")).toBeNull();
  });
  it("fingerprints change with any effect-relevant detail and ignore previews", () => {
    const base = pay();
    const fp = fingerprintAction("t", base, "purchase");
    expect(
      fingerprintAction("t", { ...base, preview: { kind: "text", data: "different" } }, "purchase"),
    ).toBe(fp);
    expect(fingerprintAction("t", pay("$20.01"), "purchase")).not.toBe(fp);
    expect(fingerprintAction("t", { ...base, input: { text: "x" } }, "purchase")).not.toBe(fp);
    expect(fingerprintAction("t2", base, "purchase")).not.toBe(fp);
    expect(
      fingerprintAction("t", { ...base, target: { ...base.target, label: "Place order " } }, "purchase"),
    ).not.toBe(fp);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ActionGuard", () => {
  it("runs reversible actions without asking", async () => {
    const { guard, ctx, asked } = setup();
    let ran = 0;
    const o = await guard.run(
      ctx,
      async () => ({ tier: "bridge", op: "bridge.click", target: { label: "Next", origin: ORIGIN } }),
      async () => ++ran,
    );
    expect(o.status).toBe("done");
    expect(ran).toBe(1);
    expect(asked).toHaveLength(0);
  });

  it("asks before a consequential action and runs it once with the approval id in the audit", async () => {
    const { guard, ctx, asked, audit } = setup();
    let ran = 0;
    const o = await guard.run(
      ctx,
      async () => pay(),
      async () => ++ran,
    );
    expect(o).toMatchObject({ status: "done" });
    expect(ran).toBe(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      kind: "purchase",
      simulated: true,
      details: { Total: "$20.00", Button: "Place order" },
    });
    expect(asked[0]!.summary).toBe(
      'Pay $20.00: "Place order" on http://shop.sandbox.agency.test (simulated).',
    );
    const entry = audit.all("t1").find((e) => e.kind === "action");
    expect(entry?.approvalId).toBe(asked[0]!.id);
    expect(entry?.fingerprint).toBe(asked[0]!.fingerprint);
  });

  it("does not run on decline or change", async () => {
    for (const decision of ["decline", "change"] as const) {
      const { guard, ctx } = setup({}, () => ({ decision, change: "the dish" }));
      let ran = 0;
      const o = await guard.run(
        ctx,
        async () => pay(),
        async () => ++ran,
      );
      expect(o.status).toBe(decision === "decline" ? "declined" : "change");
      expect(ran).toBe(0);
    }
  });

  it("rejects a decision with a forged fingerprint", async () => {
    const { guard, ctx } = setup({}, () => ({ fingerprint: "0".repeat(64) }));
    let ran = 0;
    const o = await guard.run(
      ctx,
      async () => pay(),
      async () => ++ran,
    );
    expect(o.status).toBe("refused");
    expect(ran).toBe(0);
  });

  it("re-asks when the live action changed after approval, and gives up if it keeps changing", async () => {
    let total = 20;
    const { guard, ctx, asked } = setup({}, () => {
      total += 1;
      return {};
    });
    let ran = 0;
    const o = await guard.run(
      ctx,
      async () => pay(`$${total.toFixed(2)}`),
      async () => ++ran,
    );
    expect(o.status).toBe("refused");
    expect(ran).toBe(0);
    expect(asked.length).toBe(3);
    expect(new Set(asked.map((a) => a.fingerprint)).size).toBe(3);
  });

  it("enforces spending limits per purchase and per day", async () => {
    const one = setup({ maxPurchase: 10 });
    expect(
      (
        await one.guard.run(
          one.ctx,
          async () => pay("$20.00"),
          async () => 1,
        )
      ).status,
    ).toBe("refused");
    expect(one.asked).toHaveLength(0);

    const day = setup({ maxPurchase: 50, maxPurchasePerDay: 30 });
    expect(
      (
        await day.guard.run(
          day.ctx,
          async () => pay("$20.00"),
          async () => 1,
        )
      ).status,
    ).toBe("done");
    expect(
      (
        await day.guard.run(
          day.ctx,
          async () => pay("$15.00"),
          async () => 1,
        )
      ).status,
    ).toBe("refused");

    const off = setup({ maxPurchase: null });
    expect(
      (
        await off.guard.run(
          off.ctx,
          async () => pay(),
          async () => 1,
        )
      ).status,
    ).toBe("refused");
  });

  it("refuses a purchase whose total it can't read", async () => {
    const { guard, ctx } = setup();
    const o = await guard.run(
      ctx,
      async () => pay("$20.00", { facts: {} }),
      async () => 1,
    );
    expect(o).toMatchObject({ status: "refused" });
  });

  it("uses the higher of the page total and the claimed amount", async () => {
    const { guard, ctx } = setup({ maxPurchase: 30 });
    const o = await guard.run(
      ctx,
      async () => pay("$20.00", { claim: { amount: 45 } }),
      async () => 1,
    );
    expect(o.status).toBe("refused");
  });

  it("refuses consequential actions on real targets in simulated mode", async () => {
    const { guard, ctx } = setup();
    const real = pay();
    real.target = { ...real.target, simulated: false };
    expect(
      (
        await guard.run(
          ctx,
          async () => real,
          async () => 1,
        )
      ).status,
    ).toBe("refused");
  });

  it("allows real consequential actions only when simulatedOnly is off and the task is not a dry run", async () => {
    const { guard, ctx } = setup({ simulatedOnly: false, siteAllowlist: ["https://shop.example.com"] });
    ctx.dryRun = false;
    const real: AgentAction = {
      ...pay(),
      target: { ref: "place", label: "Place order", origin: "https://shop.example.com", simulated: false },
    };
    expect(
      (
        await guard.run(
          ctx,
          async () => real,
          async () => 1,
        )
      ).status,
    ).toBe("done");
  });

  it("refuses typing secrets and hides them in the audit trail", async () => {
    const { guard, ctx, audit } = setup();
    const o1 = await guard.run(
      ctx,
      async () => ({
        tier: "bridge",
        op: "bridge.type",
        target: { label: "Password", origin: ORIGIN, secure: true },
        input: { text: "hunter2" },
      }),
      async () => 1,
    );
    const o2 = await guard.run(
      ctx,
      async () => ({
        tier: "bridge",
        op: "bridge.type",
        target: { label: "Note", origin: ORIGIN },
        input: { text: "4242424242424242" },
      }),
      async () => 1,
    );
    expect([o1.status, o2.status]).toEqual(["refused", "refused"]);
    expect(JSON.stringify(audit.all())).not.toMatch(/hunter2|4242424242424242/);
  });

  it("refuses sites outside the allowlist, for actions and navigation", async () => {
    const { guard, ctx } = setup();
    expect(
      (
        await guard.run(
          ctx,
          async () => ({ tier: "bridge", op: "bridge.navigate", input: { url: "https://evil.example.com" } }),
          async () => 1,
        )
      ).status,
    ).toBe("refused");
    expect(
      (
        await guard.run(
          ctx,
          async () => ({
            tier: "bridge",
            op: "bridge.click",
            target: { label: "Next", origin: "https://evil.example.com" },
          }),
          async () => 1,
        )
      ).status,
    ).toBe("refused");
  });

  it("requires the AI disclosure on sends", async () => {
    const { guard, ctx, asked } = setup();
    const send: AgentAction = {
      tier: "bridge",
      op: "bridge.click",
      target: { label: "Send", origin: ORIGIN, simulated: true },
      facts: { "AI disclosure": "missing" },
    };
    expect(
      (
        await guard.run(
          ctx,
          async () => send,
          async () => 1,
        )
      ).status,
    ).toBe("refused");
    expect(asked).toHaveLength(0);
  });

  it("stops at the checkpoint", async () => {
    const { guard, ctx } = setup();
    ctx.checkpoint = async () => {
      throw new Error("stopped");
    };
    let ran = 0;
    await expect(
      guard.run(
        ctx,
        async () => pay(),
        async () => ++ran,
      ),
    ).rejects.toThrow("stopped");
    expect(ran).toBe(0);
  });
});
