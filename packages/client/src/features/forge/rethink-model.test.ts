import { describe, expect, it } from 'vitest'
import { createForgeApi } from './api.js'
import {
  actionCount,
  phaseAfterRuns,
  phaseAfterStart,
  phaseLabel,
  runLinkLabel,
  type RethinkRunSummary,
  type RethinkRuns
} from './rethink-model.js'

const run = (over: Partial<RethinkRunSummary> = {}): RethinkRunSummary => ({
  id: '2026-10-16-0830',
  membrane: 'demo',
  trigger: 'manual',
  status: 'done',
  startedAt: '2026-10-16T08:30:00.000Z',
  endedAt: '2026-10-16T08:33:00.000Z',
  events: 3,
  actions: { relate: 1, stream: 0, dispatch: 2, draft: 0, attention: 1, note: 1, refused: 1 },
  limitsHit: 1,
  path: '/data/forge/demo/rethink/2026-10-16-0830.md',
  ...over
})
const list = (over: Partial<RethinkRuns> = {}): RethinkRuns => ({
  membrane: 'demo',
  threadId: 'rt-1',
  active: null,
  runs: [run()],
  ...over
})

describe('rethink status', () => {
  it('start: empty digest → skipped; a run → running', () => {
    expect(phaseAfterStart({ ran: false, count: 0 })).toEqual({ phase: 'skipped' })
    expect(phaseAfterStart(undefined)).toEqual({ phase: 'skipped' })
    expect(phaseAfterStart({ ran: true, count: 3, runId: 'r1' })).toEqual({ phase: 'running', runId: 'r1' })
    expect(phaseLabel({ phase: 'skipped' })).toBe('Rethink skipped: nothing new since the last run')
    expect(phaseLabel({ phase: 'running', runId: 'r1' })).toBe('Rethink running…')
    expect(phaseLabel({ phase: 'idle' })).toBeNull()
  })

  it('runs: running until its run has ended, then done with the action count', () => {
    const running = { phase: 'running' as const, runId: '2026-10-16-0830' }
    expect(
      phaseAfterRuns(running, list({ active: { id: '2026-10-16-0830', startedAt: '', trigger: 'manual' } }))
    ).toEqual(running)
    const done = phaseAfterRuns(running, list())
    expect(done).toEqual({ phase: 'done', run: run() })
    expect(actionCount(run())).toBe(5)
    // Epic changes (forge_stream_* tools) count as actions.
    expect(actionCount(run({ actions: { ...run().actions, epic: 3 } }))).toBe(8)
    expect(actionCount(run({ actions: { ...run().actions, supersede: 2 } }))).toBe(7)
    expect(phaseLabel(done)).toBe('Rethink done: 5 actions, 1 limit hit')
    expect(phaseLabel({ phase: 'done', run: run({ status: 'timed-out', limitsHit: 0 }) })).toBe(
      'Rethink timed out: 5 actions'
    )
    // A scheduled run seen on load shows as running; skipped/failed stay.
    expect(
      phaseAfterRuns({ phase: 'idle' }, list({ active: { id: 'x', startedAt: '', trigger: 'schedule' } }))
    ).toEqual({
      phase: 'running',
      runId: 'x'
    })
    expect(phaseAfterRuns({ phase: 'idle' }, list())).toEqual({ phase: 'idle' })
    expect(phaseAfterRuns({ phase: 'skipped' }, list())).toEqual({ phase: 'skipped' })
    expect(phaseLabel({ phase: 'failed', error: 'a rethink run is already in progress' })).toBe(
      'Rethink failed: a rethink run is already in progress'
    )
  })

  it('labels the latest run link', () => {
    expect(runLinkLabel(run({ status: 'running' }))).toMatch(/^Last rethink: .+ \(running\)$/)
    expect(runLinkLabel(run({ startedAt: 'bad' }))).toBe('Last rethink: 2026-10-16-0830')
  })
})

describe('rethink api', () => {
  it('starts a run, lists runs and reads a report', async () => {
    const calls: string[] = []
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.startsWith('/api/forge/rethink/runs/')) return new Response('# Forge rethink — demo', { status: 200 })
      if (url.startsWith('/api/forge/rethink/runs')) return new Response(JSON.stringify(list()), { status: 200 })
      return new Response(JSON.stringify({ membrane: 'demo', ran: true, count: 2, runId: 'r1' }), { status: 200 })
    }) as typeof fetch
    const api = createForgeApi(f)
    expect(await api.rethink('demo')).toEqual({ membrane: 'demo', ran: true, count: 2, runId: 'r1' })
    expect((await api.rethinkRuns('demo')).runs[0].id).toBe('2026-10-16-0830')
    expect(await api.rethinkReport('demo', '2026-10-16-0830')).toBe('# Forge rethink — demo')
    expect(calls).toEqual([
      'POST /api/forge/rethink?membrane=demo',
      'GET /api/forge/rethink/runs?membrane=demo',
      'GET /api/forge/rethink/runs/2026-10-16-0830?membrane=demo'
    ])
  })

  it('surfaces a missing report', async () => {
    const api = createForgeApi(
      (async () => new Response(JSON.stringify({ error: 'no such run' }), { status: 404 })) as typeof fetch
    )
    await expect(api.rethinkReport('demo', 'x')).rejects.toThrow('no such run')
  })
})
