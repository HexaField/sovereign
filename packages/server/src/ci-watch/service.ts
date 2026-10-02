// CI watch — follows the GitHub checks of one PR, branch or commit and tells
// a thread once when they finish or fail. One 10 s loop in the server polls
// every watch through the GitHub REST API, so it works for any repo the `gh`
// account can read, and a watch costs no model turn until its one message.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TAG = '[ci-watch]'

export type CiTarget = { kind: 'pr'; number: number } | { kind: 'branch'; name: string } | { kind: 'sha'; sha: string }

export interface CiWatch {
  id: string
  threadKey: string
  repo: string
  target: CiTarget
  /** For a PR or branch: move to the new head commit after a push. */
  follow: boolean
  /** Only these checks count (case-insensitive substring of the check name). */
  checks?: string[]
  label: string
  /** Commit being watched; set by the first poll. */
  sha?: string
  /** Commits passed over while following pushes. */
  shaChanges: number
  createdAt: number
  expiresAt: number
}

export interface CheckState {
  name: string
  state: 'pending' | 'success' | 'failure' | 'neutral'
  conclusion?: string
  url?: string
  summary?: string
}

export interface CiSnapshot {
  sha: string
  checks: CheckState[]
  /** Names from `checks` that no check matches yet. */
  missing: string[]
}

export interface GithubResponse {
  status: number
  etag?: string
  body?: unknown
}

/** GET an api.github.com path, optionally conditional on an ETag. */
export type GithubGet = (apiPath: string, etag?: string) => Promise<GithubResponse>

export interface CiWatchServiceDeps {
  dataDir: string
  /** Deliver a message into a thread through the normal chat queue. */
  notify(threadKey: string, text: string): Promise<void>
  github?: GithubGet
  now?: () => number
}

export interface CiWatchOpts {
  threadKey: string
  repo: string
  target: CiTarget
  follow?: boolean
  checks?: string[]
  label?: string
  timeoutMinutes?: number
}

export interface CiWatchService {
  watch(opts: CiWatchOpts): Promise<{ watch: CiWatch; snapshot: CiSnapshot }>
  list(threadKey?: string): CiWatch[]
  unwatch(id: string): boolean
  /** Poll every watch not in error backoff (the 10 s timer calls this). */
  pollDue(): Promise<void>
  start(): void
  dispose(): void
}

/** Poll cadence. */
export const CI_POLL = {
  /** One loop polls every watch this often (errors back off from it). */
  pollMs: 10_000,
  maxBackoffMs: 300_000,
  /** Stop after this many polls in a row fail. */
  maxErrors: 10,
  /** Green must hold on the next poll. CircleCI posts a job's dependants about
   *  a second after the job passes, so one all-finished poll can be partial. */
  settleMs: 10_000,
  /** Give up when no check has appeared after this long. */
  noChecksTimeoutMs: 20 * 60_000
}

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'error'])

/** Default GitHub client: fetch with the `gh` CLI's token. */
export function createGithubGet(exec: typeof execFileAsync = execFileAsync): GithubGet {
  let token: string | undefined
  const getToken = async (refresh = false) => {
    if (!token || refresh) token = (await exec('gh', ['auth', 'token'])).stdout.trim()
    return token
  }
  const get: GithubGet = async (apiPath, etag) => {
    const send = async (refresh: boolean) =>
      fetch(`https://api.github.com/${apiPath}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${await getToken(refresh)}`,
          ...(etag ? { 'If-None-Match': etag } : {})
        }
      })
    let res = await send(false)
    if (res.status === 401) res = await send(true)
    const body = res.status === 200 ? await res.json() : undefined
    if (res.status !== 200 && res.status !== 304) {
      throw new Error(`GitHub ${res.status} for ${apiPath}`)
    }
    return { status: res.status, etag: res.headers.get('etag') ?? undefined, body }
  }
  return get
}

const RANK: Record<CheckState['state'], number> = { failure: 3, pending: 2, neutral: 1, success: 0 }

/** Fold check runs and commit statuses into one state per check name. When
 *  two sources post the same name, the worse state wins. */
export function toCheckStates(checkRuns: any[], statuses: any[]): CheckState[] {
  const out = new Map<string, CheckState>()
  const keep = (c: CheckState) => {
    const prev = out.get(c.name)
    if (!prev || RANK[c.state] > RANK[prev.state]) out.set(c.name, c)
  }
  for (const r of checkRuns) {
    const conclusion = r.status === 'completed' ? (r.conclusion ?? 'neutral') : undefined
    keep({
      name: r.name,
      state: !conclusion
        ? 'pending'
        : conclusion === 'success'
          ? 'success'
          : FAILED.has(conclusion)
            ? 'failure'
            : 'neutral',
      conclusion: conclusion ?? r.status,
      url: r.html_url ?? r.details_url,
      summary: r.output?.title ?? undefined
    })
  }
  for (const s of statuses) {
    keep({
      name: s.context,
      state: s.state === 'pending' ? 'pending' : s.state === 'success' ? 'success' : 'failure',
      conclusion: s.state,
      url: s.target_url ?? undefined,
      summary: s.description ?? undefined
    })
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Restrict to the watched checks; report filters that match nothing yet. */
export function selectChecks(all: CheckState[], filters?: string[]): { checks: CheckState[]; missing: string[] } {
  if (!filters?.length) return { checks: all, missing: [] }
  const lower = filters.map((f) => f.toLowerCase())
  const checks = all.filter((c) => lower.some((f) => c.name.toLowerCase().includes(f)))
  const missing = filters.filter((_f, i) => !all.some((c) => c.name.toLowerCase().includes(lower[i])))
  return { checks, missing }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function targetText(w: Pick<CiWatch, 'repo' | 'target'>): string {
  const t = w.target
  // No '@': the cron envelope ends its label at the first '@'.
  return t.kind === 'pr'
    ? `${w.repo}#${t.number}`
    : t.kind === 'branch'
      ? `${w.repo}:${t.name}`
      : `${w.repo}:${t.sha.slice(0, 7)}`
}

/** The message a thread receives. Uses the cron envelope, so the chat shows it as a system card. */
export function formatNotification(w: CiWatch, snap: CiSnapshot, at: number, reason: 'failed' | 'done'): string {
  const head = `[Cron: CI ${targetText(w)} @ ${new Date(at).toISOString()}]`
  const failed = snap.checks.filter((c) => c.state === 'failure')
  const pending = snap.checks.filter((c) => c.state === 'pending')
  const passed = snap.checks.filter((c) => c.state === 'success').length
  const neutral = snap.checks.filter((c) => c.state === 'neutral').length
  const sha = snap.sha.slice(0, 9)
  const lines: string[] = []
  if (failed.length) {
    lines.push(
      `CI failed on ${targetText(w)} (${sha}): ${failed.length} of ${plural(snap.checks.length, 'check')} failed` +
        (reason === 'failed' && pending.length ? `, ${pending.length} still running.` : '.')
    )
    for (const c of failed) {
      lines.push(`✗ ${c.name} — ${c.conclusion}${c.url ? ` — ${c.url}` : ''}`)
      if (c.summary) lines.push(`  ${c.summary}`)
    }
    lines.push(`✓ ${passed} passed${neutral ? `, ${neutral} skipped or neutral` : ''}`)
  } else {
    lines.push(
      `CI passed on ${targetText(w)} (${sha}): ${snap.checks.length === 1 ? 'the check' : `all ${snap.checks.length} checks`} finished — ${passed} passed` +
        (neutral ? `, ${neutral} skipped or neutral.` : '.')
    )
  }
  if (w.shaChanges) lines.push(`(Followed ${w.shaChanges} push${w.shaChanges > 1 ? 'es' : ''} while watching.)`)
  if (w.label !== targetText(w)) lines.push(`Watch: ${w.label}`)
  return `${head} ${lines.join('\n')}`
}

interface Runtime {
  nextAt: number
  errors: number
  etags: Record<string, string>
  bodies: Record<string, unknown>
  /** When every watched check was first seen finished (settle window). */
  finishedSince?: number
  inFlight?: boolean
}

export function createCiWatchService(deps: CiWatchServiceDeps): CiWatchService {
  const github = deps.github ?? createGithubGet()
  const now = deps.now ?? Date.now
  const file = path.join(deps.dataDir, 'ci-watch', 'watches.json')
  const watches = new Map<string, CiWatch>()
  const runtime = new Map<string, Runtime>()
  let timer: ReturnType<typeof setInterval> | undefined

  if (fs.existsSync(file)) {
    try {
      for (const w of JSON.parse(fs.readFileSync(file, 'utf8')) as CiWatch[]) {
        watches.set(w.id, w)
        runtime.set(w.id, { nextAt: 0, errors: 0, etags: {}, bodies: {} })
      }
    } catch (err) {
      console.warn(TAG, `could not read ${file}, starting with no watches:`, (err as Error).message)
    }
  }
  const resumed = watches.size

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify([...watches.values()], null, 2))
    fs.renameSync(tmp, file)
  }

  /** Conditional GET: an unchanged answer (304) reuses the last body. */
  async function cachedGet(rt: Runtime, apiPath: string): Promise<any> {
    const res = await github(apiPath, rt.etags[apiPath])
    if (res.status === 304) return rt.bodies[apiPath]
    if (res.etag) rt.etags[apiPath] = res.etag
    rt.bodies[apiPath] = res.body
    return res.body
  }

  /** A list endpoint with `total_count`: page 1 conditionally, then any further pages. */
  async function listAll(rt: Runtime, apiPath: string, key: string): Promise<any[]> {
    const first = await cachedGet(rt, `${apiPath}?per_page=100`)
    const items: any[] = [...(first?.[key] ?? [])]
    const total: number = first?.total_count ?? items.length
    for (let page = 2; items.length < total && page <= 10; page++) {
      const batch = ((await github(`${apiPath}?per_page=100&page=${page}`)).body as any)?.[key] ?? []
      if (!batch.length) break
      items.push(...batch)
    }
    return items
  }

  async function resolveSha(w: CiWatch, rt: Runtime): Promise<string> {
    const t = w.target
    if (t.kind === 'sha') return t.sha
    if (w.sha && !w.follow) return w.sha
    if (t.kind === 'pr') return (await cachedGet(rt, `repos/${w.repo}/pulls/${t.number}`)).head.sha
    return (await cachedGet(rt, `repos/${w.repo}/commits/${encodeURIComponent(t.name)}`)).sha
  }

  async function snapshot(w: CiWatch, rt: Runtime): Promise<CiSnapshot> {
    const sha = await resolveSha(w, rt)
    const [runs, statuses] = await Promise.all([
      listAll(rt, `repos/${w.repo}/commits/${sha}/check-runs`, 'check_runs'),
      listAll(rt, `repos/${w.repo}/commits/${sha}/status`, 'statuses')
    ])
    const { checks, missing } = selectChecks(toCheckStates(runs, statuses), w.checks)
    return { sha, checks, missing }
  }

  /** Deliver the one message and end the watch. A failed delivery keeps the
   *  watch, so a later poll tries again. */
  async function finish(w: CiWatch, text: string) {
    if (!watches.has(w.id)) return // unwatched while this poll ran
    await deps.notify(w.threadKey, text)
    watches.delete(w.id)
    runtime.delete(w.id)
    save()
  }

  async function poll(w: CiWatch): Promise<void> {
    const rt = runtime.get(w.id)
    if (!rt || rt.inFlight) return
    rt.inFlight = true
    try {
      const t = now()
      const snap = await snapshot(w, rt)
      rt.errors = 0
      if (w.sha !== snap.sha) {
        if (w.sha) w.shaChanges++
        w.sha = snap.sha
        rt.finishedSince = undefined
        save()
      }
      const failed = snap.checks.some((c) => c.state === 'failure')
      const allDone =
        snap.checks.length > 0 && snap.missing.length === 0 && snap.checks.every((c) => c.state !== 'pending')

      // Red: report on the poll that first sees a failed check.
      if (failed) return await finish(w, formatNotification(w, snap, t, 'failed'))
      if (allDone) {
        // Green: confirmed by the next poll, because checks register gradually.
        if (rt.finishedSince === undefined) rt.finishedSince = t
        if (t - rt.finishedSince >= CI_POLL.settleMs) return await finish(w, formatNotification(w, snap, t, 'done'))
        return
      }
      rt.finishedSince = undefined
      if (snap.checks.length === 0 && t - w.createdAt >= CI_POLL.noChecksTimeoutMs) {
        return await finish(
          w,
          `[Cron: CI ${targetText(w)} @ ${new Date(t).toISOString()}] No CI checks appeared on ${targetText(w)} (${snap.sha.slice(0, 9)}) within ${CI_POLL.noChecksTimeoutMs / 60_000} minutes${w.checks?.length ? ` matching ${w.checks.join(', ')}` : ''}. Stopped watching.`
        )
      }
      if (t >= w.expiresAt) {
        const pending = snap.checks.filter((c) => c.state === 'pending').map((c) => c.name)
        const waiting = [
          ...(pending.length ? [`${pending.length} still running (${pending.slice(0, 10).join(', ')})`] : []),
          ...(snap.missing.length ? [`never appeared: ${snap.missing.join(', ')}`] : [])
        ]
        return await finish(
          w,
          `[Cron: CI ${targetText(w)} @ ${new Date(t).toISOString()}] Stopped watching ${targetText(w)}: timed out — ${waiting.join('; ')}.`
        )
      }
    } catch (err) {
      rt.errors++
      const message = (err as Error).message
      console.warn(TAG, `poll ${targetText(w)} failed (${rt.errors}):`, message)
      const t = now()
      // A deleted branch, renamed repo or revoked token fails every poll.
      if (rt.errors >= CI_POLL.maxErrors || t >= w.expiresAt) {
        try {
          return await finish(
            w,
            `[Cron: CI ${targetText(w)} @ ${new Date(t).toISOString()}] Stopped watching ${targetText(w)}: ${rt.errors} polls in a row failed (last error: ${message}).`
          )
        } catch (deliveryErr) {
          console.warn(TAG, `could not notify thread ${w.threadKey}:`, (deliveryErr as Error).message)
        }
      }
      rt.nextAt = t + Math.min(CI_POLL.maxBackoffMs, CI_POLL.pollMs * 2 ** rt.errors)
    } finally {
      rt.inFlight = false
    }
  }

  return {
    async watch(opts) {
      if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(opts.repo) || opts.repo.includes('..')) {
        throw new Error(`ci_watch: repo must be "owner/name" (got "${opts.repo}")`)
      }
      if (opts.target.kind === 'sha' && !/^[0-9a-f]{7,40}$/i.test(opts.target.sha)) {
        throw new Error(`ci_watch: sha must be 7–40 hex characters (got "${opts.target.sha}")`)
      }
      const createdAt = now()
      const w: CiWatch = {
        id: randomUUID(),
        threadKey: opts.threadKey,
        repo: opts.repo,
        target: opts.target,
        follow: opts.target.kind === 'sha' ? false : (opts.follow ?? true),
        ...(opts.checks?.length ? { checks: opts.checks } : {}),
        label: opts.label ?? targetText(opts as CiWatch),
        shaChanges: 0,
        createdAt,
        expiresAt: createdAt + (opts.timeoutMinutes ?? 720) * 60_000
      }
      const rt: Runtime = { nextAt: 0, errors: 0, etags: {}, bodies: {} }
      // Resolve the target now so a wrong repo, PR or branch fails the tool call.
      const snap = await snapshot(w, rt)
      w.sha = snap.sha
      watches.set(w.id, w)
      runtime.set(w.id, rt)
      save()
      return { watch: w, snapshot: snap }
    },

    list(threadKey) {
      return [...watches.values()].filter((w) => !threadKey || w.threadKey === threadKey)
    },

    unwatch(id) {
      const had = watches.delete(id)
      runtime.delete(id)
      if (had) save()
      return had
    },

    async pollDue() {
      const t = now()
      // Every watch each tick, in parallel; only a watch in error backoff waits.
      const due = [...watches.values()].filter((w) => (runtime.get(w.id)?.nextAt ?? 0) <= t)
      await Promise.all(due.map((w) => poll(w)))
    },

    start() {
      if (timer) return
      timer = setInterval(() => void this.pollDue(), CI_POLL.pollMs)
      timer.unref?.()
      if (resumed) console.log(TAG, `resumed ${resumed} watch${resumed === 1 ? '' : 'es'} after restart`)
    },

    dispose() {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  }
}
