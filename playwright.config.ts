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
    {
      name: 'operations',
      testMatch:
        /(?:^|\/)(?:accessibility|identity|operations|scheduling|waitlist|procedure-billing)\.spec\.ts/,
    },
    {
      name: 'care',
      testMatch:
        /(?:^|\/)(?:clinic|patient|clinical-workflows|patient-workflows|follow-up|patient-follow-up|activity|patient-waitlist)\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5184' },
    },
    {
      name: 'reporting',
      testMatch: /(?:^|\/)(?:insights|expenses|inventory|billing-corrections)\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5185' },
    },
    {
      name: 'records',
      testMatch:
        /(?:^|\/)(?:image-annotations|patient-image-annotations|care-summary|patient-profile)\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5186' },
    },
    {
      name: 'investigations',
      testMatch: /(?:^|\/)investigation-(?:worklist|navigation)\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5187' },
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
    {
      command: 'E2E_API_PORT=3013 E2E_VITE_PORT=5185 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5185',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3014 E2E_VITE_PORT=5186 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5186',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3015 E2E_VITE_PORT=5187 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5187',
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
