import { describe, expect, it, vi } from 'vitest'
import type { Decision } from '@sovereign/core'
import type { ForgeApi } from './api.js'
import { decisionsOfThread, openCountForThread, routeDecisionWrites } from './thread-decisions-model.js'

const d = (id: string, membrane: string, over: Partial<Decision> = {}): Decision => ({
  id,
  membrane,
  question: id,
  status: 'open',
  createdAt: `2026-01-0${id.length}T00:00:00Z`,
  ...over
})

const ALL: Decision[] = [
  d('a', 'm1', { threadId: 't1' }),
  d('bb', 'm2', { threadId: 't1' }),
  d('ccc', 'm1', { threadId: 't1', status: 'resolved' }),
  d('dddd', 'm1', { threadId: 't2' }),
  d('eeeee', 'm1')
]

describe('a thread’s decisions', () => {
  it('counts open ones across membranes, for that thread only', () => {
    expect(openCountForThread(ALL, 't1')).toBe(2)
    expect(openCountForThread(ALL, 't2')).toBe(1)
    expect(openCountForThread(ALL, 'none')).toBe(0)
    expect(openCountForThread(ALL, null)).toBe(0)
  })

  it('lists open and resolved, newest first', () => {
    expect(decisionsOfThread(ALL, 't1').map((x) => x.id)).toEqual(['ccc', 'bb', 'a'])
  })
})

describe('routeDecisionWrites', () => {
  const make = () => {
    const api = {
      updateDecision: vi.fn(async () => ALL[0]),
      groupDecisions: vi.fn(async (_m: string, ids: string[]) => ALL.filter((x) => ids.includes(x.id))),
      resolveDecisions: vi.fn(async (b: { membrane: string; items: Array<{ id: string }> }) => ({
        resolved: ALL.filter((x) => b.items.some((i) => i.id === x.id)),
        deliveries: []
      }))
    }
    return { api, routed: routeDecisionWrites(api as unknown as ForgeApi, () => ALL) }
  }

  it('sends an update to the membrane the decision lives in', async () => {
    const { api, routed } = make()
    await routed.updateDecision('m1', 'bb', { group: 'x' })
    expect(api.updateDecision).toHaveBeenCalledWith('m2', 'bb', { group: 'x' })
  })

  it('splits a resolve by membrane and merges the results', async () => {
    const { api, routed } = make()
    const res = await routed.resolveDecisions({
      membrane: 'm1',
      items: [
        { id: 'a', resolution: 'yes' },
        { id: 'bb', resolution: 'no' }
      ]
    })
    expect(api.resolveDecisions).toHaveBeenCalledWith({ membrane: 'm1', items: [{ id: 'a', resolution: 'yes' }] })
    expect(api.resolveDecisions).toHaveBeenCalledWith({ membrane: 'm2', items: [{ id: 'bb', resolution: 'no' }] })
    expect(res.resolved.map((x) => x.id).sort()).toEqual(['a', 'bb'])
  })

  it('splits a group change by membrane', async () => {
    const { api, routed } = make()
    await routed.groupDecisions('m1', ['a', 'bb'], { group: 'g' })
    expect(api.groupDecisions).toHaveBeenCalledWith('m1', ['a'], { group: 'g' })
    expect(api.groupDecisions).toHaveBeenCalledWith('m2', ['bb'], { group: 'g' })
  })
})
