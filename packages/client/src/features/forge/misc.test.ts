import { describe, it, expect } from 'vitest'
import type { AgentOverlay, ForgeView } from '@sovereign/core'
import { createForgeApi } from './api.js'
import { keyDirection, walkEdge } from './edge-walk.js'
import { addView, moveView, newViewId, removeView, seedView, shownViews, updateView, viewFilters } from './graphs.js'
import { computeLayout } from './layout.js'
import { pickMembrane, threadChoices } from './membrane.js'
import { RING_COLORS, edgeStyle, initials, reviewSummary, ringFor } from './style.js'
import { MAX_SCALE, MIN_SCALE, fitRect, pan, screenToWorld, wheelFactor, worldToScreen, zoomAt } from './viewport.js'
import { NOW, change, edge, issue } from './test-fixtures.js'

const R = 'demo-org/engine'

describe('viewport', () => {
  it('round-trips world ↔ screen', () => {
    const vp = { tx: 120, ty: -40, scale: 0.5 }
    const s = worldToScreen(vp, -800, 300)
    expect(screenToWorld(vp, s.x, s.y)).toEqual({ x: -800, y: 300 })
  })

  it('zooms about the cursor', () => {
    const vp = { tx: 0, ty: 0, scale: 1 }
    const before = screenToWorld(vp, 300, 200)
    const z = zoomAt(vp, 300, 200, 2)
    expect(z.scale).toBe(2)
    expect(screenToWorld(z, 300, 200)).toEqual(before)
    expect(zoomAt(vp, 0, 0, 1e6).scale).toBe(MAX_SCALE)
    expect(zoomAt(vp, 0, 0, 1e-6).scale).toBe(MIN_SCALE)
  })

  it('pans and fits', () => {
    expect(pan({ tx: 1, ty: 2, scale: 1 }, 10, -5)).toEqual({ tx: 11, ty: -3, scale: 1 })
    const f = fitRect({ minX: -1000, maxX: 1000, minY: 0, maxY: 500 }, 1080, 620, 40)
    expect(f.scale).toBe(0.5)
    expect(worldToScreen(f, -1000, 0).x).toBe(40)
    expect(worldToScreen(f, 1000, 0).x).toBe(1040)
  })

  it('wheel factor is proportional and bounded', () => {
    expect(wheelFactor(100)).toBeLessThan(1)
    expect(wheelFactor(-100)).toBeGreaterThan(1)
    expect(wheelFactor(1e5)).toBe(wheelFactor(300))
    expect(wheelFactor(3, 1)).toBe(wheelFactor(48))
  })
})

describe('agent ring', () => {
  const o = (x: Partial<AgentOverlay>): AgentOverlay => ({ nodeId: 'n', subagents: [], ...x })
  const t = (status: 'working' | 'thinking' | 'idle') => ({ id: 't', label: 'T', status })
  it('green working, amber CI, blue review, grey idle, pulse with subagents', () => {
    expect(ringFor(undefined)).toBeNull()
    expect(ringFor(o({}))).toBeNull()
    expect(ringFor(o({ thread: t('working') }))).toEqual({ kind: 'working', color: RING_COLORS.working, pulse: false })
    expect(ringFor(o({ thread: t('thinking'), waitingOn: 'ci' }))!.kind).toBe('working')
    expect(ringFor(o({ thread: t('idle'), waitingOn: 'ci' }))!.kind).toBe('waiting-ci')
    expect(ringFor(o({ thread: t('idle'), ciWatch: { state: 'waiting', since: 0 } }))!.kind).toBe('waiting-ci')
    expect(ringFor(o({ thread: t('idle'), waitingOn: 'review' }))!.color).toBe(RING_COLORS['waiting-review'])
    expect(ringFor(o({ thread: t('idle') }))!.kind).toBe('idle')
    expect(ringFor(o({ thread: t('idle'), subagents: [{ key: 'k', label: 'l', startedAt: 0 }] }))!.pulse).toBe(true)
    expect(ringFor(o({ subagents: [{ key: 'k', label: 'l', startedAt: 0 }] }))).toEqual({
      kind: 'working',
      color: RING_COLORS.working,
      pulse: true
    })
  })
})

describe('edge style', () => {
  it('solid for base / merged-into / paired, dashed grey for future-facing, dashed purple for related', () => {
    const e = (kind: Parameters<typeof edge>[2]) => edge('a', 'b', kind)
    expect(edgeStyle(e('base'), undefined).dash).toEqual([])
    expect(edgeStyle(e('merged-into'), undefined).dash).toEqual([])
    expect(edgeStyle(e('paired'), undefined).dash).toEqual([])
    expect(edgeStyle(e('references'), undefined).dash.length).toBe(2)
    expect(edgeStyle(e('plans'), undefined).dash.length).toBe(2)
    expect(edgeStyle(e('closes'), issue(R, 1)).dash.length).toBe(2)
    expect(edgeStyle(e('closes'), issue(R, 1, { state: 'closed' })).dash).toEqual([])
    const rel = edgeStyle(e('related'), undefined)
    expect(rel.dash.length).toBe(2)
    expect(rel.color).toBe('#a855f7')
  })

  it('initials and review summary', () => {
    expect(initials('alex')).toBe('AL')
    expect(initials('sam-robin')).toBe('SR')
    expect(
      reviewSummary(
        change(R, 1, {
          reviewers: [
            { login: 'a', state: 'approved' },
            { login: 'b', state: 'changes_requested' }
          ]
        })
      )
    ).toBe('changes_requested')
    expect(reviewSummary(change(R, 1))).toBeNull()
  })
})

describe('edge walk', () => {
  it('moves to the linked node most in the arrow direction', () => {
    const a = change(R, 1, { createdAt: new Date(NOW - 2 * 86_400_000).toISOString() })
    const b = change(R, 2)
    const i = issue(R, 3)
    const other = change('demo-org/app', 4)
    const edges = [edge(b, a, 'base'), edge(a, i, 'closes'), edge(other, a, 'paired')]
    const l = computeLayout({ nodes: [a, b, i, other], edges, workstreams: [], now: NOW })
    expect(walkEdge(a.id, 'right', l.edges, l.nodes)).toBe(b.id)
    // Issue in the future zone and the paired node above: each reached from its side.
    expect(walkEdge(b.id, 'left', l.edges, l.nodes)).toBe(a.id)
    expect(walkEdge(a.id, 'up', l.edges, l.nodes)).toBe(other.id)
    expect(walkEdge(a.id, 'left', l.edges, l.nodes)).toBeNull()
    // Hidden nodes are skipped: with the stack top and the pair hidden, right reaches the issue.
    expect(walkEdge(a.id, 'right', l.edges, l.nodes, (id) => id !== b.id && id !== other.id)).toBe(i.id)
    expect(keyDirection('ArrowUp')).toBe('up')
    expect(keyDirection('x')).toBeNull()
  })
})

describe('graphs', () => {
  const v = (id: string, title = id): ForgeView => ({ id, membrane: 'demo', title, repos: [], filters: {} })
  it('adds, removes, reorders, updates', () => {
    let list = [seedView('demo')]
    list = addView(list, 'demo', 'Needs my review', 'view-x', { requestedFromMe: true })
    expect(list.map((x) => x.title)).toEqual(['All repos', 'Needs my review'])
    expect(list[1].filters).toEqual({ requestedFromMe: true })
    expect(addView([], 'demo', '  ', 'id')[0].title).toBe('Untitled graph')
    list = moveView(list, 'view-x', -1)
    expect(list[0].id).toBe('view-x')
    expect(moveView(list, 'view-x', -1)).toBe(list)
    list = updateView(list, 'view-x', { filters: { dim: true } })
    expect(list[0].filters).toEqual({ dim: true })
    expect(removeView(list, 'view-x').map((x) => x.id)).toEqual(['view-demo-all'])
  })

  it('all shows every view in order; solo one; a stale solo falls back to all', () => {
    const list = [v('a'), v('b')]
    expect(shownViews(list, { mode: 'all' }).map((x) => x.id)).toEqual(['a', 'b'])
    expect(shownViews(list, { mode: 'solo', id: 'b' }).map((x) => x.id)).toEqual(['b'])
    expect(shownViews(list, { mode: 'solo', id: 'gone' }).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('new ids never collide', () => {
    let n = 0
    const rand = () => [0, 0, 0.5][n++ % 3]
    const first = newViewId([], rand)
    expect(newViewId([v(first)], rand)).not.toBe(first)
  })

  it('a view repo list narrows the repo chips', () => {
    const view: ForgeView = { ...v('a'), repos: ['x/one', 'x/two'], filters: { repos: ['x/two', 'x/three'] } }
    expect(viewFilters(view).repos).toEqual(['x/two'])
    expect(viewFilters({ ...view, filters: {} }).repos).toEqual(['x/one', 'x/two'])
    expect(viewFilters(v('b'))).toEqual({})
  })
})

describe('membrane', () => {
  const ms = [
    { id: 'notes', name: 'Notes', workspaceIds: [] },
    { id: 'work', name: 'Work', workspaceIds: ['org-a'] },
    { id: 'home', name: 'Home', workspaceIds: ['org-b'] }
  ]
  it('picks chosen → thread → workspace → first with repos', () => {
    expect(pickMembrane(ms, { chosen: 'home', threadMembrane: 'work' })).toBe('home')
    expect(pickMembrane(ms, { chosen: 'gone', threadMembrane: 'work' })).toBe('work')
    expect(pickMembrane(ms, { workspaceId: 'org-b' })).toBe('home')
    expect(pickMembrane(ms, { workspaceId: '_global' })).toBe('work')
    expect(pickMembrane([], {})).toBeNull()
  })

  it('lists the membrane threads first, archived out', () => {
    const t = threadChoices(
      [
        { id: '1', label: 'a', membraneId: 'home', lastActivity: 9 },
        { id: '2', label: 'b', membraneId: 'work', lastActivity: 1 },
        { id: '3', label: 'c', membraneId: 'work', lastActivity: 5 },
        { id: '4', label: 'd', membraneId: 'work', archived: true }
      ],
      'work'
    )
    expect(t.map((x) => x.id)).toEqual(['3', '2', '1'])
  })
})

describe('api', () => {
  function recorder(reply: unknown = {}, status = 200) {
    const calls: { url: string; method: string; body?: unknown }[] = []
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(reply === null ? '' : JSON.stringify(reply), { status })
    }) as typeof fetch
    return { calls, api: createForgeApi(f) }
  }

  it('calls each route as specified', async () => {
    const { calls, api } = recorder({ overlays: [], views: [], taskId: 't', threadId: 'th' })
    await api.graph('demo', { since: 0, until: 86_400_000, side: 'older' }, 'v1')
    await api.search('demo', 'flaky test')
    await api.overlay('demo')
    await api.assign({ nodeId: 'github:github.com/demo-org/engine#1', newThread: { label: 'engine#1' }, prompt: 'go' })
    await api.views('demo')
    await api.saveViews('demo', [])
    await api.createStream('demo', 'Rollout')
    await api.createStream('demo', 'Child', 's1')
    await api.addMember('s1', 'n#1')
    await api.removeMember('s1', 'n#1')
    await api.addMember('task://9f2c', 'n#1')
    await api.acceptEdge({ from: 'a/b#1', to: 'a/b#2', kind: 'related' })
    await api.deleteEdge({ from: 'a/b#1', to: 'a/b#2', kind: 'related' })
    expect(calls).toEqual([
      {
        url: `/api/forge?membrane=demo&view=v1&since=1970-01-01T00%3A00%3A00.000Z&until=1970-01-02T00%3A00%3A00.000Z`,
        method: 'GET',
        body: undefined
      },
      { url: '/api/forge/search?membrane=demo&q=flaky%20test', method: 'GET', body: undefined },
      { url: '/api/forge/overlay?membrane=demo', method: 'GET', body: undefined },
      {
        url: '/api/forge/assign',
        method: 'POST',
        body: { nodeId: 'github:github.com/demo-org/engine#1', newThread: { label: 'engine#1' }, prompt: 'go' }
      },
      { url: '/api/forge/views?membrane=demo', method: 'GET', body: undefined },
      { url: '/api/forge/views?membrane=demo', method: 'PUT', body: { views: [] } },
      { url: '/api/forge/streams', method: 'POST', body: { membrane: 'demo', name: 'Rollout' } },
      { url: '/api/forge/streams', method: 'POST', body: { membrane: 'demo', name: 'Child', parentId: 's1' } },
      { url: '/api/forge/streams/s1/members', method: 'POST', body: { nodeId: 'n#1' } },
      { url: '/api/forge/streams/s1/members', method: 'DELETE', body: { nodeId: 'n#1' } },
      // Stream ids are task ids ("task://<uuid>"): encoded into one path segment.
      { url: '/api/forge/streams/task%3A%2F%2F9f2c/members', method: 'POST', body: { nodeId: 'n#1' } },
      { url: '/api/forge/edges/a%2Fb%231/a%2Fb%232/related/accept', method: 'POST', body: undefined },
      { url: '/api/forge/edges/a%2Fb%231/a%2Fb%232/related', method: 'DELETE', body: undefined }
    ])
  })

  it('epics: list (archived on request), archive, refine', async () => {
    const { calls, api } = recorder({ streams: [{ id: 's1' }], threadId: 'rt-1' })
    expect(await api.streams('demo')).toEqual([{ id: 's1' }])
    await api.streams('demo', true)
    await api.archiveStream('demo', 'task://9f2c', true)
    expect(await api.refineEpics('demo', 'merge the indexer epics')).toMatchObject({ threadId: 'rt-1' })
    expect(calls).toEqual([
      { url: '/api/forge/streams?membrane=demo', method: 'GET', body: undefined },
      { url: '/api/forge/streams?membrane=demo&archived=1', method: 'GET', body: undefined },
      {
        url: '/api/forge/streams/task%3A%2F%2F9f2c/archive',
        method: 'POST',
        body: { membrane: 'demo', archived: true }
      },
      {
        url: '/api/forge/epics/refine',
        method: 'POST',
        body: { membrane: 'demo', prompt: 'merge the indexer epics' }
      }
    ])
  })

  it('sync and rethink accept an empty 202', async () => {
    const { calls, api } = recorder(null, 202)
    await api.sync('demo')
    await api.rethink('demo')
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/forge/sync?membrane=demo',
      'POST /api/forge/rethink?membrane=demo'
    ])
  })

  it('surfaces the server error message', async () => {
    const { api } = recorder({ error: 'no such membrane' }, 404)
    await expect(api.overlay('x')).rejects.toThrow('no such membrane')
  })
})
