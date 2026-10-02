import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CI_POLL, createCiWatchService, selectChecks, toCheckStates, type GithubGet } from './service.js'

type Status = { context: string; state: string; target_url?: string; description?: string }
type Run = { name: string; status: string; conclusion?: string | null; html_url?: string; output?: { title?: string } }

/** A fake GitHub: per-commit statuses and check runs, PR heads, and ETags. */
function fakeGithub() {
  const statuses = new Map<string, Status[]>()
  const runs = new Map<string, Run[]>()
  const prHead = new Map<number, string>()
  const calls: Array<{ path: string; etag?: string; status: number }> = []
  const state = { failures: 0 }
  const fake = { hold: undefined as undefined | (() => Promise<void>) }
  const bodyOf = (p: string): unknown => {
    let m = p.match(/^repos\/o\/r\/pulls\/(\d+)$/)
    if (m) {
      const sha = prHead.get(Number(m[1]))
      if (!sha) throw new Error(`GitHub 404 for ${p}`)
      return { head: { sha } }
    }
    const page = Number(p.match(/[?&]page=(\d+)/)?.[1] ?? 1)
    const slice = <T>(all: T[]) => all.slice((page - 1) * 100, page * 100)
    m = p.match(/^repos\/o\/r\/commits\/([^/]+)\/check-runs/)
    if (m) return { total_count: (runs.get(m[1]) ?? []).length, check_runs: slice(runs.get(m[1]) ?? []) }
    m = p.match(/^repos\/o\/r\/commits\/([^/]+)\/status/)
    if (m) return { total_count: (statuses.get(m[1]) ?? []).length, statuses: slice(statuses.get(m[1]) ?? []) }
    m = p.match(/^repos\/o\/r\/commits\/([^/]+)$/)
    if (m) return { sha: `sha-of-${decodeURIComponent(m[1])}` }
    throw new Error(`GitHub 404 for ${p}`)
  }
  const get: GithubGet = async (p, etag) => {
    if (fake.hold) await fake.hold()
    if (state.failures > 0) {
      state.failures--
      calls.push({ path: p, etag, status: 502 })
      throw new Error('GitHub 502')
    }
    const body = bodyOf(p)
    const tag = `"${JSON.stringify(body).length}-${JSON.stringify(body)}"`
    const status = etag === tag ? 304 : 200
    calls.push({ path: p, etag, status })
    return status === 304 ? { status, etag: tag } : { status, etag: tag, body }
  }
  return {
    get,
    statuses,
    runs,
    prHead,
    calls,
    state,
    set hold(fn: undefined | (() => Promise<void>)) {
      fake.hold = fn
    }
  }
}

describe('ci-watch', () => {
  let dataDir: string
  let clock: number
  let gh: ReturnType<typeof fakeGithub>
  let sent: Array<{ threadKey: string; text: string }>
  const make = () =>
    createCiWatchService({
      dataDir,
      github: gh.get,
      now: () => clock,
      notify: async (threadKey, text) => {
        sent.push({ threadKey, text })
      }
    })
  /** Advance the clock and poll whatever is due, like the timer does. */
  const advance = async (svc: ReturnType<typeof make>, ms: number) => {
    const end = clock + ms
    while (clock < end) {
      clock = Math.min(end, clock + CI_POLL.pollMs)
      await svc.pollDue()
    }
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ci-watch-'))
    clock = 1_000_000
    gh = fakeGithub()
    sent = []
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  it('notifies once when a CircleCI-style run finishes, not while dependants are still being posted', async () => {
    gh.prHead.set(7, 'aaa')
    gh.statuses.set('aaa', [
      { context: 'ci/circleci: build', state: 'pending' },
      { context: 'ci/circleci: fmt', state: 'pending' }
    ])
    const svc = make()
    const { snapshot } = await svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 7 } })
    expect(snapshot.checks.map((c) => c.state)).toEqual(['pending', 'pending'])

    // Both visible jobs pass; the dependant job has not been posted yet.
    gh.statuses.set('aaa', [
      { context: 'ci/circleci: build', state: 'success' },
      { context: 'ci/circleci: fmt', state: 'success' }
    ])
    await advance(svc, 10_000) // one poll sees everything finished; the settle window opens
    expect(sent).toHaveLength(0)
    // The dependant appears before the settle window closes.
    gh.statuses.set('aaa', [...gh.statuses.get('aaa')!, { context: 'ci/circleci: integration', state: 'pending' }])
    await advance(svc, 60_000)
    expect(sent).toHaveLength(0)

    gh.statuses.set(
      'aaa',
      gh.statuses.get('aaa')!.map((s) => ({ ...s, state: 'success' }))
    )
    await advance(svc, 60_000)
    expect(sent).toHaveLength(1)
    expect(sent[0].threadKey).toBe('t1')
    expect(sent[0].text).toMatch(
      /^\[Cron: CI o\/r#7 @ [^\]]+\] CI passed on o\/r#7 \(aaa\): all 3 checks finished — 3 passed\./
    )
    expect(svc.list()).toHaveLength(0)

    await advance(svc, 120_000)
    expect(sent).toHaveLength(1)
  })

  it('reports the first failure at once, with links and summaries', async () => {
    gh.prHead.set(7, 'aaa')
    gh.runs.set('aaa', [
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'in_progress' }
    ])
    gh.statuses.set('aaa', [{ context: 'ci/circleci: e2e', state: 'pending' }])
    const svc = make()
    await svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 7 } })

    gh.runs.set('aaa', [
      { name: 'lint', status: 'completed', conclusion: 'success' },
      {
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://gh/test',
        output: { title: '3 tests failed' }
      }
    ])
    await advance(svc, 30_000)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('CI failed on o/r#7 (aaa): 1 of 3 checks failed, 1 still running.')
    expect(sent[0].text).toContain('✗ test — failure — https://gh/test\n  3 tests failed')
    expect(svc.list()).toHaveLength(0)
  })

  it('reports red within one poll and green within two, measured from the change on GitHub', async () => {
    gh.prHead.set(7, 'red')
    gh.prHead.set(8, 'green')
    gh.statuses.set('red', [
      { context: 'a', state: 'pending' },
      { context: 'b', state: 'pending' }
    ])
    gh.statuses.set('green', [{ context: 'a', state: 'pending' }])
    const svc = make()
    await svc.watch({ threadKey: 'red', repo: 'o/r', target: { kind: 'pr', number: 7 } })
    await svc.watch({ threadKey: 'green', repo: 'o/r', target: { kind: 'pr', number: 8 } })
    await advance(svc, 3_000)

    // One check fails while the other is still running.
    const redAt = clock
    gh.statuses.set('red', [
      { context: 'a', state: 'failure' },
      { context: 'b', state: 'pending' }
    ])
    const greenAt = clock
    gh.statuses.set('green', [{ context: 'a', state: 'success' }])
    const arrival: Record<string, number> = {}
    while (Object.keys(arrival).length < 2 && clock < greenAt + 60_000) {
      await advance(svc, 1_000)
      for (const m of sent) arrival[m.threadKey] ??= clock
    }
    expect(arrival.red - redAt).toBeLessThanOrEqual(CI_POLL.pollMs)
    expect(arrival.green - greenAt).toBeLessThanOrEqual(2 * CI_POLL.pollMs)
  })

  it('follows a push to the PR, and stays on the commit when follow is off', async () => {
    gh.prHead.set(7, 'aaa')
    gh.statuses.set('aaa', [{ context: 'ci', state: 'pending' }])
    gh.statuses.set('bbb', [{ context: 'ci', state: 'pending' }])
    const svc = make()
    const following = await svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 7 } })
    const pinned = await svc.watch({ threadKey: 't2', repo: 'o/r', target: { kind: 'pr', number: 7 }, follow: false })

    gh.prHead.set(7, 'bbb')
    gh.statuses.set('aaa', [{ context: 'ci', state: 'failure' }])
    await advance(svc, 30_000)
    // The pinned watch sees the old commit fail; the following one moved on.
    expect(sent.map((s) => s.threadKey)).toEqual(['t2'])
    expect(svc.list().find((w) => w.id === following.watch.id)?.sha).toBe('bbb')
    expect(svc.list().find((w) => w.id === pinned.watch.id)).toBeUndefined()

    gh.statuses.set('bbb', [{ context: 'ci', state: 'success' }])
    await advance(svc, 60_000)
    expect(sent[1].threadKey).toBe('t1')
    expect(sent[1].text).toContain('(bbb)')
    expect(sent[1].text).toContain('Followed 1 push while watching.')
  })

  it('waits for every named check, and ignores the others', async () => {
    gh.statuses.set('sha-of-main', [
      { context: 'ci/circleci: build', state: 'success' },
      { context: 'CodeRabbit', state: 'pending' }
    ])
    const svc = make()
    const { snapshot } = await svc.watch({
      threadKey: 't1',
      repo: 'o/r',
      target: { kind: 'branch', name: 'main' },
      checks: ['build', 'integration-tests-js']
    })
    expect(snapshot.missing).toEqual(['integration-tests-js'])
    await advance(svc, 120_000)
    expect(sent).toHaveLength(0)
    gh.statuses.set('sha-of-main', [
      ...gh.statuses.get('sha-of-main')!,
      { context: 'ci/circleci: integration-tests-js', state: 'success' }
    ])
    await advance(svc, 60_000)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('all 2 checks finished')
  })

  it('rejects a target GitHub does not know, and creates no watch', async () => {
    const svc = make()
    await expect(svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 99 } })).rejects.toThrow(/404/)
    await expect(svc.watch({ threadKey: 't1', repo: 'not a repo', target: { kind: 'sha', sha: 'x' } })).rejects.toThrow(
      /owner\/name/
    )
    expect(svc.list()).toHaveLength(0)
  })

  it('uses conditional requests, so unchanged polls are 304s', async () => {
    gh.prHead.set(7, 'aaa')
    gh.statuses.set('aaa', [{ context: 'ci', state: 'pending' }])
    const svc = make()
    await svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 7 } })
    gh.calls.length = 0
    await advance(svc, 30_000)
    expect(gh.calls.length).toBeGreaterThan(0)
    expect(gh.calls.every((c) => c.status === 304)).toBe(true)
  })

  it('survives a restart, and stops on timeout or when no check ever appears', async () => {
    gh.prHead.set(7, 'aaa')
    gh.statuses.set('aaa', [{ context: 'ci', state: 'pending' }])
    gh.prHead.set(8, 'ccc')
    const first = make()
    await first.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 7 }, timeoutMinutes: 10 })
    await first.watch({ threadKey: 't2', repo: 'o/r', target: { kind: 'pr', number: 8 } })
    first.dispose()

    const second = make()
    expect(
      second
        .list()
        .map((w) => w.threadKey)
        .sort()
    ).toEqual(['t1', 't2'])
    await advance(second, 11 * 60_000)
    expect(sent.map((s) => s.threadKey)).toEqual(['t1'])
    expect(sent[0].text).toContain('timed out — 1 still running (ci).')
    await advance(second, CI_POLL.noChecksTimeoutMs)
    expect(sent[1].threadKey).toBe('t2')
    expect(sent[1].text).toContain('No CI checks appeared')
    expect(second.list()).toHaveLength(0)
  })

  it('backs off on GitHub errors and recovers', async () => {
    gh.prHead.set(7, 'aaa')
    gh.statuses.set('aaa', [{ context: 'ci', state: 'pending' }])
    const svc = make()
    await svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 7 } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      gh.state.failures = 3
      gh.calls.length = 0
      // Polls at 10 s and 30 s fail; the next waits 40 s (to 70 s). Without
      // backoff a 10 s loop would make 6 calls in this minute.
      await advance(svc, 60_000)
      expect(gh.calls.map((c) => c.status)).toEqual([502, 502])
      await advance(svc, 60_000)
      expect(gh.calls.filter((c) => c.status === 502)).toHaveLength(3)
      gh.statuses.set('aaa', [{ context: 'ci', state: 'failure' }])
      await advance(svc, 5 * 60_000)
      expect(sent).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('reads every page of a long check list before calling it done', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      context: `job-${String(i).padStart(3, '0')}`,
      state: 'success'
    }))
    many[149] = { context: 'job-149', state: 'pending' }
    gh.prHead.set(7, 'aaa')
    gh.statuses.set('aaa', many)
    const svc = make()
    const { snapshot } = await svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 7 } })
    expect(snapshot.checks).toHaveLength(150)
    await advance(svc, 120_000)
    expect(sent).toHaveLength(0)
  })

  it('a failure posted under the same name by another source wins', async () => {
    gh.prHead.set(7, 'aaa')
    gh.runs.set('aaa', [{ name: 'build', status: 'completed', conclusion: 'success' }])
    gh.statuses.set('aaa', [{ context: 'build', state: 'failure' }])
    const svc = make()
    await svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 7 } })
    await advance(svc, 30_000)
    expect(sent[0].text).toContain('CI failed')
  })

  it('stops after repeated errors and tells the thread, e.g. a deleted branch', async () => {
    gh.statuses.set('sha-of-feature', [{ context: 'ci', state: 'pending' }])
    const svc = make()
    await svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'branch', name: 'feature' } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      gh.state.failures = 1_000
      await advance(svc, 3 * 60 * 60_000)
      expect(sent).toHaveLength(1)
      expect(sent[0].text).toMatch(/^\[Cron: CI o\/r:feature @ /)
      expect(sent[0].text).toContain(`${CI_POLL.maxErrors} polls in a row failed`)
      expect(svc.list()).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not notify when unwatched while a poll is in flight', async () => {
    gh.prHead.set(7, 'aaa')
    gh.statuses.set('aaa', [{ context: 'ci', state: 'pending' }])
    const svc = make()
    const { watch } = await svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 7 } })
    gh.statuses.set('aaa', [{ context: 'ci', state: 'failure' }])
    const inner = gh.get
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    gh.hold = async () => gate
    clock += 30_000
    const polling = svc.pollDue()
    svc.unwatch(watch.id)
    release()
    await polling
    void inner
    expect(sent).toHaveLength(0)
  })

  it('keeps the watch and retries when delivery fails', async () => {
    gh.prHead.set(7, 'aaa')
    gh.statuses.set('aaa', [{ context: 'ci', state: 'failure' }])
    let refuse = true
    const svc = createCiWatchService({
      dataDir,
      github: gh.get,
      now: () => clock,
      notify: async (threadKey, text) => {
        if (refuse) throw new Error('chat down')
        sent.push({ threadKey, text })
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 7 } })
      await advance(svc, 30_000)
      expect(svc.list()).toHaveLength(1)
      refuse = false
      await advance(svc, 5 * 60_000)
      expect(sent).toHaveLength(1)
      expect(svc.list()).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects a malformed sha or repo', async () => {
    const svc = make()
    await expect(
      svc.watch({ threadKey: 't', repo: 'o/r', target: { kind: 'sha', sha: '../pulls/1' } })
    ).rejects.toThrow(/hex/)
    await expect(svc.watch({ threadKey: 't', repo: '../..', target: { kind: 'sha', sha: 'abcdef1' } })).rejects.toThrow(
      /owner\/name/
    )
  })

  it('unwatch removes a watch', async () => {
    gh.prHead.set(7, 'aaa')
    gh.statuses.set('aaa', [{ context: 'ci', state: 'pending' }])
    const svc = make()
    const { watch } = await svc.watch({ threadKey: 't1', repo: 'o/r', target: { kind: 'pr', number: 7 } })
    expect(svc.unwatch(watch.id)).toBe(true)
    expect(svc.unwatch(watch.id)).toBe(false)
    expect(make().list()).toHaveLength(0) // gone after a restart too
    gh.statuses.set('aaa', [{ context: 'ci', state: 'failure' }])
    await advance(svc, 60_000)
    expect(sent).toHaveLength(0)
  })
})

describe('ci-watch check folding', () => {
  it('maps check runs and statuses to one state per name, check runs first', () => {
    const states = toCheckStates(
      [
        { name: 'a', status: 'queued' },
        { name: 'b', status: 'completed', conclusion: 'timed_out' },
        { name: 'c', status: 'completed', conclusion: 'skipped' }
      ],
      [
        { context: 'a', state: 'success' },
        { context: 'd', state: 'error' }
      ]
    )
    expect(states.map((s) => [s.name, s.state])).toEqual([
      ['a', 'pending'],
      ['b', 'failure'],
      ['c', 'neutral'],
      ['d', 'failure']
    ])
  })

  it('selects checks by case-insensitive substring', () => {
    const all = toCheckStates([], [{ context: 'ci/circleci: Build', state: 'success' }])
    expect(selectChecks(all, ['build', 'lint'])).toEqual({ checks: all, missing: ['lint'] })
  })
})
