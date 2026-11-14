import { defineConfig } from "@playwright/test";

/**
 * Live wallet flows against a local anvil Masonry deployment.
 *
 *   anvil --port 8545 --code-size-limit 100000 &
 *   (cd ../contracts && forge script script/DeployMasonryLocal.s.sol:DeployMasonryLocal \
 *      --rpc-url http://127.0.0.1:8545 --broadcast --disable-code-size-limit --offline \
 *      --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
 *   pnpm test:local
 *
 * Needs a FRESH anvil + deployment each run (the suite schedules Genesis once and
 * time-travels the chain; a beforeAll guard fails fast on a reused chain).
 */
const PORT = 5197;

export default defineConfig({
  testDir: "./test",
  testMatch: /local\.spec\.ts/,
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    env: { VITE_LOCAL_DEPLOYMENT: "1" },
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
