import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Built output mirrors src/**/*.test.ts and must not run as a second suite.
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
