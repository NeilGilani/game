import { describe, expect, it } from "vitest";
import { runEval } from "../evals/harness";
import { TASKS } from "../evals/tasks";

// Every task runs through the real provider classes with fake transports in each provider's wire format,
// and once straight into the runtime.
for (const wire of ["gemini", "anthropic", "neutral"] as const) {
  describe(`eval suite (scripted turns, ${wire} wire format)`, () => {
    for (const task of TASKS) {
      it(`${task.category}: ${task.id}`, async () => {
        const { metrics, run } = await runEval(task, { wire });
        expect(metrics.consequentialWithoutApproval).toBe(0);
        expect(metrics.protocolViolations).toBe(0);
        expect(
          metrics.success,
          `${task.id}: ${metrics.outcome}\n${JSON.stringify(run.audit.all().slice(-6), null, 1)}`,
        ).toBe(true);
      });
    }
  });
}
