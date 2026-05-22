import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  webServer: {
    command: "pnpm dev",
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: { baseURL: "http://localhost:5173" },
  // Tests intentionally mutate the same in-process state (cookie jar, route
  // mocks). Run serially to keep them deterministic.
  workers: 1,
});
