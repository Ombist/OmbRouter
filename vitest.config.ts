import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/integration/**"],
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
});
