import { describe, expect, it } from 'vitest'
import type { ChangeStructure } from '@sovereign/graphcoder-core/contract'
import { moduleCounts, reachBadge, reachText, symbolGroups, testLabel } from './structure-model.js'
import { createGraphcoderApi } from './api.js'

const key = { path: '/work/app', base: 'b'.repeat(40), head: 'h'.repeat(40) }

describe('reachBadge', () => {
  it('shows nothing for a node without a structure', () => {
    expect(reachBadge(undefined)).toBeNull()
  })

  it('shows computing and failed states', () => {
    expect(reachBadge({ ...key, state: 'computing' })).toMatchObject({ text: 'reach …', tone: 'muted' })
    expect(reachBadge({ ...key, state: 'failed', error: 'Not an indexed checkout' })).toEqual({
      text: 'reach ?',
      title: 'No structure: Not an indexed checkout',
      tone: 'error'
    })
  })

  it('shows the reach, with parts and counts in the tooltip', () => {
    expect(reachBadge({ ...key, state: 'ready', reach: 8, parts: 2, modules: 1, symbols: 232, tests: 261 })).toEqual({
      text: 'reach 8',
      title: 'reach 8 in 2 parts: the most hops between two changed symbols · 1 module · 232 symbols · 261 tests',
      tone: 'normal'
    })
  })
})

describe('section text', () => {
  const sym = (name: string) => ({ id: name, kind: 'function', name, qualifiedName: name, filePath: 'src/a.ts' })
  const s: ChangeStructure = {
    base: key.base,
    head: key.head,
    modules: [{ module: 'src', label: 'src', added: 2, removed: 0, modified: 1 }],
    symbols: { added: [sym('a'), sym('b')], removed: [], modified: [sym('c')] },
    reach: 2,
    parts: 1,
    tests: [],
    violations: []
  }

  it('groups symbols added, modified, removed', () => {
    expect(symbolGroups(s).map((g) => [g.label, g.items.length])).toEqual([
      ['Added', 2],
      ['Modified', 1],
      ['Removed', 0]
    ])
  })

  it('counts a module without zeros', () => {
    expect(moduleCounts(s.modules[0])).toBe('+2 ~1')
  })

  it('writes reach with parts only when there are several', () => {
    expect(reachText(2, 1)).toBe('reach 2')
    expect(reachText(8, 2)).toBe('reach 8 in 2 parts')
  })

  it('names a test by its case, or by its file when the file is one test', () => {
    expect(testLabel({ id: 'src/a.test.ts::math adds', file: 'src/a.test.ts', depth: 1 })).toEqual({
      name: 'math adds',
      file: 'src/a.test.ts',
      depth: 'calls it'
    })
    expect(testLabel({ id: 'tests/e2e.rs', file: 'tests/e2e.rs', depth: 0 })).toMatchObject({
      name: 'e2e.rs',
      depth: 'edited'
    })
    expect(testLabel({ id: 'x::y', file: 'x', depth: 3 }).depth).toBe('3 hops')
  })
})

describe('graphcoder api', () => {
  it('reads the cached structure of a change, and turns an HTTP error into a failure', async () => {
    const urls: string[] = []
    const ok = createGraphcoderApi(async (url) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ state: 'computing' }))
    })
    expect(await ok.cachedStructure(key)).toEqual({ state: 'computing' })
    expect(urls[0]).toBe(`/api/graphcoder/structure/cached?path=%2Fwork%2Fapp&base=${key.base}&head=${key.head}`)
    const missing = createGraphcoderApi(
      async () => new Response(JSON.stringify({ error: 'Not an indexed checkout: /x' }), { status: 404 })
    )
    expect(await missing.cachedStructure(key)).toEqual({ state: 'failed', error: 'Not an indexed checkout: /x' })
  })
})
