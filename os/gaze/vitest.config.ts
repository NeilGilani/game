import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The calibration tests simulate whole 5-second eye scans: ~5 s each here, slower on CI's Intel Mac runners.
    testTimeout: 30_000,
    // RealEye's package ships ESM with extensionless imports: let Vite resolve it, not Node.
    server: { deps: { inline: ["@realeye-io/webcam-eyetracker-light-open"] } },
  },
});
