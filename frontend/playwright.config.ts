import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  use: { baseURL: 'http://127.0.0.1:5187', headless: true },
  webServer: {
    env: { PROTOCOL_CONFIG: '../config/examples/local.json' },
    command: 'npm run dev -- --host 127.0.0.1 --port 5187 --strictPort',
    url: 'http://127.0.0.1:5187',
    reuseExistingServer: false,
  },
});
