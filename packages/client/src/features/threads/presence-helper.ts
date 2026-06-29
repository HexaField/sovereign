// Presence-thread helpers for un-targeted client sends (voice, ambient
// surfaces). Two threads play roles in the presence system:
//   • internal — ambient inbound (voice, AD4M) lands here, agent's stream-of-
//                consciousness. Used as the routing target when no specific
//                thread is focused.
//   • gateway  — the user's primary text-chat surface with Hex.
// See plans/presence-thread-spec.md.

interface PresenceThreads {
  internalId: string | null
  gatewayId: string | null
}

let cached: PresenceThreads | undefined = undefined
let inflight: Promise<PresenceThreads> | null = null

async function fetchOnce(): Promise<PresenceThreads> {
  if (cached) return cached
  if (inflight) return inflight
  inflight = (async () => {
    const empty: PresenceThreads = { internalId: null, gatewayId: null }
    try {
      const res = await fetch('/api/threads/presence')
      if (!res.ok) {
        cached = empty
        return empty
      }
      const data = await res.json()
      const result: PresenceThreads = {
        internalId: (data?.internal?.id as string | undefined) ?? null,
        gatewayId: (data?.gateway?.id as string | undefined) ?? null
      }
      cached = result
      return result
    } catch {
      cached = empty
      return empty
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Internal presence thread id — ambient inbound target (voice, AD4M). */
export async function getPresenceInternalThreadId(): Promise<string | null> {
  return (await fetchOnce()).internalId
}

/** Gateway presence thread id — user's primary text-chat surface. */
export async function getPresenceGatewayThreadId(): Promise<string | null> {
  return (await fetchOnce()).gatewayId
}

/** Reset cache — when threads are recreated or roles change mid-session. */
export function resetPresenceThreadCache(): void {
  cached = undefined
  inflight = null
}
