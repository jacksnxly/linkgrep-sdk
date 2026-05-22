import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["src/__tests__/setup.ts"],
    // Test files share a single MSW `setupServer` instance (src/__tests__/msw-server.ts).
    // Running files in parallel across vitest workers causes that singleton's handler
    // queue / reset cycle to interleave with other workers, producing intermittent
    // `TypeError: fetch failed` for tests that should have intercepted cleanly.
    // Disable file-level parallelism; tests inside a file still run sequentially.
    fileParallelism: false,
  },
});
