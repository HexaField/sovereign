import type { FullConfig } from '@playwright/test'

async function globalTeardown(config: FullConfig) {
  // TODO: Clean up test data
  console.log('[E2E Teardown] Global teardown complete')
}

export default globalTeardown
