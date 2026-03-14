import type { FullConfig } from '@playwright/test'
import fs from 'node:fs'
import type { ChildProcess } from 'node:child_process'

async function globalTeardown(config: FullConfig) {
  const serverProcess = (globalThis as any).__E2E_SERVER_PROCESS as ChildProcess | undefined
  const tempDir = (globalThis as any).__E2E_TEMP_DIR as string | undefined

  if (serverProcess && !serverProcess.killed) {
    console.log('[E2E Teardown] Killing server process')
    serverProcess.kill('SIGTERM')
    // Give it a moment to clean up
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (!serverProcess.killed) {
      serverProcess.kill('SIGKILL')
    }
  }

  if (tempDir) {
    console.log(`[E2E Teardown] Removing temp dir: ${tempDir}`)
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch (err) {
      console.warn('[E2E Teardown] Failed to remove temp dir:', err)
    }
  }

  console.log('[E2E Teardown] Complete')
}

export default globalTeardown
