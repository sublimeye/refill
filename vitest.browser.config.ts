import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

// Real-DOM tests (ADR 0019). Separate from vitest.config.ts so `pnpm test` stays Node-only.
export default defineConfig({
  test: {
    include: ["tests/browser/**/*.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
