import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // src is the primary root. `@test/*` is separate so a test importing a
      // fake is visibly different from production code reaching into test/
      // (AGENT.md: nothing in src/ may import from test/).
      "@test": fileURLToPath(new URL("./test", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Fakes are deterministic by design (AGENT.md). No test may rely on timing
    // or wall-clock, so a flaky run means a real bug, not a slow machine.
    globals: false,
    clearMocks: true,
  },
});