import { describe, expect, it } from 'vitest'
import type { ChangeStructure, ConceptMapReport, ConceptNode, ConceptTouch } from '@sovereign/graphcoder-core/contract'
import { createGraphcoderApi } from './api.js'
import {
  checkText,
  conceptDetail,
  conceptMarker,
  coverageText,
  pageChecks,
  signalText,
  subtreeFiles,
  touchCounts,
  usesOf
} from './concept-model.js'

const page = (id: string, parent: string | null, children: string[], files: number): ConceptNode => ({
  id,
  parent,
  children,
  depth: id === '' ? 0 : id.split('/').length,
  file: `mental-models/${id || 'README'}.md`,
  title: id === '' ? 'ADAM' : id.split('/').pop()!,
  model: '',
  why: '',
  files,
  symbols: 0,
  unresolved: id === 'agents/access' ? ['Nope'] : [],
  flows: 0
})

const report: ConceptMapReport = {
  path: '/work/ad4m',
  sha: 'a'.repeat(40),
  dir: 'mental-models',
  pages: [
    page('', null, ['agents'], 1),
    page('agents', '', ['agents/access', 'agents/identity'], 2),
    page('agents/access', 'agents', [], 5),
    page('agents/identity', 'agents', [], 3)
  ],
  coverage: { files: 1229, covered: 1220, uncovered: [{ dir: 'test-runner/src', files: 9 }] },
  stale: [{ page: 'agents/access', path: 'rust-executor/src/gone.rs' }],
  shared: [{ path: 'rust-executor/src/agent', pages: ['agents/access', 'agents/identity'], files: 4 }],
  dependencies: [
    { from: 'agents/access', to: 'agents/identity', edges: 12 },
    { from: 'agents/access', to: '', edges: 3 },
    { from: 'agents/identity', to: 'agents', edges: 1 }
  ]
}

describe('concept map', () => {
  it('writes coverage as a share of indexed files', () => {
    expect(coverageText(report.coverage)).toBe('1,220 of 1,229 files (99.3 %)')
    expect(coverageText({ files: 0, covered: 0, uncovered: [] })).toBe('0 of 0 files (0.0 %)')
  })

  it('collects each page’s findings', () => {
    const checks = pageChecks(report)
    expect(checkText(checks.get('agents/access'))).toBe('1 stale · 1 shared · 1 unresolved')
    expect(checkText(checks.get('agents/identity'))).toBe('1 shared')
    expect(checkText(checks.get('agents'))).toBe('')
  })

  it('rolls file counts up the tree', () => {
    expect(Object.fromEntries(subtreeFiles(report))).toEqual({
      '': 11,
      agents: 10,
      'agents/access': 5,
      'agents/identity': 3
    })
  })

  it('lists what a page’s code uses, by title', () => {
    expect(usesOf(report, 'agents/access')).toEqual([
      { id: 'agents/identity', title: 'identity', edges: 12 },
      { id: '', title: 'ADAM', edges: 3 }
    ])
  })
})

const touch = (over: Partial<ConceptTouch>): ConceptTouch => ({
  id: 'agents/access/sessions',
  parent: 'agents/access',
  depth: 3,
  file: 'mental-models/agents/access/sessions.md',
  title: 'Sessions',
  model: 'A session is…',
  why: '',
  symbols: { added: 0, removed: 0, modified: 0 },
  files: [],
  tests: [],
  ...over
})

describe('concept impact', () => {
  it('marks what the change does to a concept', () => {
    expect(conceptMarker(touch({ page: 'added' })).text).toBe('new')
    expect(conceptMarker(touch({ page: 'changed' })).text).toBe('changed')
    expect(conceptMarker(touch({ page: 'removed' })).text).toBe('removed')
    expect(conceptMarker(touch({ symbols: { added: 1, removed: 0, modified: 0 } })).text).toBe('code')
    expect(conceptMarker(touch({})).text).toBe('')
  })

  it('words the signals and counts the symbols', () => {
    expect(signalText(touch({ signal: 'stale-page' }))).toBe('stale page?')
    expect(signalText(touch({ signal: 'docs-only' }))).toBe('docs only')
    expect(signalText(touch({}))).toBe('')
    expect(touchCounts(touch({ symbols: { added: 1, removed: 2, modified: 0 } }))).toBe('+1 −2')
  })

  it('gives a concept its own symbols, the tests that reach them, and its files', () => {
    const sym = (name: string, concept?: string) => ({
      id: name,
      kind: 'function',
      name,
      qualifiedName: name,
      filePath: 'rust-executor/src/agent/session.rs',
      ...(concept ? { concept } : {})
    })
    const s: ChangeStructure = {
      base: 'b',
      head: 'h',
      modules: [],
      symbols: { added: [sym('open', 'agents/access/sessions'), sym('other', 'agents')], removed: [], modified: [] },
      reach: 0,
      parts: 1,
      tests: [
        { id: 'a::near', file: 'a', depth: 1 },
        { id: 'b::far', file: 'b', depth: 3 }
      ],
      violations: []
    }
    const d = conceptDetail(s, touch({ tests: ['b::far'], files: ['rust-executor/src/agent/session.rs'] }))
    expect(d.symbols.map((g) => [g.key, g.items.map((i) => i.name)])).toEqual([['added', ['open']]])
    expect(d.tests.map((t) => t.id)).toEqual(['b::far'])
    expect(d.files).toEqual(['rust-executor/src/agent/session.rs'])
  })
})

describe('graphcoder api: concepts', () => {
  it('asks for a checkout at a ref, and turns an HTTP error into a failure', async () => {
    const urls: string[] = []
    const ok = createGraphcoderApi(async (url) => {
      urls.push(String(url))
      return new Response(JSON.stringify(report))
    })
    expect(await ok.concepts('/work/ad4m', 'abc')).toEqual({ state: 'ready', report })
    expect(await ok.concepts('/work/ad4m')).toEqual({ state: 'ready', report })
    expect(urls).toEqual([
      '/api/graphcoder/concepts?path=%2Fwork%2Fad4m&ref=abc',
      '/api/graphcoder/concepts?path=%2Fwork%2Fad4m'
    ])
    const missing = createGraphcoderApi(
      async () => new Response(JSON.stringify({ error: 'no commit x' }), { status: 404 })
    )
    expect(await missing.concepts('/work/ad4m', 'x')).toEqual({ state: 'failed', error: 'no commit x' })
  })
})
