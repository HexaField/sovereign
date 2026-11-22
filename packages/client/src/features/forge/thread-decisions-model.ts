// A thread's own decisions: the ones addressed to it, gathered from every
// membrane (a decision can sit in a membrane other than its thread's).

import type { Decision, DecisionDelivery } from '@sovereign/core'
import type { ForgeApi } from './api.js'
import { openCount } from './decisions-model.js'

/** Every decision (open and resolved) addressed to the thread, newest first. */
export const decisionsOfThread = (all: Decision[], threadId: string | null | undefined): Decision[] =>
  threadId ? all.filter((d) => d.threadId === threadId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []

/** How many open decisions wait on the thread. */
export const openCountForThread = (all: Decision[], threadId: string | null | undefined): number =>
  openCount(decisionsOfThread(all, threadId))

/**
 * The Decisions view writes with one membrane. A thread's list can span several, so
 * this api sends each write to the membrane its decision lives in and merges the results.
 */
export function routeDecisionWrites(api: ForgeApi, decisions: () => Decision[]): ForgeApi {
  const membraneOf = (id: string, fallback: string): string =>
    decisions().find((d) => d.id === id)?.membrane ?? fallback
  const byMembrane = <T extends { id: string }>(items: T[], fallback: string): Map<string, T[]> => {
    const m = new Map<string, T[]>()
    for (const item of items) {
      const key = membraneOf(item.id, fallback)
      m.set(key, [...(m.get(key) ?? []), item])
    }
    return m
  }
  return {
    ...api,
    updateDecision: (membrane, id, patch) => api.updateDecision(membraneOf(id, membrane), id, patch),
    groupDecisions: async (membrane, ids, patch) => {
      const out: Decision[] = []
      for (const [m, items] of byMembrane(
        ids.map((id) => ({ id })),
        membrane
      ))
        out.push(
          ...(await api.groupDecisions(
            m,
            items.map((i) => i.id),
            patch
          ))
        )
      return out
    },
    resolveDecisions: async (body) => {
      const resolved: Decision[] = []
      const deliveries: DecisionDelivery[] = []
      for (const [membrane, items] of byMembrane(body.items, body.membrane)) {
        const res = await api.resolveDecisions({ membrane, items })
        resolved.push(...res.resolved)
        deliveries.push(...res.deliveries)
      }
      return { resolved, deliveries }
    }
  }
}
