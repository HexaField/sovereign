// S4: Presence Threads — verify auto-creation of both presence threads
// (internal + gateway), presence endpoint, and correct thread roles.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

export const s4Presence: Scenario = {
  id: 's4',
  name: 'Presence Threads',
  description: 'Verify auto-creation and lookup of internal + gateway presence threads',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. Query presence thread endpoint
    const presence = await client.timed('presence-lookup', () => client.presenceThreads())
    metrics.presenceResponse = presence

    const hasInternal = presence?.internal?.id != null
    const hasGateway = presence?.gateway?.id != null
    metrics.hasInternal = hasInternal
    metrics.hasGateway = hasGateway

    if (!hasInternal) {
      return {
        passed: false,
        summary: 'internal presence thread missing',
        metrics,
        samples: client.samples
      }
    }

    if (!hasGateway) {
      return {
        passed: false,
        summary: 'gateway presence thread missing',
        metrics,
        samples: client.samples
      }
    }

    // 2. Read both threads directly and verify roles
    const internalThread = await client.timed('get-internal', () => client.getThread(presence.internal.id))
    const gatewayThread = await client.timed('get-gateway', () => client.getThread(presence.gateway.id))

    metrics.internalLabel = internalThread?.label
    metrics.gatewayLabel = gatewayThread?.label
    metrics.internalPresence = internalThread?.presence
    metrics.gatewayPresence = gatewayThread?.presence

    if (internalThread?.presence !== 'internal') {
      return {
        passed: false,
        summary: `internal thread has wrong presence role: "${internalThread?.presence}"`,
        metrics,
        samples: client.samples
      }
    }

    if (gatewayThread?.presence !== 'gateway') {
      return {
        passed: false,
        summary: `gateway thread has wrong presence role: "${gatewayThread?.presence}"`,
        metrics,
        samples: client.samples
      }
    }

    // 3. Verify they appear in the full thread list
    const allThreads = await client.timed('list-all', () => client.listThreads())
    const internalInList = allThreads.some((t: any) => t.id === presence.internal.id)
    const gatewayInList = allThreads.some((t: any) => t.id === presence.gateway.id)

    if (!internalInList || !gatewayInList) {
      return {
        passed: false,
        summary: 'presence thread(s) missing from thread list',
        metrics,
        samples: client.samples
      }
    }

    return {
      passed: true,
      summary: `both presence threads verified — internal="${internalThread.label}" gateway="${gatewayThread.label}"`,
      metrics,
      samples: client.samples
    }
  }
}
