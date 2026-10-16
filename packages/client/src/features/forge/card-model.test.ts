import { describe, it, expect } from 'vitest'
import type { AgentOverlay, WorkNode } from '@sovereign/core'
import {
  agentStatusLine,
  assignBody,
  defaultPrompt,
  defaultThreadLabel,
  linkedGroups,
  shortRef,
  taskSection
} from './card-model.js'
import { cardRethinkItems } from './rethink-model.js'
import { change, edge, issue, plan, stream, task } from './test-fixtures.js'

const R = 'demo-org/engine'
const R2 = 'demo-org/app'

describe('linkedGroups', () => {
  const pr = change(R, 10)
  const base = change(R, 9)
  const top = change(R, 11)
  const peer = change(R2, 3)
  const iss = issue(R, 20)
  const p = plan('plans/x.md')
  const nodes = new Map<string, WorkNode>([pr, base, top, peer, iss, p].map((n) => [n.id, n]))
  const edges = [
    edge(pr, base, 'base'),
    edge(top, pr, 'base'),
    edge(peer, pr, 'paired'),
    edge(pr, iss, 'closes'),
    edge(p, pr, 'plans'),
    edge(pr, 'github:github.com/demo-org/engine#999', 'references'),
    edge(pr, pr, 'references'),
    edge(pr, iss, 'related', { source: 'rethink', reason: 'same subsystem', confidence: 0.8 })
  ]

  it('groups by kind and direction in a fixed order', () => {
    const g = linkedGroups(pr.id, edges, nodes)
    expect(g.map((x) => x.label)).toEqual([
      'Stacked on',
      'Stacked under it',
      'Paired with',
      'Closes',
      'Planned in',
      'References',
      'Related (rethink)'
    ])
    expect(g[0].items.map((i) => i.id)).toEqual([base.id])
    expect(g[1].items.map((i) => i.id)).toEqual([top.id])
  })

  it('keeps links to unloaded nodes (no node) and skips self-loops', () => {
    const refs = linkedGroups(pr.id, edges, nodes).find((x) => x.label === 'References')!
    expect(refs.items).toEqual([
      expect.objectContaining({ id: 'github:github.com/demo-org/engine#999', node: undefined })
    ])
  })

  it('paired reads the same from both ends', () => {
    expect(linkedGroups(peer.id, edges, nodes).map((x) => x.label)).toEqual(['Paired with'])
  })

  it('rethink notes: the node notes newest first, then only rethink-sourced edges', () => {
    const notes = [
      { at: '2026-10-16T08:31:00Z', kind: 'note' as const, text: 'Looks stale', runId: 'r1' },
      { at: '2026-10-16T08:32:00Z', kind: 'dispatch' as const, text: 'Sent to "worker": rebase on dev', runId: 'r1' }
    ]
    expect(cardRethinkItems(pr.id, notes, edges)).toEqual([
      { at: '2026-10-16T08:32:00Z', tag: 'Job', text: 'Sent to "worker": rebase on dev', runId: 'r1' },
      { at: '2026-10-16T08:31:00Z', tag: 'Note', text: 'Looks stale', runId: 'r1' },
      { tag: 'related', text: 'same subsystem', otherId: iss.id, confidence: 0.8 }
    ])
    expect(cardRethinkItems(base.id, undefined, edges)).toEqual([])
  })
})

describe('assign', () => {
  const pr = change(R, 42, { title: 'Fix the flaky socket test' })

  it('prefills the label and the prompt from the node', () => {
    expect(defaultThreadLabel(pr)).toBe('engine#42 Fix the flaky socket test')
    expect(defaultPrompt(pr)).toMatch(
      /^Work on https:\/\/github\.com\/demo-org\/engine\/pull\/42: fetch the PR, its comments and CI, then /
    )
    expect(defaultPrompt(issue(R, 7))).toMatch(
      /^Work on https:\/\/github\.com\/demo-org\/engine\/issues\/7: fetch the issue, its comments/
    )
    expect(defaultPrompt(plan('plans/roll.md'))).toContain('the plan "Plan plans/roll.md"')
    expect(defaultPrompt(task('t1'))).toContain('"Task t1"')
    expect(defaultThreadLabel(change(R, 1, { title: 'x'.repeat(100) })).length).toBe(60)
  })

  it('builds the body for an existing thread', () => {
    expect(assignBody({ nodeId: pr.id, threadId: 'th-1', prompt: ' go ' })).toEqual({
      nodeId: pr.id,
      threadId: 'th-1',
      prompt: 'go'
    })
  })

  it('builds the body for a new thread, and omits an empty prompt', () => {
    expect(assignBody({ nodeId: pr.id, threadId: null, newLabel: ' engine#42 ', prompt: '  ' })).toEqual({
      nodeId: pr.id,
      newThread: { label: 'engine#42' }
    })
  })

  it('refuses a new thread without a label', () => {
    expect(() => assignBody({ nodeId: pr.id, threadId: null, newLabel: ' ' })).toThrow(/label/)
  })
})

describe('card sections', () => {
  it('shortRef', () => {
    expect(shortRef(change(R, 5))).toBe('engine#5')
    expect(shortRef(plan('p.md'))).toBe('Plan p.md')
  })

  it('taskSection: streams, child tasks and addable streams', () => {
    const t = task('parent', { workstreams: ['s1'] })
    const child = task('child')
    const nodes = new Map([t, child].map((n) => [n.id, n]))
    const s = taskSection(t, [stream('s1', 'One'), stream('s2', 'Two')], [edge(t, child, 'subtask')], nodes)
    expect(s.streams.map((x) => x.name)).toEqual(['One'])
    expect(s.children.map((c) => c.id)).toEqual([child.id])
    expect(s.addable.map((x) => x.id)).toEqual(['s2'])
  })

  it('agentStatusLine', () => {
    const o = (x: Partial<AgentOverlay>): AgentOverlay => ({ nodeId: 'n', subagents: [], ...x })
    expect(agentStatusLine(undefined).tone).toBe('none')
    expect(agentStatusLine(o({ thread: { id: 't', label: 'T', status: 'working' } })).label).toBe('Working')
    expect(agentStatusLine(o({ thread: { id: 't', label: 'T', status: 'idle' }, waitingOn: 'ci' })).label).toBe(
      'Waiting for CI'
    )
    expect(agentStatusLine(o({ thread: { id: 't', label: 'T', status: 'idle' }, waitingOn: 'review' })).label).toBe(
      'Waiting for review'
    )
    expect(agentStatusLine(o({ thread: { id: 't', label: 'T', status: 'idle' } })).label).toBe('Idle')
    expect(agentStatusLine(o({ subagents: [{ key: 'k', label: 'fix', startedAt: 0 }] })).label).toBe(
      '1 subagent running'
    )
  })
})
