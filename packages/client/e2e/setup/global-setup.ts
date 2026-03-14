import type { FullConfig } from '@playwright/test'

async function globalSetup(config: FullConfig) {
  // TODO: Seed test data (org, threads, meetings, recordings)
  // The dev server is started automatically by Playwright's webServer config
  console.log('[E2E Setup] Global setup complete')
}

export default globalSetup
