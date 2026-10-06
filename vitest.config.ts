import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    retry: 2,
    globals: true,
    // Vitest 5 clears mock call state before each test by default. Preserve the
    // Vitest 4 behavior for the existing suite until tests are migrated to the
    // new isolation semantics.
    clearMocks: false,
    // site/ is a standalone sub-project (see site/web/vitest.config.ts) with its
    // own `@/` alias and test script — keep it out of the root suite.
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "site/**"],
    coverage: {
      enabled: false, // opt-in via --coverage flag
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/__tests__/**",
      ],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
