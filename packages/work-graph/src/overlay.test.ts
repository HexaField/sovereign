import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkNode } from '@sovereign/core'
import { describe, expect, it } from 'vitest'
import { buildOverlay, currentBranch, resolveCheckouts, waitingOn } from './overlay.js'
import type { PortTask } from './types.js'

const node = (n: number, over: Partial<WorkNode> = {}): WorkNode => ({
  id: `github:github.com/acme-labs/widget#${n}`,
  forge: 'github',
  kind: 'change',
  repo: 'acme-labs/widget',
  number: n,
  title: `Change ${n}`,
  state: 'open',
  zone: 'present',
  assignees: [],
  reviewers: [],
  labels: [],
  workstreams: [],
  branch: { head: `feat/${n}`, base: 'dev' },
  ci: 'passing',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over
})

const task = (id: string, key: string | null, threadId: string | null): PortTask => ({
  id,
  name: id,
  state: 'in_progress',
  threadId,
  transientState: null,
  membrane: 'acme',
  key,
  parentIds: [],
  childIds: [],
  isStream: false,
  createdAt: '',
  updatedAt: ''
})

describe('waitingOn', () => {
  it('ci while CI runs or a watch waits; review when requested with CI green; josh when the idle owner asked', () => {
    expect(waitingOn(node(1, { ci: 'pending' }), {}, false)).toBe('ci')
    expect(waitingOn(node(1), { ciWatch: { state: 'waiting', since: 1 } }, false)).toBe('ci')
    expect(waitingOn(node(1, { reviewers: [{ login: 'jo', state: 'requested' }] }), {}, false)).toBe('review')
    expect(
      waitingOn(node(1, { ci: 'failing', reviewers: [{ login: 'jo', state: 'requested' }] }), {}, false)
    ).toBeNull()
    expect(waitingOn(node(1), { thread: { id: 't', label: 't', status: 'idle' } }, true)).toBe('josh')
    expect(waitingOn(node(1), { thread: { id: 't', label: 't', status: 'working' } }, true)).toBeNull()
  })
})

describe('buildOverlay', () => {
  it('maps the owner thread, subagents by repo + branch, and CI watches; lists unmatched subagents', () => {
    const nodes = [
      node(1),
      node(2, { ci: 'pending' }),
      node(3, { state: 'merged', branch: { head: 'feat/2', base: 'dev' } })
    ]
    const r = buildOverlay({
      nodes,
      tasks: [task('a', nodes[0].id, 'thread-a'), task('b', nodes[1].id, null)],
      presence: (id) => (id === 'thread-a' ? { label: 'Widget work', status: 'working' } : undefined),
      subagents: [
        { key: 'sub-1', label: 'fix CI', parentThreadId: 'thread-a', cwd: '/w/a', startedAt: 5 },
        { key: 'sub-2', label: 'lost', parentThreadId: 'thread-a', cwd: '/w/b', startedAt: 6 },
        { key: 'sub-3', label: 'no cwd', parentThreadId: 'thread-a', startedAt: 7 }
      ],
      ciWatches: [
        { threadKey: 'thread-a', repo: 'acme-labs/widget', target: { kind: 'pr', number: 1 }, createdAt: 100 },
        { threadKey: 'thread-a', repo: 'acme-labs/widget', target: { kind: 'branch', name: 'feat/2' }, createdAt: 200 }
      ],
      checkouts: new Map([
        ['/w/a', { repo: 'acme-labs/widget', branch: 'feat/2' }],
        ['/w/b', { repo: 'acme-labs/widget', branch: 'feat/none' }]
      ])
    })
    const by = new Map(r.overlays.map((o) => [o.nodeId, o]))
    expect(by.get(nodes[0].id)).toEqual({
      nodeId: nodes[0].id,
      thread: { id: 'thread-a', label: 'Widget work', status: 'working' },
      subagents: [],
      ciWatch: { state: 'waiting', since: 100 },
      waitingOn: 'ci'
    })
    // feat/2 is the head of the open #2 and the merged #3: the open one wins.
    expect(by.get(nodes[1].id)).toMatchObject({
      subagents: [{ key: 'sub-1', label: 'fix CI', startedAt: 5 }],
      waitingOn: 'ci'
    })
    expect(by.has(nodes[2].id)).toBe(false)
    expect(r.unmatched.map((u) => u.key)).toEqual(['sub-2', 'sub-3'])
    expect(r.unmatched[0]).toMatchObject({ branch: 'feat/none', cwd: '/w/b' })
  })
})

describe('resolveCheckouts', () => {
  it('reads the repo from the checkout remotes and the branch from git', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-co-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'feat/x', dir])
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme-labs/widget.git'])
      expect(await currentBranch(dir)).toBe('feat/x')
      const m = await resolveCheckouts([{ key: 's', label: 's', parentThreadId: 't', cwd: dir, startedAt: 0 }])
      expect(m.get(dir)).toEqual({ repo: 'acme-labs/widget', branch: 'feat/x' })
      expect(await currentBranch(path.join(dir, 'nope'))).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
