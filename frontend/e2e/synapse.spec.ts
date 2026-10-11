import { expect, test } from "@playwright/test";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());
test.beforeEach(async ({ context, page }) => {
  await context.addInitScript(() => localStorage.setItem("agency.onboarded", "1"));
  await page.route("**/api/synapse/status", (route) =>
    route.fulfill({
      json: {
        state: "ready",
        device: "mps",
        execution_mode: "local",
        network: { state: "CONGESTED", source: "mock", network_cap: 0.4 },
      },
    }),
  );
});

test("Ask accepts any question, streams the answer and displays actual kernel weights", async ({ page }) => {
  const seen: unknown[] = [];
  await page.route("**/api/synapse/questions", async (route) => {
    seen.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "application/x-ndjson",
      body:
        [
          {
            event: "token_fusion",
            weights: { medical: 0.24, legal: 0.16 },
            ideal_weights: { medical: 0.6, legal: 0.4 },
            network_cap: 0.4,
            network: { state: "CONGESTED" },
          },
          { event: "token", text: "Ask your clinician", tokens: 5, tokens_per_second: 25 },
          {
            event: "response",
            text: "Ask your clinician about your next appointment.",
            tokens: 10,
            tokens_per_second: 25,
            finish_reason: "eos",
          },
          { event: "complete", base_restored: true, timing: { comparison_wall_ms: 500, restore_ms: 8 } },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
    });
  });
  await page.goto("/#/");
  await page.getByRole("button", { name: "Ask a question: Answers from Synapse-Mesh", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "No token limit" })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "No token limit" }).check();
  await page
    .getByRole("textbox", { name: "Your question" })
    .fill("What should I ask at my next appointment?");
  await page.getByRole("button", { name: "Answer my question" }).click();
  await expect(page.locator(".ask-answer")).toHaveText("Ask your clinician about your next appointment.");
  await expect(page.locator(".ask-controls").getByText("Answer ready", { exact: true })).toBeVisible();
  await page.getByText("Specialists contributing to this answer", { exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "medical" })).toContainText("24.0%");
  await expect(page.getByRole("row").filter({ hasText: "medical" })).toContainText("60.0%");
  await expect(page.getByText("Kernel confirmed: base weights restored.")).toBeVisible();
  expect(seen).toEqual([{ question: "What should I ask at my next appointment?", max_new_tokens: null }]);
  await page.getByRole("checkbox", { name: "No token limit" }).uncheck();
  await page.getByRole("spinbutton", { name: "Answer token limit" }).fill("128");
  await page.getByRole("button", { name: "Answer my question" }).click();
  await expect.poll(() => seen.length).toBe(2);
  expect(seen[1]).toEqual({ question: "What should I ask at my next appointment?", max_new_tokens: 128 });
});

test("kernel errors keep the partial answer and never show Answer ready", async ({ page }) => {
  await page.route("**/api/synapse/questions", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"event":"token","text":"Partial answer"}\n{"event":"error","message":"Kernel disconnected"}\n',
    }),
  );
  await page.goto("/#/ask");
  await page.getByRole("textbox", { name: "Your question" }).fill("Question");
  await page.getByRole("button", { name: "Answer my question" }).click();
  await expect(page.locator(".ask-answer")).toHaveText("Partial answer");
  await expect(page.locator(".ask-controls").getByText("Answer interrupted", { exact: true })).toBeVisible();
  await expect(page.getByText("Answer ready", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Answer my question" })).toBeEnabled();
});

test("Stop cancels a pending answer and permits another question", async ({ page }) => {
  let requests = 0;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/synapse/questions", async (route) => {
    requests += 1;
    await waiting;
    await route.abort().catch(() => undefined);
  });
  await page.goto("/#/ask");
  await page.getByRole("textbox", { name: "Your question" }).fill("Explain a topic");
  await page.getByRole("button", { name: "Answer my question" }).click();
  await page.getByRole("button", { name: "Stop answer" }).click();
  release?.();
  await expect(page.getByText("Answer stopped", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Answer my question" })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Your question" })).toBeEnabled();
  expect(requests).toBe(1);
});
