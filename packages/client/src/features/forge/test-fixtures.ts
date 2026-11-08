// Made-up work-graph builders for the Forge tests. Repos, logins and titles
// are fictional.

import type { WorkEdge, WorkNode, WorkStream } from '@sovereign/core'
import { DAY_MS } from './layout.js'

export const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
export const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY_MS).toISOString()

export function change(repo: string, number: number, over: Partial<WorkNode> = {}): WorkNode {
  return {
    id: `github:github.com/${repo}#${number}`,
    forge: 'github',
    kind: 'change',
    repo,
    number,
    title: `Change ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    state: 'open',
    zone: 'present',
    author: 'alex',
    assignees: [],
    reviewers: [],
    labels: [],
    workstreams: [],
    branch: { head: `feat/change-${number}`, base: 'dev' },
    createdAt: iso(5),
    updatedAt: iso(1),
    ...over
  }
}

export function merged(repo: string, number: number, closedDaysAgo: number, over: Partial<WorkNode> = {}): WorkNode {
  return change(repo, number, {
    state: 'merged',
    zone: 'past',
    createdAt: iso(closedDaysAgo + 2),
    updatedAt: iso(closedDaysAgo),
    closedAt: iso(closedDaysAgo),
    ...over
  })
}

export function issue(repo: string, number: number, over: Partial<WorkNode> = {}): WorkNode {
  return {
    id: `github:github.com/${repo}#${number}`,
    forge: 'github',
    kind: 'issue',
    repo,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${repo}/issues/${number}`,
    state: 'open',
    zone: 'future',
    author: 'sam',
    assignees: [],
    reviewers: [],
    labels: [],
    workstreams: [],
    createdAt: iso(10),
    updatedAt: iso(3),
    ...over
  }
}

export function plan(path: string, over: Partial<WorkNode> = {}): WorkNode {
  return {
    id: `plan:demo/${path}`,
    forge: 'local',
    kind: 'plan',
    title: `Plan ${path}`,
    state: 'planned',
    zone: 'future',
    assignees: [],
    reviewers: [],
    labels: [],
    workstreams: [],
    createdAt: iso(20),
    updatedAt: iso(2),
    ...over
  }
}

export function task(id: string, over: Partial<WorkNode> = {}): WorkNode {
  return {
    id: `task:${id}`,
    forge: 'local',
    kind: 'task',
    title: `Task ${id}`,
    state: 'planned',
    zone: 'future',
    assignees: [],
    reviewers: [],
    labels: [],
    workstreams: [],
    taskId: id,
    createdAt: iso(4),
    updatedAt: iso(4),
    ...over
  }
}

export function edge(
  from: WorkNode | string,
  to: WorkNode | string,
  kind: WorkEdge['kind'],
  over: Partial<WorkEdge> = {}
): WorkEdge {
  const f = typeof from === 'string' ? from : from.id
  const t = typeof to === 'string' ? to : to.id
  const dashed = kind === 'references' || kind === 'plans' || kind === 'related'
  return { from: f, to: t, kind, dashed, source: 'sync', ...over }
}

export function stream(id: string, name: string, over: Partial<WorkStream> = {}): WorkStream {
  return { id, name, membrane: 'demo', memberCount: 0, status: 'planned', ...over }
}

/** Fisher–Yates with a fixed LCG, so a "shuffled" input is reproducible. */
export function shuffled<T>(list: T[], seed = 7): T[] {
  const out = [...list]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
