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
  // Each workflow group uses a fresh database and independent server. This
  // keeps fixtures isolated as coverage grows without bypassing auth limits.
  projects: [
    { name: 'operations', testMatch: /(?:accessibility|identity|operations|scheduling)\.spec\.ts/ },
    {
      name: 'care',
      testMatch: /(?:clinic|patient|clinical-workflows|patient-workflows)\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5184' },
    },
  ],
  webServer: [
    {
      command: 'node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5183',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3012 E2E_VITE_PORT=5184 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5184',
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
