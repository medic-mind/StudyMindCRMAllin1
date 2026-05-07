// Playwright config for StudyMind CRM E2E tests.
// Tests live in __tests__/e2e. Chromium-only to keep CI fast.
// Local: spins up `pnpm --filter @studymind/web dev` unless E2E_REUSE_SERVER is set.

import { defineConfig, devices } from '@playwright/test'

const isCI = !!process.env.CI
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const reuseServer = !!process.env.E2E_REUSE_SERVER

export default defineConfig({
  testDir: './__tests__/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: reuseServer
    ? undefined
    : {
        command: 'pnpm --filter @studymind/web dev',
        url: baseURL,
        reuseExistingServer: !isCI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
})
