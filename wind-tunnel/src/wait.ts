import type { SovereignClient } from './client.js'

/**
 * Wait until `threadId` reports idle over WS. The thread filter matters: an
 * unfiltered wait ends on any thread's idle, and the scenario then asserts
 * before its own turn finishes.
 */
export async function waitForThreadIdle(
  client: SovereignClient,
  threadId: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    await client.waitForWs('chat.status', timeoutMs, (d) => d.threadId === threadId && d.status === 'idle')
    return true
  } catch {
    return false
  }
}
