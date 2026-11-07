import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { WorkEdge, WorkNode } from '@sovereign/core'
import { stackModel } from './stacks.js'
import { change, edge, issue, merged } from './test-fixtures.js'

const REPO = 'acme/widgets'
const OTHER = 'acme/gears'

const model = (nodes: WorkNode[], edges: WorkEdge[]) => stackModel(new Map(nodes.map((n) => [n.id, n])), edges)
const numbersOf = (m: ReturnType<typeof model>, byId: Map<string, WorkNode>) =>
  m.stacks.map((s) => s.members.map((id) => byId.get(id)!.number))

describe('stackModel', () => {
  it('orders a stack bottom → top, by depth then number, and branches', () => {
    const [a, b, c, d, e] = [10, 11, 12, 13, 9].map((n) => change(REPO, n))
    const nodes = [a, b, c, d, e]
    const m = model(nodes, [
      edge(a, `github:github.com/${REPO}@dev`, 'base'),
      edge(c, b, 'base'),
      edge(b, a, 'base'),
      edge(d, a, 'base'), // two PRs on one base
      edge(e, c, 'base')
    ])
    const byId = new Map(nodes.map((n) => [n.id, n]))
    expect(numbersOf(m, byId)).toEqual([[10, 11, 13, 12, 9]])
    expect([a, b, d, c, e].map((n) => m.position.get(n.id))).toEqual([1, 2, 3, 4, 5])
    expect(m.stackOf.get(e.id)).toBe(m.stacks[0])
  })

  it('joins only open or draft changes: a merged base or an issue starts no stack', () => {
    const base = merged(REPO, 1, 1)
    const pr = change(REPO, 2, { state: 'draft' })
    const top = change(REPO, 3)
    const i = issue(REPO, 4)
    const m = model([base, pr, top, i], [edge(pr, base, 'base'), edge(top, pr, 'base'), edge(top, i, 'base')])
    expect(m.stacks.map((s) => s.members)).toEqual([[pr.id, top.id]])
    expect(m.stackOf.has(base.id)).toBe(false)
  })

  it('a cycle of bases stays one stack, from its lowest number', () => {
    const [a, b, c] = [7, 5, 6].map((n) => change(REPO, n))
    const m = model([a, b, c], [edge(a, b, 'base'), edge(b, c, 'base'), edge(c, a, 'base'), edge(a, a, 'base')])
    expect(m.stacks.map((s) => s.members)).toEqual([[b.id, a.id, c.id]])
  })

  it('reads pairs both ways, between changes in any state', () => {
    const pr = change(REPO, 1)
    const partner = merged(OTHER, 2, 3)
    const third = change(OTHER, 3, { state: 'closed' })
    const i = issue(OTHER, 4)
    const m = model(
      [pr, partner, third, i],
      [edge(pr, partner, 'paired'), edge(third, pr, 'paired'), edge(pr, i, 'paired')]
    )
    expect(m.pairs.get(pr.id)).toEqual([partner.id, third.id])
    expect(m.pairs.get(partner.id)).toEqual([pr.id])
    expect(m.pairs.get(third.id)).toEqual([pr.id])
    expect(m.pairs.has(i.id)).toBe(false)
    expect(m.stacks).toEqual([])
  })
})

// A live snapshot of GET /api/forge?membrane=coasys, when present (not in CI).
const SNAPSHOT = '/tmp/forge-coasys-snapshot.json'

describe.skipIf(!existsSync(SNAPSHOT))('stackModel on the coasys snapshot', () => {
  const load = () => {
    const graph = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { nodes: WorkNode[]; edges: WorkEdge[] }
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const ref = (id: string) => `${byId.get(id)!.repo!.split('/')[1]}#${byId.get(id)!.number}`
    return { m: stackModel(byId, graph.edges), ref }
  }

  it('reproduces the stacks GitHub shows', () => {
    const { m, ref } = load()
    const stacks = m.stacks.map((s) => s.members.map(ref).join(' ← '))
    // Read from GitHub on the snapshot's day.
    const known = [
      'ad4m#1578 ← ad4m#1597 ← ad4m#1617 ← ad4m#1632 ← ad4m#1635 ← ad4m#1649',
      'ad4m#1606 ← ad4m#1614 ← ad4m#1615 ← ad4m#1616 ← ad4m#1625 ← ad4m#1627',
      'ad4m#1607 ← ad4m#1613',
      'ad4m#1661 ← ad4m#1662',
      'ad4m#1443 ← ad4m#1463',
      'we#395 ← we#420'
    ]
    for (const s of known) expect(stacks).toContain(s)
    // Older open stacks (drafts mostly), also checked against each PR's base branch on GitHub.
    // 1433 and 1411 both sit on 1410: the stack branches.
    expect([...stacks].sort()).toEqual(
      [
        ...known,
        'ad4m#839 ← ad4m#840 ← ad4m#841 ← ad4m#843 ← ad4m#844 ← ad4m#845',
        'ad4m#812 ← ad4m#873',
        'ad4m#1301 ← ad4m#1302 ← ad4m#1303',
        'ad4m#1408 ← ad4m#1409 ← ad4m#1410 ← ad4m#1411 ← ad4m#1433 ← ad4m#1412',
        'ad4m#1413 ← ad4m#1414',
        'ad4m#1308 ← ad4m#1477',
        'ad4m#1482 ← ad4m#1487',
        'ad4m#1582 ← ad4m#1583',
        'ad4m#1637 ← ad4m#1638 ← ad4m#1639 ← ad4m#1663',
        'we#416 ← we#425',
        'coasys-app#2 ← coasys-app#3 ← coasys-app#4'
      ].sort()
    )
  })

  it('reproduces the four ad4m ↔ we pairs, both ways', () => {
    const { m, ref } = load()
    const pairs = [...m.pairs].map(([id, partners]) => `${ref(id)} ⇄ ${partners.map(ref).join(', ')}`).sort()
    expect(pairs).toEqual(
      [
        'ad4m#1578 ⇄ we#427',
        'ad4m#1627 ⇄ we#420',
        'ad4m#1443 ⇄ we#408',
        'ad4m#1581 ⇄ we#384',
        'we#427 ⇄ ad4m#1578',
        'we#420 ⇄ ad4m#1627',
        'we#408 ⇄ ad4m#1443',
        'we#384 ⇄ ad4m#1581'
      ].sort()
    )
  })
})
