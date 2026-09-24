import type { SovereignClient } from './client.js'

/** Both idles of a pair leave the server back to back; this window absorbs the second. */
const ECHO_WINDOW_MS = 150

/**
 * Wait until `threadId` reports idle over WS.
 *
 * Two traps make a naive wait end before the turn does:
 * - Any thread's idle matches an unfiltered wait, so filter on the thread.
 * - Idles arrive in pairs: chat synthesizes one per assistant turn and the
 *   backend sends its own. The second stays buffered and ends the NEXT
 *   turn's wait at once, so absorb it here.
 */
export async function waitForThreadIdle(
  client: SovereignClient,
  threadId: string,
  timeoutMs: number
): Promise<boolean> {
  const isIdle = (d: any) => d.threadId === threadId && d.status === 'idle'
  try {
    await client.waitForWs('chat.status', timeoutMs, isIdle)
  } catch {
    return false
  }
  await new Promise((r) => setTimeout(r, ECHO_WINDOW_MS))
  client.drainWs('chat.status', isIdle)
  return true
}
