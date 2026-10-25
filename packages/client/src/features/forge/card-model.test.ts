import { describe, it, expect } from 'vitest'
import { defaultWorkPrompt, type AgentOverlay, type WorkNode } from '@sovereign/core/forge'
import { agentStatusLine, assignBody, defaultThreadLabel, linkedGroups, shortRef, taskSection } from './card-model.js'
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

  it('depends-on reads "Depends on" from the dependent and "Needed by" from what it needs', () => {
    const dep = [edge(iss, pr, 'depends-on'), edge(pr, 'task://s1', 'depends-on')]
    expect(linkedGroups(iss.id, dep, nodes).map((x) => x.label)).toEqual(['Depends on'])
    const g = linkedGroups(pr.id, dep, nodes)
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([
      ['Depends on', ['task://s1']],
      ['Needed by', [iss.id]]
    ])
  })

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
    expect(defaultWorkPrompt(pr)).toMatch(
      /^Work on https:\/\/github\.com\/demo-org\/engine\/pull\/42: fetch the PR, its comments and CI, then /
    )
    expect(defaultWorkPrompt(issue(R, 7))).toMatch(
      /^Work on https:\/\/github\.com\/demo-org\/engine\/issues\/7: fetch the issue, its comments/
    )
    expect(defaultWorkPrompt(plan('plans/roll.md'))).toContain('the plan "Plan plans/roll.md"')
    expect(defaultWorkPrompt(task('t1'))).toContain('"Task t1"')
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

  it('taskSection: the owning epic, related epics, the owner options and child tasks', () => {
    const t = task('parent', { workstreams: ['s1'], relatedStreams: ['s2'] })
    const child = task('child')
    const nodes = new Map([t, child].map((n) => [n.id, n]))
    const s = taskSection(t, [stream('s1', 'One'), stream('s2', 'Two')], [edge(t, child, 'subtask')], nodes)
    expect(s.owner?.name).toBe('One')
    expect(s.related.map((x) => x.name)).toEqual(['Two'])
    expect(s.options.map((x) => x.id)).toEqual(['s1', 's2'])
    expect(s.children.map((c) => c.id)).toEqual([child.id])
    // No owner, no relation; an owner the list does not hold still shows by id.
    expect(taskSection(child, [], [], nodes)).toMatchObject({ owner: undefined, related: [], options: [] })
    expect(taskSection(task('x', { workstreams: ['gone'] }), [], [], nodes).owner).toMatchObject({ id: 'gone' })
    // A plan's own epic is not offered as its owner.
    const own = taskSection(plan('p.md', { taskId: 's1' }), [stream('s1', 'One'), stream('s2', 'Two')], [], nodes)
    expect(own.options.map((x) => x.id)).toEqual(['s2'])
    // The epic the node itself is, whose status the card sets; none for an item that is no epic.
    expect(own.epic).toMatchObject({ id: 's1', status: 'planned' })
    expect(s.epic).toBeUndefined()
    // An owner the window does not hold was not served: archived.
    expect(taskSection(task('x', { workstreams: ['gone'] }), [], [], nodes).owner).toMatchObject({ status: 'archived' })
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
