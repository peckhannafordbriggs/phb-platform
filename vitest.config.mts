import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  // tsconfig.json sets jsx: "preserve" because Next does its own JSX transform.
  // Vitest has to compile it instead, or a test cannot import a .tsx file at all -
  // which is what the server-component smoke tests do. Test-only; the application
  // build is untouched.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    // Each test file truncates shared tables, so files must not overlap in time.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
