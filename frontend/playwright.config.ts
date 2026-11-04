import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for the reconciled frontend. Preview mode is the default
 * while config/masonry-deployments.json is empty, so every UI test runs on
 * simulated data and asserts that no wallet transaction is ever requested.
 *
 *   pnpm test:browser            all projects
 *   pnpm test:browser --project=mobile
 */
const PORT = 5187;

export default defineConfig({
  testDir: "./test",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true, trace: "retain-on-failure" },
  projects: [
    { name: "model", testMatch: /model\.spec\.ts/ },
    { name: "desktop", testMatch: /ui\.spec\.ts/, use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", testMatch: /(ui|mobile)\.spec\.ts/, use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
