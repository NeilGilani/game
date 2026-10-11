import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // RealEye's package ships ESM with extensionless imports: let Vite resolve it, not Node.
    server: { deps: { inline: ["@realeye-io/webcam-eyetracker-light-open"] } },
  },
});
