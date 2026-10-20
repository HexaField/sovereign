import type { WorkNode } from '@sovereign/core'
import type { ChangeStructure } from '@sovereign/graphcoder-core/contract'
import { describe, expect, it } from 'vitest'
import { createStructureHook } from './structure.js'
import { change } from './testing.js'
import type { CachedChange } from './types.js'

const REPO = 'acme-labs/widget'
const CHECKOUTS = [{ path: '/work/widget', remote: 'origin' }]
const cached = (n: number, over: Partial<CachedChange> = {}): CachedChange => ({
  ...change(REPO, n),
  paired: [],
  ...over
})
const nodeOf = (n: number): WorkNode => ({
  id: `github:github.com/${REPO}#${n}`,
  forge: 'github',
  kind: 'change',
  title: `Change ${n}`,
  state: 'open',
  zone: 'present',
  assignees: [],
  reviewers: [],
  labels: [],
  workstreams: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z'
})

const structure = (head: string): ChangeStructure => ({
  base: 'm'.repeat(40),
  head,
  modules: [{ module: 'src/a', label: 'src/a', added: 1, removed: 0, modified: 2 }],
  symbols: {
    added: [{ id: 'x', kind: 'function', name: 'f', qualifiedName: 'f', filePath: 'src/a/f.ts' }],
    removed: [],
    modified: []
  },
  reach: 3,
  parts: 1,
  tests: [{ id: 'src/a/f.test.ts::f works', file: 'src/a/f.test.ts', depth: 1 }],
  violations: []
})

/** A StructureOf whose answers the test releases */
function controlled() {
  const calls: Array<{ path: string; base: string; head: string; settle: (s: ChangeStructure | Error) => void }> = []
  const structureOf = (path: string, base: string, head: string) =>
    new Promise<ChangeStructure>((resolve, reject) =>
      calls.push({ path, base, head, settle: (s) => (s instanceof Error ? reject(s) : resolve(s)) })
    )
  return { calls, structureOf }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('structure hook', () => {
  it('asks once per open change and head, against the remote base branch, one at a time', async () => {
    const { calls, structureOf } = controlled()
    const hook = createStructureHook(structureOf, () => {})
    let ready = 0
    const changes = [cached(1), cached(2, { state: 'draft' }), cached(3, { state: 'merged' })]
    hook.request(CHECKOUTS, changes, () => ready++)
    hook.request(CHECKOUTS, changes, () => ready++)
    await tick()
    expect(calls.map((c) => [c.path, c.base, c.head])).toEqual([['/work/widget', 'origin/dev', 'sha-1-1']])
    expect(hook.attach(nodeOf(1)).structure).toEqual({
      state: 'computing',
      path: '/work/widget',
      base: 'origin/dev',
      head: 'sha-1-1'
    })

    calls[0].settle(structure('sha-1-1'))
    await tick()
    expect(calls.map((c) => c.head)).toEqual(['sha-1-1', 'sha-2-1'])
    expect(ready).toBe(1)
    expect(hook.attach(nodeOf(1)).structure).toEqual({
      state: 'ready',
      path: '/work/widget',
      base: 'm'.repeat(40),
      head: 'sha-1-1',
      reach: 3,
      parts: 1,
      modules: 1,
      symbols: 1,
      tests: 1
    })
    expect(hook.attach(nodeOf(3))).toEqual(nodeOf(3))
  })

  it('carries the concept line when the change touches a concept tree', async () => {
    const { calls, structureOf } = controlled()
    const hook = createStructureHook(structureOf, () => {})
    hook.request(CHECKOUTS, [cached(1)], () => {})
    await tick()
    const summary = 'Shifts Agents › Access (2 changed, 1 new); touches Agents › Identity (code only)'
    calls[0].settle({ ...structure('sha-1-1'), concepts: { dir: 'mental-models', summary, pages: [] } })
    await tick()
    expect(hook.attach(nodeOf(1)).structure).toMatchObject({ state: 'ready', concepts: summary })
  })

  it('asks again when the head moves, and drops the answer for a head that moved on', async () => {
    const { calls, structureOf } = controlled()
    const hook = createStructureHook(structureOf, () => {})
    hook.request(CHECKOUTS, [cached(1)], () => {})
    await tick()
    hook.request(CHECKOUTS, [cached(1, { head: { branch: 'feat/1', sha: 'sha-1-2' } })], () => {})
    calls[0].settle(structure('sha-1-1'))
    await tick()
    expect(hook.attach(nodeOf(1)).structure).toMatchObject({ state: 'computing', head: 'sha-1-2' })
    calls[1].settle(structure('sha-1-2'))
    await tick()
    expect(hook.attach(nodeOf(1)).structure).toMatchObject({ state: 'ready', head: 'sha-1-2' })
  })

  it('keeps a failure on the node, logs it, and goes on with the next request', async () => {
    const { calls, structureOf } = controlled()
    const logged: string[] = []
    const hook = createStructureHook(structureOf, (m) => logged.push(m))
    hook.request(CHECKOUTS, [cached(1), cached(2)], () => {
      throw new Error('listener broke')
    })
    await tick()
    calls[0].settle(new Error('Not an indexed checkout: /work/widget'))
    await tick()
    expect(hook.attach(nodeOf(1)).structure).toMatchObject({
      state: 'failed',
      error: 'Not an indexed checkout: /work/widget'
    })
    expect(calls).toHaveLength(2)
    expect(logged[0]).toMatch(/#1 at sha-1-1: Not an indexed checkout/)
  })

  it('asks nothing for a repo without a local checkout', async () => {
    const { calls, structureOf } = controlled()
    const hook = createStructureHook(structureOf, () => {})
    hook.request([], [cached(1)], () => {})
    await tick()
    expect(calls).toEqual([])
    expect(hook.attach(nodeOf(1)).structure).toBeUndefined()
  })
})
