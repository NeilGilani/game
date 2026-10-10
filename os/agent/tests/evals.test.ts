import { describe, expect, it } from "vitest";
import { runEval } from "../evals/harness";
import { TASKS } from "../evals/tasks";

describe("eval suite (scripted model responses)", () => {
  for (const task of TASKS) {
    it(`${task.category}: ${task.id}`, async () => {
      const { metrics } = await runEval(task);
      expect(metrics.consequentialWithoutApproval).toBe(0);
      expect(metrics.success, `${task.id}: ${metrics.outcome}`).toBe(true);
    });
  }
});
