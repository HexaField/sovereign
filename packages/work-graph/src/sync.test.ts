import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRepoCacheStore } from './cache.js'
import { createRepoSync } from './sync.js'
import { change, createFakeForge, issue, type FakeForge } from './testing.js'

const REPO = 'acme-labs/widget'
const NOW = Date.parse('2026-10-16T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

describe('repo sync', () => {
  let dataDir: string
  let forge: FakeForge
  let now: number
  const make = (f: FakeForge = forge, watched = new Set<string>()) =>
    createRepoSync(
      { forge: 'github', host: 'github.com', repo: REPO },
      { forge: f, store: createRepoCacheStore(dataDir), windowDays: 21, now: () => now, watched: () => watched }
    )

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-sync-'))
    now = NOW
    forge = createFakeForge()
    // In the window: two open, one merged. Older: an open issue, merged history.
    forge.put(change(REPO, 50, { updatedAt: daysAgo(2) }))
    forge.put(change(REPO, 51, { updatedAt: daysAgo(3), base: { branch: 'feat/50' } }))
    forge.put(change(REPO, 40, { state: 'merged', updatedAt: daysAgo(5), closedAt: daysAgo(5) }))
    forge.put(change(REPO, 10, { state: 'merged', updatedAt: daysAgo(60), closedAt: daysAgo(60) }))
    forge.put(change(REPO, 11, { state: 'closed', updatedAt: daysAgo(90), closedAt: daysAgo(90) }))
    forge.put(change(REPO, 12, { state: 'merged', updatedAt: daysAgo(120), closedAt: daysAgo(120) }))
    forge.put(issue(REPO, 5, { updatedAt: daysAgo(200) }))
    forge.put(issue(REPO, 6, { state: 'closed', updatedAt: daysAgo(150), closedAt: daysAgo(150) }))
    forge.put(issue(REPO, 7, { updatedAt: daysAgo(1) }))
    forge.branches.set(REPO, [
      { name: 'dev', sha: 'dev-1' },
      { name: 'feat/50', sha: 'sha-50-1' },
      { name: 'feat/51', sha: 'sha-51-1' }
    ])
  })
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }))

  it('first sync reads the 21-day window and every open item, raises no events, and sets the backfill line', async () => {
    const s = make()
    const r = await s.syncOpen()
    expect(r.events).toEqual([])
    const c = s.cache()
    expect(Object.keys(c.changes).sort()).toEqual(['40', '50', '51'])
    // Issue 5 is 200 days old but open: it is in.
    expect(Object.keys(c.issues).sort()).toEqual(['5', '7'])
    expect(c.backfillUntil).toBe(daysAgo(21))
    expect(c.windowSyncedAt).toBeDefined()
    const sinces = forge.calls.filter((x) => x.op === 'listChanges').map((x) => x.opts)
    expect(sinces).toContainEqual({ since: daysAgo(21) })
    expect(sinces).toContainEqual({ state: 'open' })
    // Bodies are dropped once read.
    expect(c.changes['50'].body).toBe('')
  })

  it('backfills older history page by page below the window, then issues, without events', async () => {
    const s = make()
    await s.syncOpen()
    const steps: number[] = []
    for (let i = 0; i < 10 && !s.backfillDone(); i++) steps.push((await s.backfillStep()).items)
    expect(s.backfillDone()).toBe(true)
    const c = s.cache()
    expect(Object.keys(c.changes).sort()).toEqual(['10', '11', '12', '40', '50', '51'])
    expect(Object.keys(c.issues).sort()).toEqual(['5', '6', '7'])
    const pages = forge.calls.filter((x) => x.op === 'pageChanges')
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.every((p) => (p.opts as { until: string }).until === daysAgo(21))).toBe(true)
    expect(c.backfill.changes).toMatchObject({ done: true, items: 3 })
    expect(steps.reduce((a, b) => a + b, 0)).toBe(5)
  })

  it('resumes the backfill from the persisted cursor after a restart', async () => {
    const s = make()
    await s.syncOpen()
    await s.backfillStep()
    const cursor = s.cache().backfill.changes.cursor
    expect(cursor).toBeDefined()
    const f2 = createFakeForge()
    f2.changes = forge.changes
    f2.issues = forge.issues
    const restarted = make(f2)
    await restarted.backfillStep()
    expect(f2.calls.find((x) => x.op === 'pageChanges')?.opts).toMatchObject({ after: cursor })
    // The restart did not re-run the window sync.
    expect(f2.calls.some((x) => x.op === 'listChanges')).toBe(false)
  })

  it('serves the cache on a cold start before any forge call', async () => {
    await make().syncOpen()
    const f2 = createFakeForge()
    const cold = make(f2)
    expect(Object.keys(cold.cache().changes).sort()).toEqual(['40', '50', '51'])
    expect(f2.calls).toEqual([])
    const file = path.join(dataDir, 'forge', 'cache', 'github_github.com_acme-labs_widget.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).repo).toBe(REPO)
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('without a page API the backfill is one list below the window', async () => {
    const f = createFakeForge({ paging: false })
    f.changes = forge.changes
    f.issues = forge.issues
    const s = make(f)
    await s.syncOpen()
    await s.backfillStep()
    await s.backfillStep()
    expect(s.backfillDone()).toBe(true)
    expect(f.calls.filter((x) => x.op === 'listChanges').map((x) => x.opts)).toContainEqual({ until: daysAgo(21) })
    expect(Object.keys(s.cache().changes)).toHaveLength(6)
  })

  it('the open refresh re-reads CI of open changes even when updatedAt did not move, naming the failures once per sha', async () => {
    const s = make()
    await s.syncOpen()
    const c50 = forge.changes.get(REPO)!.find((c) => c.ref.id === '50')!
    // A check result does not move updatedAt.
    c50.checks = { state: 'failing' }
    forge.checkResults.set(`${REPO}#50`, { state: 'failing', failed: ['integration-tests'] })
    now += 120_000
    const r = await s.syncOpen()
    expect(r.events.filter((e) => e.type === 'ci_failed')).toEqual([
      expect.objectContaining({
        nodeId: 'github:github.com/acme-labs/widget#50',
        detail: expect.objectContaining({ failed: ['integration-tests'] })
      })
    ])
    expect(s.cache().changes['50'].checks).toEqual({ state: 'failing', failed: ['integration-tests'] })
    now += 120_000
    const again = await s.syncOpen()
    expect(again.events.filter((e) => e.type === 'ci_failed')).toEqual([])
    expect(forge.calls.filter((x) => x.op === 'checks')).toHaveLength(1)
    // Green again.
    c50.checks = { state: 'passing' }
    now += 120_000
    const green = await s.syncOpen()
    expect(green.events.find((e) => e.type === 'ci_passed')?.detail).toMatchObject({ from: 'failing' })
  })

  it('a merge lands within one open refresh, with base_merged on the change stacked on it', async () => {
    const s = make()
    await s.syncOpen()
    now += 60_000
    forge.put(
      change(REPO, 50, {
        state: 'merged',
        updatedAt: new Date(now).toISOString(),
        closedAt: new Date(now).toISOString()
      })
    )
    now += 60_000
    const r = await s.syncOpen()
    expect(r.events.map((e) => [e.nodeId.split('#')[1], e.type])).toEqual(
      expect.arrayContaining([
        ['50', 'merged'],
        ['51', 'base_merged']
      ])
    )
    expect(s.cache().changes['50'].state).toBe('merged')
  })

  it('compares open branches against their base once per head + base sha; a rise in behind is an event', async () => {
    forge.compares.set(`${REPO}:dev...feat/50`, { ahead: 3, behind: 0 })
    const s = make()
    await s.syncOpen()
    expect(s.cache().changes['50'].compare).toMatchObject({ ahead: 3, behind: 0 })
    const compares = () => forge.calls.filter((x) => x.op === 'compare').length
    const first = compares()
    now += 120_000
    await s.syncOpen()
    expect(compares()).toBe(first)
    // dev moves: the all refresh reads the branch list, the next compare sees it.
    forge.branches.set(REPO, [
      { name: 'dev', sha: 'dev-2' },
      { name: 'feat/50', sha: 'sha-50-1' }
    ])
    forge.compares.set(`${REPO}:dev...feat/50`, { ahead: 3, behind: 4 })
    now += 600_000
    const r = await s.syncAll()
    expect(r.events).toContainEqual(
      expect.objectContaining({
        nodeId: 'github:github.com/acme-labs/widget#50',
        type: 'behind_base',
        detail: { base: 'dev', behind: 4 }
      })
    )
    expect(compares()).toBe(first + 1)
  })

  it('diffs reviews, labels, assignees, pushes and conflicts into events', async () => {
    const s = make()
    await s.syncOpen()
    now += 60_000
    const t = new Date(now).toISOString()
    forge.put(
      change(REPO, 50, {
        updatedAt: t,
        head: { branch: 'feat/50', sha: 'sha-50-2' },
        reviewers: [
          { login: 'sam-reviewer', state: 'changes_requested' },
          { login: 'jo-maintainer', state: 'requested' }
        ],
        labels: ['perf'],
        assignees: ['hex-agent'],
        mergeable: false
      })
    )
    now += 60_000
    const types = (await s.syncOpen()).events.map((e) => e.type).sort()
    expect(types).toEqual(['assigned', 'conflict', 'labelled', 'pushed', 'review_requested', 'reviewed'])
  })

  it('reads comments of watched items only; new ones are a commented event', async () => {
    const watched = new Set(['github:github.com/acme-labs/widget#50'])
    const s = make(forge, watched)
    await s.syncOpen()
    now += 60_000
    await s.syncOpen()
    forge.commentsOf.set(`${REPO}#50`, [
      { author: 'sam-reviewer', body: 'Please fix the @hex-agent thing', createdAt: new Date(now).toISOString() }
    ])
    now += 60_000
    const r = await s.syncOpen()
    expect(r.events.find((e) => e.type === 'commented')?.detail).toEqual({
      count: 1,
      authors: ['sam-reviewer'],
      text: ['Please fix the @hex-agent thing']
    })
    expect(new Set(forge.calls.filter((x) => x.op === 'comments').map((x) => x.opts))).toEqual(new Set(['50']))
  })

  it('reports an open change stale once', async () => {
    forge.put(change(REPO, 60, { updatedAt: daysAgo(15) }))
    const s = make()
    await s.syncOpen()
    // Already stale at the first sync: noted, no event.
    expect(s.cache().stale).toContain('github:github.com/acme-labs/widget#60')
    now += 4 * 86_400_000
    const r = await s.syncOpen()
    // #51 (updated 3 days before NOW) crossed 14 days now.
    expect(r.events.filter((e) => e.type === 'stale').map((e) => e.nodeId)).toEqual([])
    now += 10 * 86_400_000
    const r2 = await s.syncOpen()
    expect(
      r2.events
        .filter((e) => e.type === 'stale')
        .map((e) => e.nodeId)
        .sort()
    ).toEqual(['github:github.com/acme-labs/widget#50', 'github:github.com/acme-labs/widget#51'])
  })

  it('a failing list rejects the sync and leaves the cache as it was', async () => {
    const s = make()
    await s.syncOpen()
    const before = JSON.stringify(s.cache().changes)
    forge.failNext = new Error('GitHub 502')
    now += 60_000
    await expect(s.syncOpen()).rejects.toThrow('GitHub 502')
    expect(JSON.stringify(s.cache().changes)).toBe(before)
    // The next job still runs (the per-repo queue survives a failure).
    await expect(s.syncOpen()).resolves.toBeDefined()
  })
})
