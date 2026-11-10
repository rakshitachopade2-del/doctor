import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:5183',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    ...(process.env.CI ? {} : { channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' }),
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:5183',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
