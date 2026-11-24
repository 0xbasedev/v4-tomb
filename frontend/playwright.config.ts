import { defineConfig } from "@playwright/test";

/**
 * Browser tests run against the shipped manifest (config/networks.json), which
 * has no deployment. Every test therefore asserts the honest "not deployed"
 * state and that no wallet transaction is ever requested.
 */
const PORT = 5187;

export default defineConfig({
  testDir: "./test",
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
});
