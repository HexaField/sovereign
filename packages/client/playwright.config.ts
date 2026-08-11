import { defineConfig, devices } from '@playwright/test'

// ── E2E isolation ──────────────────────────────────────────────────────
// Must match the port in e2e/setup/global-setup.ts. The test server binds
// here with a fully isolated config + data dir — never port 5801.
const E2E_PORT = 5899
const E2E_API = `http://127.0.0.1:${E2E_PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './e2e/setup/global-setup.ts',
  globalTeardown: './e2e/setup/global-teardown.ts',
  use: {
    baseURL: 'https://localhost:3000',
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'mobile',
      use: { ...devices['iPhone 14'] }
    }
  ],
  webServer: {
    command: 'npx vite --mode test',
    url: 'https://localhost:3000',
    reuseExistingServer: !process.env.CI,
    ignoreHTTPSErrors: true,
    timeout: 30_000,
    // Route the Vite dev proxy to the isolated test server, not production.
    // vite.config.ts reads SOVEREIGN_E2E_API to set the proxy target.
    env: {
      SOVEREIGN_E2E_API: E2E_API
    }
  }
})
