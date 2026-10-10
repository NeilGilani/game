import { defineConfig } from "vitest/config";

// Benchmarks are plain scripts run through Vitest (for TypeScript without a build step).
// They print tables and write JSON to bench/results/. See BENCHMARKS.md.
export default defineConfig({
  test: { include: ["bench/**/*.bench.ts"], environment: "node", testTimeout: 600_000 },
});
