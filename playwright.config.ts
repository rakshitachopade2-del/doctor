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
    {
      name: 'resources',
      testMatch: /(?:^|\/)(?:clinic-resources|resource-catalogue)\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5188' },
    },
    {
      name: 'record-search',
      testMatch: /(?:^|\/)record-search\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5189' },
    },
    {
      name: 'attendance',
      testMatch: /(?:^|\/)attendance\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5190' },
    },
    {
      name: 'visit-duration',
      testMatch: /(?:^|\/)visit-duration\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5191' },
    },
    {
      name: 'procedure-scheduling',
      testMatch: /(?:^|\/)procedure-scheduling\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5192' },
    },
    {
      name: 'follow-up-escalation',
      testMatch: /(?:^|\/)follow-up-escalation\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5193' },
    },
    {
      name: 'mfa',
      testMatch: /(?:^|\/)mfa\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5194' },
    },
    {
      name: 'procedure-catalogue',
      testMatch: /(?:^|\/)procedure-catalogue\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5195' },
    },
    {
      name: 'auth-security',
      testMatch: /(?:^|\/)auth-security\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5196' },
    },
    {
      name: 'public-library',
      testMatch: /(?:^|\/)public-library\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5197' },
    },
    {
      name: 'knowledge-authoring',
      testMatch: /(?:^|\/)knowledge-authoring\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5198' },
    },
    {
      name: 'appointment-series',
      testMatch: /(?:^|\/)appointment-series\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5199' },
    },
    {
      name: 'care-summary-copies',
      testMatch: /(?:^|\/)care-summary-copies\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5200' },
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
    {
      command: 'E2E_API_PORT=3016 E2E_VITE_PORT=5188 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5188',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3017 E2E_VITE_PORT=5189 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5189',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3018 E2E_VITE_PORT=5190 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5190',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3019 E2E_VITE_PORT=5191 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5191',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3020 E2E_VITE_PORT=5192 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5192',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3021 E2E_VITE_PORT=5193 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5193',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3022 E2E_VITE_PORT=5194 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5194',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3023 E2E_VITE_PORT=5195 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5195',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3024 E2E_VITE_PORT=5196 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5196',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command:
        'PUBLIC_SITE_ORIGIN=http://127.0.0.1:5197 PUBLIC_INDEXING_ENABLED=false E2E_API_PORT=3025 E2E_VITE_PORT=5197 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5197',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3026 E2E_VITE_PORT=5198 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5198',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3027 E2E_VITE_PORT=5199 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5199',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'E2E_API_PORT=3028 E2E_VITE_PORT=5200 node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5200',
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
