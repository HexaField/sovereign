import { describe, expect, it } from 'vitest'
import type { NodeCategoryRecord, WorkNode } from '@sovereign/core'
import { applyCategories, CATEGORY_LABELS, CATEGORY_PREFIXES, resolveCategory, ruleCategory } from './category.js'

const node = (over: Partial<WorkNode> = {}): WorkNode => ({
  id: 'github:github.com/acme-labs/widget#1',
  forge: 'github',
  kind: 'change',
  repo: 'acme-labs/widget',
  number: 1,
  title: 'Gears turn faster',
  state: 'open',
  zone: 'present',
  assignees: [],
  reviewers: [],
  labels: [],
  workstreams: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over
})

describe('ruleCategory', () => {
  it.each([
    ['feat', 'feature'],
    ['fix', 'bug'],
    ['revert', 'bug'],
    ['hotfix', 'bug'],
    ['docs', 'design'],
    ['design', 'design'],
    ['spec', 'design'],
    ['rfc', 'design'],
    ['plan', 'design'],
    ['proposal', 'design'],
    ['refactor', 'future'],
    ['chore', 'future'],
    ['perf', 'future'],
    ['test', 'future'],
    ['ci', 'future'],
    ['build', 'future'],
    ['style', 'future'],
    ['deps', 'future']
  ])('title prefix %s: → %s', (prefix, category) => {
    expect(ruleCategory(node({ title: `${prefix}: gears` }))).toBe(category)
  })

  it('reads a scope, a breaking mark and any case', () => {
    expect(ruleCategory(node({ title: 'FEAT(gears)!: faster gears' }))).toBe('feature')
    expect(ruleCategory(node({ title: 'Fix(ui): button' }))).toBe('bug')
    expect(ruleCategory(node({ title: 'refactor!: split the parser' }))).toBe('future')
    expect(ruleCategory(node({ title: 'Plan: the sprocket migration', kind: 'task' }))).toBe('design')
  })

  it.each([
    ['bug', 'bug'],
    ['Defect', 'bug'],
    ['regression', 'bug'],
    ['enhancement', 'feature'],
    ['FEATURE', 'feature'],
    ['design', 'design'],
    ['rfc', 'design'],
    ['proposal', 'design'],
    ['spec', 'design'],
    ['documentation', 'design'],
    ['docs', 'design'],
    ['tech-debt', 'future'],
    ['tech debt', 'future'],
    ['debt', 'future'],
    ['refactor', 'future'],
    ['infrastructure', 'future'],
    ['infra', 'future'],
    ['chore', 'future'],
    ['dependencies', 'future'],
    ['maintenance', 'future']
  ])('label %s: → %s', (label, category) => {
    expect(ruleCategory(node({ kind: 'issue', title: 'Gears jam', labels: [label] }))).toBe(category)
  })

  it('a label beats a title prefix', () => {
    expect(ruleCategory(node({ title: 'feat: gears', labels: ['bug'] }))).toBe('bug')
    expect(ruleCategory(node({ title: 'fix: gears', labels: ['tech-debt'] }))).toBe('future')
  })

  it('plans are design', () => {
    expect(ruleCategory(node({ kind: 'plan', title: 'Sprocket roadmap', forge: 'local' }))).toBe('design')
  })

  it('abstains on titles and labels it does not know, and on "later" labels', () => {
    expect(ruleCategory(node())).toBeUndefined()
    expect(ruleCategory(node({ title: 'wip: gears' }))).toBeUndefined()
    expect(ruleCategory(node({ title: 'Fix the gears' }))).toBeUndefined()
    expect(ruleCategory(node({ title: 'feature request: gears' }))).toBeUndefined()
    for (const label of ['later', 'someday', 'idea', 'icebox', 'good first issue'])
      expect(ruleCategory(node({ kind: 'issue', labels: [label] }))).toBeUndefined()
    expect(ruleCategory(node({ kind: 'branch', title: 'feat/gears' }))).toBeUndefined()
  })

  it('maps every label and prefix to exactly one category', () => {
    for (const table of [CATEGORY_LABELS, CATEGORY_PREFIXES]) {
      const words = table.flatMap(([, ws]) => ws)
      expect(new Set(words).size).toBe(words.length)
    }
  })
})

describe('resolveCategory / applyCategories: user > rule > rethink', () => {
  it('orders the sources', () => {
    const ruled = node({ title: 'fix: gears' })
    const open = node()
    expect(resolveCategory(ruled, { user: 'design', rethink: 'feature' })).toEqual({
      category: 'design',
      source: 'user'
    })
    expect(resolveCategory(ruled, { rethink: 'feature' })).toEqual({ category: 'bug', source: 'rule' })
    expect(resolveCategory(open, { rethink: 'future' })).toEqual({ category: 'future', source: 'rethink' })
    expect(resolveCategory(open)).toBeUndefined()
  })

  it('sets category and source on each node, and clears stale ones', () => {
    const a = node({ id: 'a', title: 'feat: a' })
    const b = node({ id: 'b' })
    const c = node({ id: 'c', category: 'bug', categorySource: 'rethink' })
    const rec = (nodeId: string, source: 'user' | 'rethink', category: NodeCategoryRecord['category']) => ({
      nodeId,
      source,
      category,
      at: '2026-10-01T00:00:00.000Z'
    })
    applyCategories([a, b, c], [rec('a', 'user', 'design'), rec('a', 'rethink', 'bug'), rec('b', 'rethink', 'future')])
    expect([a, b, c].map((n) => [n.category, n.categorySource])).toEqual([
      ['design', 'user'],
      ['future', 'rethink'],
      [undefined, undefined]
    ])
    expect('category' in c).toBe(false)
  })
})
