// PR watch — follows one GitHub PR, branch or commit and tells a thread what
// happens to it. One 10 s loop in the server polls every watch through the
// GitHub REST API (conditional requests, so a quiet watch costs ~nothing), so
// it works for any repo the `gh` account can read, and a watch costs no model
// turn until it has something to say.
//
// Events a watch can follow:
// - ci:       one message when the checks go red or settle green. A watch with
//             only `ci` then ends (the old CI watch). In a watch that stays
//             alive for other events, a push (with `follow`) re-arms CI for the
//             new head: one more message per head commit.
// - comments: new issue comments and review comments on the PR.
// - reviews:  newly submitted reviews, with their state and body.
// - state:    merged, closed, reopened, converted to draft, ready for review.
// Comments, reviews and state changes are batched into one message once the PR
// has been quiet for 60 s (or 5 min after the first, whichever comes first).
// A watch with any of them lives until the PR merges or closes, it times out,
// or pr_unwatch ends it.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { EventBus } from '@sovereign/core'
import { toCheckStates, type CheckState } from '@sovereign/forges'

// The fold of check runs + statuses is shared with the forge adapter's checks().
export { toCheckStates, type CheckState }

const execFileAsync = promisify(execFile)
const TAG = '[pr-watch]'

export const PR_WATCH_EVENTS = ['ci', 'comments', 'reviews', 'state'] as const
export type PrWatchEvent = (typeof PR_WATCH_EVENTS)[number]

export type PrTarget = { kind: 'pr'; number: number } | { kind: 'branch'; name: string } | { kind: 'sha'; sha: string }

/** One comment, review or state change waiting in a batch. Untrusted authors
 *  carry no body: their text never enters the watch, on disk or in a message. */
export interface PrEntry {
  kind: 'comment' | 'review comment' | 'review' | 'state'
  author?: string
  /** ISO time on GitHub. */
  at: string
  untrusted?: boolean
  body?: string
  url?: string
  /** `path:line` of a review comment. */
  location?: string
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  reviewState?: string
  /** For kind `state`. */
  change?: 'merged' | 'closed' | 'reopened' | 'draft' | 'ready'
  /** An own-login review's new inline comments (replies left out). */
  inline?: Array<{ location?: string; body: string; url?: string }>
}

export interface PrWatch {
  id: string
  threadKey: string
  repo: string
  target: PrTarget
  /** What the thread hears about. */
  events: PrWatchEvent[]
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
  /** The CI part reported for the current head (watches that outlive CI). */
  ciDone?: boolean
  /** When CI was last re-armed on a new head (the no-checks clock); default createdAt. */
  ciSince?: number
  /** PR state last seen (comments/reviews/state watches). */
  pr?: { state: 'open' | 'closed' | 'merged'; draft: boolean }
  /** `since` cursors (ms, whole seconds) and the ids seen at or after them. */
  issueComments?: { since: number; seen: number[] }
  reviewComments?: { since: number; seen: number[] }
  /** The reviews page being read, and every review id already reported. */
  reviews?: { page: number; seen: number[] }
  /** Events collected and not sent yet. */
  batch?: { entries: PrEntry[]; firstAt: number; lastAt: number }
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

export interface PrWatchServiceDeps {
  dataDir: string
  /** Deliver a message into a thread through the normal chat queue. */
  notify(threadKey: string, text: string): Promise<void>
  /** The thread's trusted authors (its membrane's `forge.trustedAuthors`); undefined: everyone. */
  trustedAuthors?(threadKey: string): { has(login: string): boolean } | undefined
  github?: GithubGet
  now?: () => number
  /** Told `pr.watch.ci` when a long-lived watch reports CI, and `pr.watch.ended`
   *  once a watch's last message is delivered (the timeline's lines). */
  bus?: Pick<EventBus, 'emit'>
}

/** A CI result or the end of a watch, as `pr.watch.ci` / `pr.watch.ended` carry it. */
export interface PrWatchEnded {
  threadId: string
  repo: string
  /** `owner/name#7`, `owner/name:branch` or `owner/name:sha7`. */
  target: string
  result: 'passed' | 'failed' | 'no-checks' | 'timed-out' | 'error' | 'merged' | 'closed'
  sha?: string
  failed?: string[]
  message?: string
  url: string
  /** What the watch followed (the timeline tells a CI-only watch from a longer one). */
  events: PrWatchEvent[]
}

function targetUrl(w: Pick<PrWatch, 'repo' | 'target'>): string {
  const t = w.target
  const base = `https://github.com/${w.repo}`
  return t.kind === 'pr'
    ? `${base}/pull/${t.number}`
    : t.kind === 'branch'
      ? `${base}/tree/${t.name}`
      : `${base}/commit/${t.sha}`
}

export interface PrWatchOpts {
  threadKey: string
  repo: string
  target: PrTarget
  /** Default `['ci']`. */
  events?: PrWatchEvent[]
  follow?: boolean
  checks?: string[]
  label?: string
  timeoutMinutes?: number
}

export interface PrWatchService {
  watch(opts: PrWatchOpts): Promise<{ watch: PrWatch; snapshot?: CiSnapshot }>
  list(threadKey?: string): PrWatch[]
  unwatch(id: string): boolean
  /** Poll every watch not in error backoff (the 10 s timer calls this). */
  pollDue(): Promise<void>
  start(): void
  dispose(): void
}

/** Poll cadence and limits. */
export const PR_POLL = {
  /** One loop polls every watch this often (errors back off from it). */
  pollMs: 10_000,
  maxBackoffMs: 300_000,
  /** Stop after this many polls in a row fail. */
  maxErrors: 10,
  /** Green must hold on the next poll. CircleCI posts a job's dependants about
   *  a second after the job passes, so one all-finished poll can be partial. */
  settleMs: 10_000,
  /** Give up on CI when no check has appeared after this long. */
  noChecksTimeoutMs: 20 * 60_000,
  /** A batch goes out once nothing new arrived for this long… */
  quietMs: 60_000,
  /** …or this long after its first event. */
  batchCapMs: 5 * 60_000,
  /** Each comment or review body is cut to about this many characters. */
  bodyChars: 1500,
  /** Timeouts (minutes): CI only, and a watch that follows anything else. */
  ciTimeoutMinutes: { default: 720, max: 2880 },
  longTimeoutMinutes: { default: 7 * 24 * 60, max: 14 * 24 * 60 }
}

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

/** Restrict to the watched checks; report filters that match nothing yet. */
export function selectChecks(all: CheckState[], filters?: string[]): { checks: CheckState[]; missing: string[] } {
  if (!filters?.length) return { checks: all, missing: [] }
  const lower = filters.map((f) => f.toLowerCase())
  const checks = all.filter((c) => lower.some((f) => c.name.toLowerCase().includes(f)))
  const missing = filters.filter((_f, i) => !all.some((c) => c.name.toLowerCase().includes(lower[i])))
  return { checks, missing }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function targetText(w: Pick<PrWatch, 'repo' | 'target'>): string {
  const t = w.target
  // No '@': the cron envelope ends its label at the first '@'.
  return t.kind === 'pr'
    ? `${w.repo}#${t.number}`
    : t.kind === 'branch'
      ? `${w.repo}:${t.name}`
      : `${w.repo}:${t.sha.slice(0, 7)}`
}

/** Only `ci`: the watch ends with its CI message, as the old CI watch did. */
export const ciOnly = (w: Pick<PrWatch, 'events'>) => w.events.every((e) => e === 'ci')

/** The CI message a thread receives. Uses the cron envelope, so the chat shows it as a system card. */
export function formatNotification(w: PrWatch, snap: CiSnapshot, at: number, reason: 'failed' | 'done'): string {
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
  if (!ciOnly(w)) lines.push(`(Still watching ${w.events.filter((e) => e !== 'ci').join(', ')}.)`)
  if (w.label !== targetText(w)) lines.push(`Watch: ${w.label}`)
  return `${head} ${lines.join('\n')}`
}

/** Cut a body to about `PR_POLL.bodyChars`. */
export function trimBody(text: string, max = PR_POLL.bodyChars): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t
}

const indent = (text: string) =>
  text
    .split('\n')
    .map((l) => `   ${l}`)
    .join('\n')

const KIND_LABEL: Record<PrEntry['kind'], string> = {
  comment: 'Comment',
  'review comment': 'Review comment',
  review: 'Review',
  state: 'State'
}

const CHANGE_TEXT: Record<NonNullable<PrEntry['change']>, string> = {
  merged: 'PR merged',
  closed: 'PR closed without merging',
  reopened: 'PR reopened',
  draft: 'PR converted to draft',
  ready: 'PR marked ready for review'
}

function formatEntry(e: PrEntry, n: number): string {
  if (e.untrusted) return `${n}. ${e.kind} by ${e.author} (untrusted), not read`
  if (e.kind === 'state') {
    return `${n}. ${CHANGE_TEXT[e.change!]}${e.author ? ` by ${e.author}` : ''} at ${e.at}${e.url ? ` — ${e.url}` : ''}`
  }
  const lines = [
    `${n}. ${KIND_LABEL[e.kind]} by ${e.author} at ${e.at}` +
      (e.location ? ` on ${e.location}` : '') +
      (e.reviewState ? `: ${e.reviewState}` : '') +
      (e.url ? ` — ${e.url}` : '')
  ]
  if (e.body) lines.push(indent(e.body))
  for (const c of e.inline ?? []) {
    lines.push(`   • ${c.location ?? 'inline'}${c.url ? ` — ${c.url}` : ''}`)
    lines.push(indent(`  ${c.body}`.replace(/\n/g, '\n  ')))
  }
  return lines.join('\n')
}

/** The batched message for comments, reviews and state changes. */
export function formatBatch(
  w: PrWatch,
  pr: { title?: string; titleTrusted: boolean } | undefined,
  entries: PrEntry[],
  at: number,
  ending?: string
): string {
  const head = `[Cron: PR ${targetText(w)} @ ${new Date(at).toISOString()}]`
  const title = !pr ? '' : pr.titleTrusted ? ` "${pr.title ?? ''}"` : ' (title by an untrusted author, not read)'
  const lines = [`${targetText(w)}${title} — ${targetUrl(w)}`]
  if (entries.length) lines.push(`${plural(entries.length, 'new event')}:`)
  entries.forEach((e, i) => lines.push(formatEntry(e, i + 1)))
  if (ending) lines.push(ending)
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
  /** The PR's title and author, from the last read. */
  pr?: { title?: string; author?: string }
}

const newRuntime = (): Runtime => ({ nextAt: 0, errors: 0, etags: {}, bodies: {} })

/** GitHub's `since` takes whole seconds. */
const sinceParam = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const floorSecond = (ms: number) => Math.floor(ms / 1000) * 1000
const time = (iso: unknown) => (typeof iso === 'string' ? Date.parse(iso) : NaN)

/** A watch persisted by the old CI watch (no `events`) keeps CI-only behaviour. */
function migrate(w: PrWatch): PrWatch {
  return Array.isArray(w.events) && w.events.length ? w : { ...w, events: ['ci'] }
}

/** `30 minutes`, `5 hours`, `7 days`. */
function span(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 120) return plural(minutes, 'minute')
  if (minutes < 48 * 60) return plural(Math.round(minutes / 60), 'hour')
  return plural(Math.round(minutes / 1440), 'day')
}

export function createPrWatchService(deps: PrWatchServiceDeps): PrWatchService {
  const github = deps.github ?? createGithubGet()
  const now = deps.now ?? Date.now
  const file = path.join(deps.dataDir, 'pr-watch', 'watches.json')
  const legacyFile = path.join(deps.dataDir, 'ci-watch', 'watches.json')
  const watches = new Map<string, PrWatch>()
  const runtime = new Map<string, Runtime>()
  let timer: ReturnType<typeof setInterval> | undefined
  let ownLogin: Promise<string> | undefined

  function load(from: string): PrWatch[] {
    try {
      return (JSON.parse(fs.readFileSync(from, 'utf8')) as PrWatch[]).map(migrate)
    } catch (err) {
      console.warn(TAG, `could not read ${from}, starting with no watches from it:`, (err as Error).message)
      return []
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify([...watches.values()], null, 2))
    fs.renameSync(tmp, file)
  }

  const loaded = fs.existsSync(file) ? load(file) : []
  // The old CI watch's file: its live watches move over once, as CI-only watches.
  let migrated = 0
  if (fs.existsSync(legacyFile)) {
    if (!fs.existsSync(file)) {
      const old = load(legacyFile)
      loaded.push(...old)
      migrated = old.length
    }
    try {
      fs.renameSync(legacyFile, `${legacyFile}.migrated`)
    } catch (err) {
      console.warn(TAG, `could not set ${legacyFile} aside:`, (err as Error).message)
    }
  }
  for (const w of loaded) {
    watches.set(w.id, w)
    runtime.set(w.id, newRuntime())
  }
  if (migrated) {
    save()
    console.log(TAG, `migrated ${migrated} CI watch${migrated === 1 ? '' : 'es'} from ${legacyFile}`)
  }
  const resumed = watches.size

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

  /** A plain array endpoint: page 1 conditionally, then further pages while full. */
  async function listArray(rt: Runtime, apiPath: string): Promise<any[]> {
    const first = await cachedGet(rt, apiPath)
    const items: any[] = Array.isArray(first) ? [...first] : []
    for (let page = 2, last = items.length; last === 100 && page <= 10; page++) {
      const more = (await github(`${apiPath}&page=${page}`)).body
      const batch = Array.isArray(more) ? more : []
      items.push(...batch)
      last = batch.length
    }
    return items
  }

  /** The watcher's own GitHub login (`/user`), read once. */
  function self(): Promise<string> {
    if (!ownLogin) {
      const read = github('user').then((res) => {
        const login = (res.body as { login?: string } | undefined)?.login
        if (!login) throw new Error('GitHub /user returned no login')
        return login
      })
      ownLogin = read
      // A failed read is asked again on the next poll.
      read.catch(() => {
        if (ownLogin === read) ownLogin = undefined
      })
    }
    return ownLogin
  }
  const sameLogin = (a: string | undefined, b: string) => Boolean(a) && a!.toLowerCase() === b.toLowerCase()

  const needsPr = (w: PrWatch) => w.target.kind === 'pr' && (!ciOnly(w) || w.follow || !w.sha)
  const prPath = (w: PrWatch) => `repos/${w.repo}/pulls/${(w.target as { number: number }).number}`

  async function resolveSha(w: PrWatch, rt: Runtime, pr?: any): Promise<string> {
    const t = w.target
    if (t.kind === 'sha') return t.sha
    if (w.sha && !w.follow) return w.sha
    if (t.kind === 'pr') return (pr ?? (await cachedGet(rt, prPath(w)))).head.sha
    return (await cachedGet(rt, `repos/${w.repo}/commits/${encodeURIComponent(t.name)}`)).sha
  }

  async function snapshot(w: PrWatch, rt: Runtime, pr?: any): Promise<CiSnapshot> {
    const sha = await resolveSha(w, rt, pr)
    const [runs, statuses] = await Promise.all([
      listAll(rt, `repos/${w.repo}/commits/${sha}/check-runs`, 'check_runs'),
      listAll(rt, `repos/${w.repo}/commits/${sha}/status`, 'statuses')
    ])
    const { checks, missing } = selectChecks(toCheckStates(runs, statuses), w.checks)
    return { sha, checks, missing }
  }

  function emit(
    type: 'pr.watch.ci' | 'pr.watch.ended',
    w: PrWatch,
    outcome: Omit<PrWatchEnded, 'threadId' | 'repo' | 'target' | 'url' | 'events'>
  ) {
    const payload: PrWatchEnded = {
      threadId: w.threadKey,
      repo: w.repo,
      target: targetText(w),
      ...outcome,
      url: targetUrl(w),
      events: w.events
    }
    deps.bus?.emit({ type, timestamp: new Date(now()).toISOString(), source: 'pr-watch', payload })
  }

  /** Deliver the last message and end the watch. A failed delivery keeps the
   *  watch, so a later poll tries again. */
  async function finish(
    w: PrWatch,
    text: string,
    outcome: Pick<PrWatchEnded, 'result' | 'sha' | 'failed' | 'message'>
  ) {
    if (!watches.has(w.id)) return // unwatched while this poll ran
    await deps.notify(w.threadKey, text)
    watches.delete(w.id)
    runtime.delete(w.id)
    save()
    emit('pr.watch.ended', w, outcome)
  }

  /** A CI result: ends a CI-only watch; a longer watch only closes its CI part. */
  async function reportCi(
    w: PrWatch,
    text: string,
    outcome: Pick<PrWatchEnded, 'result' | 'sha' | 'failed' | 'message'>
  ) {
    if (ciOnly(w)) return finish(w, text, outcome)
    if (!watches.has(w.id)) return
    await deps.notify(w.threadKey, text)
    w.ciDone = true
    save()
    emit('pr.watch.ci', w, outcome)
  }

  const failedOf = (snap: CiSnapshot) => snap.checks.filter((c) => c.state === 'failure').map((c) => c.name)

  /** The CI part of a poll (unchanged from the old CI watch). */
  async function pollCi(w: PrWatch, rt: Runtime, t: number, pr?: any): Promise<void> {
    if (!ciOnly(w) && w.ciDone) {
      // Re-arm on a new head while the watch lives on for other events.
      if (!w.follow || w.target.kind === 'sha') return
      const sha = await resolveSha(w, rt, pr)
      if (sha === w.sha) return
      w.ciDone = false
      w.ciSince = t
    }
    const snap = await snapshot(w, rt, pr)
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
    if (failed)
      return reportCi(w, formatNotification(w, snap, t, 'failed'), {
        result: 'failed',
        sha: snap.sha,
        failed: failedOf(snap)
      })
    if (allDone) {
      // Green: confirmed by the next poll, because checks register gradually.
      if (rt.finishedSince === undefined) rt.finishedSince = t
      if (t - rt.finishedSince >= PR_POLL.settleMs) {
        rt.finishedSince = undefined
        return reportCi(w, formatNotification(w, snap, t, 'done'), {
          result: failedOf(snap).length ? 'failed' : 'passed',
          sha: snap.sha,
          failed: failedOf(snap)
        })
      }
      return
    }
    rt.finishedSince = undefined
    if (snap.checks.length === 0 && t - (w.ciSince ?? w.createdAt) >= PR_POLL.noChecksTimeoutMs) {
      const minutes = PR_POLL.noChecksTimeoutMs / 60_000
      return reportCi(
        w,
        `[Cron: CI ${targetText(w)} @ ${new Date(t).toISOString()}] No CI checks appeared on ${targetText(w)} (${snap.sha.slice(0, 9)}) within ${minutes} minutes${w.checks?.length ? ` matching ${w.checks.join(', ')}` : ''}. ${ciOnly(w) ? 'Stopped watching.' : `Stopped watching CI; still watching ${w.events.filter((e) => e !== 'ci').join(', ')}.`}`,
        { result: 'no-checks', sha: snap.sha, message: `no checks within ${minutes} min` }
      )
    }
    if (ciOnly(w) && t >= w.expiresAt) {
      const pending = snap.checks.filter((c) => c.state === 'pending').map((c) => c.name)
      const waiting = [
        ...(pending.length ? [`${pending.length} still running (${pending.slice(0, 10).join(', ')})`] : []),
        ...(snap.missing.length ? [`never appeared: ${snap.missing.join(', ')}`] : [])
      ]
      return finish(
        w,
        `[Cron: CI ${targetText(w)} @ ${new Date(t).toISOString()}] Stopped watching ${targetText(w)}: timed out — ${waiting.join('; ')}.`,
        { result: 'timed-out', sha: snap.sha, message: `timed out — ${waiting.join('; ')}` }
      )
    }
  }

  /** Who may have their text read in this thread's messages. */
  function trustCheck(w: PrWatch): (login: string | undefined) => boolean {
    const list = deps.trustedAuthors?.(w.threadKey)
    return (login) => !list || (Boolean(login) && list.has(login!))
  }

  function addEntries(w: PrWatch, entries: PrEntry[], t: number) {
    if (!entries.length) return
    if (!w.batch) w.batch = { entries: [], firstAt: t, lastAt: t }
    w.batch.entries.push(...entries)
    w.batch.lastAt = t
  }

  function prState(pr: any): NonNullable<PrWatch['pr']> {
    return {
      state: pr?.merged || pr?.merged_at ? 'merged' : pr?.state === 'closed' ? 'closed' : 'open',
      draft: Boolean(pr?.draft)
    }
  }

  /** State changes since the last read; returns how the PR ended, if it did. */
  function readState(w: PrWatch, pr: any, t: number): 'merged' | 'closed' | undefined {
    const cur = prState(pr)
    const prev = w.pr ?? cur
    w.pr = cur
    const at = (iso: unknown) => (typeof iso === 'string' ? iso : new Date(t).toISOString())
    const url = typeof pr?.html_url === 'string' ? pr.html_url : targetUrl(w)
    const entries: PrEntry[] = []
    let ended: 'merged' | 'closed' | undefined
    if (cur.state !== prev.state) {
      if (cur.state === 'merged') {
        ended = 'merged'
        entries.push({ kind: 'state', change: 'merged', author: pr?.merged_by?.login, at: at(pr?.merged_at), url })
      } else if (cur.state === 'closed') {
        ended = 'closed'
        entries.push({ kind: 'state', change: 'closed', at: at(pr?.closed_at), url })
      } else if (w.events.includes('state')) {
        entries.push({ kind: 'state', change: 'reopened', at: at(pr?.updated_at), url })
      }
    } else if (cur.draft !== prev.draft && cur.state === 'open' && w.events.includes('state')) {
      entries.push({ kind: 'state', change: cur.draft ? 'draft' : 'ready', at: at(pr?.updated_at), url })
    }
    addEntries(w, entries, t)
    return ended
  }

  /** New comments on one endpoint (`since` cursor + ids seen at it), as entries. */
  async function readComments(
    w: PrWatch,
    rt: Runtime,
    which: 'issueComments' | 'reviewComments',
    me: string,
    trusted: (login: string | undefined) => boolean
  ): Promise<PrEntry[]> {
    const n = (w.target as { number: number }).number
    const cursor = (w[which] ??= { since: floorSecond(w.createdAt), seen: [] })
    const endpoint =
      which === 'issueComments' ? `repos/${w.repo}/issues/${n}/comments` : `repos/${w.repo}/pulls/${n}/comments`
    // The URL changes only when the cursor moves, so a quiet PR answers 304.
    const items = await listArray(rt, `${endpoint}?since=${sinceParam(cursor.since)}&per_page=100`)
    const seen = new Set(cursor.seen)
    const entries: PrEntry[] = []
    let next = cursor.since
    for (const c of items) {
      const updated = time(c?.updated_at)
      if (Number.isFinite(updated)) next = Math.max(next, floorSecond(updated))
      if (typeof c?.id !== 'number' || seen.has(c.id)) continue
      seen.add(c.id)
      // An old comment edited after the cursor is not new.
      if (!(time(c.created_at) >= cursor.since)) continue
      const login: string | undefined = c.user?.login
      // The agents' own replies: waking on them would loop.
      if (sameLogin(login, me)) continue
      const kind = which === 'issueComments' ? 'comment' : 'review comment'
      if (!trusted(login)) {
        entries.push({ kind, author: login ?? 'unknown', at: c.created_at, untrusted: true })
        continue
      }
      const line = c.line ?? c.original_line
      entries.push({
        kind,
        author: login,
        at: c.created_at,
        body: trimBody(String(c.body ?? '')),
        url: c.html_url,
        ...(which === 'reviewComments' && c.path ? { location: line ? `${c.path}:${line}` : String(c.path) } : {})
      })
    }
    // Keep only the ids GitHub returns again (updated at or after the new cursor).
    const keep = items
      .filter((c) => typeof c?.id === 'number' && floorSecond(time(c.updated_at)) >= next)
      .map((c) => c.id as number)
    w[which] = { since: next, seen: keep }
    return entries
  }

  /** Newly submitted reviews. Own-login reviews are delivered (the user reviews
   *  from that account), with their new inline comments, unless all they hold
   *  is a reply (GitHub wraps every reply comment in a COMMENTED review). */
  async function readReviews(
    w: PrWatch,
    rt: Runtime,
    me: string | undefined,
    trusted: (login: string | undefined) => boolean,
    baseline = false
  ): Promise<PrEntry[]> {
    const n = (w.target as { number: number }).number
    const state = (w.reviews ??= { page: 1, seen: [] })
    const seen = new Set(state.seen)
    const entries: PrEntry[] = []
    for (let i = 0; i < 10; i++) {
      const page = await cachedGet(rt, `repos/${w.repo}/pulls/${n}/reviews?per_page=100&page=${state.page}`)
      const items: any[] = Array.isArray(page) ? page : []
      for (const r of items) {
        if (typeof r?.id !== 'number' || seen.has(r.id) || r.state === 'PENDING') continue
        seen.add(r.id)
        if (baseline) continue
        const login: string | undefined = r.user?.login
        if (!trusted(login)) {
          entries.push({ kind: 'review', author: login ?? 'unknown', at: r.submitted_at, untrusted: true })
          continue
        }
        const entry: PrEntry = {
          kind: 'review',
          author: login,
          at: r.submitted_at,
          reviewState: r.state,
          url: r.html_url,
          ...(String(r.body ?? '').trim() ? { body: trimBody(String(r.body)) } : {})
        }
        if (me && sameLogin(login, me)) {
          const res = await github(`repos/${w.repo}/pulls/${n}/reviews/${r.id}/comments?per_page=100`)
          const own = (Array.isArray(res.body) ? res.body : []).filter((c: any) => !c?.in_reply_to_id)
          if (own.length)
            entry.inline = own.map((c: any) => ({
              ...(c.path
                ? { location: (c.line ?? c.original_line) ? `${c.path}:${c.line ?? c.original_line}` : c.path }
                : {}),
              body: trimBody(String(c.body ?? '')),
              url: c.html_url
            }))
          if (r.state === 'COMMENTED' && !entry.body && !own.length) continue
        }
        entries.push(entry)
      }
      if (items.length < 100) break
      state.page++
    }
    state.seen = [...seen]
    return entries
  }

  /** Send the waiting batch; a failed delivery keeps it for the next poll. */
  async function flush(w: PrWatch, rt: Runtime, t: number) {
    if (!w.batch?.entries.length || !watches.has(w.id)) return
    await deps.notify(w.threadKey, formatBatch(w, prHeader(w, rt), w.batch.entries, t))
    w.batch = undefined
    save()
  }

  function prHeader(w: PrWatch, rt: Runtime) {
    if (w.target.kind !== 'pr' || !rt.pr) return undefined
    return { title: rt.pr.title, titleTrusted: trustCheck(w)(rt.pr.author) }
  }

  async function poll(w: PrWatch): Promise<void> {
    const rt = runtime.get(w.id)
    if (!rt || rt.inFlight) return
    rt.inFlight = true
    // Cursors, seen ids and the batch persist whenever a poll changed them.
    const before = JSON.stringify(w)
    try {
      const t = now()
      const pr = needsPr(w) ? await cachedGet(rt, prPath(w)) : undefined
      if (pr) rt.pr = { title: pr.title, author: pr.user?.login }
      if (!ciOnly(w)) {
        // A merge or close whose message failed to go out is still the end.
        const ended =
          (pr ? readState(w, pr, t) : undefined) ??
          (w.pr && w.pr.state !== 'open' ? (w.pr.state as 'merged' | 'closed') : undefined)
        const trusted = trustCheck(w)
        const wantsComments = w.events.includes('comments')
        const me = wantsComments || w.events.includes('reviews') ? await self() : undefined
        if (wantsComments) {
          addEntries(w, await readComments(w, rt, 'issueComments', me!, trusted), t)
          addEntries(w, await readComments(w, rt, 'reviewComments', me!, trusted), t)
        }
        if (w.events.includes('reviews')) addEntries(w, await readReviews(w, rt, me, trusted), t)
        rt.errors = 0
        if (ended) {
          const entries = w.batch?.entries ?? []
          return await finish(w, formatBatch(w, prHeader(w, rt), entries, t, `The PR is ${ended}: stopped watching.`), {
            result: ended,
            ...(w.sha ? { sha: w.sha } : {})
          })
        }
        if (w.batch && (t - w.batch.lastAt >= PR_POLL.quietMs || t - w.batch.firstAt >= PR_POLL.batchCapMs)) {
          await flush(w, rt, t)
        }
        if (t >= w.expiresAt) {
          const after = span(w.expiresAt - w.createdAt)
          return await finish(
            w,
            formatBatch(
              w,
              prHeader(w, rt),
              w.batch?.entries ?? [],
              t,
              `Stopped watching ${targetText(w)}: timed out after ${after}.`
            ),
            { result: 'timed-out', ...(w.sha ? { sha: w.sha } : {}), message: `timed out after ${after}` }
          )
        }
      }
      if (w.events.includes('ci') && watches.has(w.id)) await pollCi(w, rt, t, pr)
      rt.errors = 0
    } catch (err) {
      rt.errors++
      const message = (err as Error).message
      console.warn(TAG, `poll ${targetText(w)} failed (${rt.errors}):`, message)
      const t = now()
      // A deleted branch, renamed repo or revoked token fails every poll.
      if (rt.errors >= PR_POLL.maxErrors || t >= w.expiresAt) {
        try {
          return await finish(
            w,
            `[Cron: ${ciOnly(w) ? 'CI' : 'PR'} ${targetText(w)} @ ${new Date(t).toISOString()}] Stopped watching ${targetText(w)}: ${rt.errors} polls in a row failed (last error: ${message}).`,
            { result: 'error', message: `${rt.errors} polls failed: ${message}` }
          )
        } catch (deliveryErr) {
          console.warn(TAG, `could not notify thread ${w.threadKey}:`, (deliveryErr as Error).message)
        }
      }
      rt.nextAt = t + Math.min(PR_POLL.maxBackoffMs, PR_POLL.pollMs * 2 ** rt.errors)
    } finally {
      rt.inFlight = false
      if (watches.has(w.id) && JSON.stringify(w) !== before) save()
    }
  }

  return {
    async watch(opts) {
      if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(opts.repo) || opts.repo.includes('..')) {
        throw new Error(`pr_watch: repo must be "owner/name" (got "${opts.repo}")`)
      }
      if (opts.target.kind === 'sha' && !/^[0-9a-f]{7,40}$/i.test(opts.target.sha)) {
        throw new Error(`pr_watch: sha must be 7–40 hex characters (got "${opts.target.sha}")`)
      }
      const events = [...new Set(opts.events?.length ? opts.events : (['ci'] as PrWatchEvent[]))]
      const unknown = events.filter((e) => !(PR_WATCH_EVENTS as readonly string[]).includes(e))
      if (unknown.length) {
        throw new Error(`pr_watch: unknown event ${unknown.join(', ')} (use ${PR_WATCH_EVENTS.join(', ')})`)
      }
      const long = events.some((e) => e !== 'ci')
      if (long && opts.target.kind !== 'pr') {
        throw new Error(
          `pr_watch: events ${events.filter((e) => e !== 'ci').join(', ')} need a pr target (a ${opts.target.kind} has no comments, reviews or state)`
        )
      }
      const limits = long ? PR_POLL.longTimeoutMinutes : PR_POLL.ciTimeoutMinutes
      const minutes = opts.timeoutMinutes ?? limits.default
      if (!(minutes > 0) || minutes > limits.max) {
        throw new Error(
          `pr_watch: timeoutMinutes must be at most ${limits.max} ${long ? 'when watching more than ci' : 'for a ci-only watch'} (got ${minutes})`
        )
      }
      const createdAt = now()
      const w: PrWatch = {
        id: randomUUID(),
        threadKey: opts.threadKey,
        repo: opts.repo,
        target: opts.target,
        events,
        follow: opts.target.kind === 'sha' ? false : (opts.follow ?? true),
        ...(opts.checks?.length ? { checks: opts.checks } : {}),
        label: opts.label ?? targetText(opts as PrWatch),
        shaChanges: 0,
        createdAt,
        expiresAt: createdAt + minutes * 60_000
      }
      const rt = newRuntime()
      // Resolve the target now so a wrong repo, PR or branch fails the tool call.
      let snap: CiSnapshot | undefined
      if (long) {
        const pr = await cachedGet(rt, prPath(w))
        if (!pr?.head?.sha) throw new Error(`pr_watch: GitHub returned no PR for ${targetText(w)}`)
        w.pr = prState(pr)
        if (w.pr.state !== 'open') throw new Error(`pr_watch: ${targetText(w)} is already ${w.pr.state}`)
        rt.pr = { title: pr.title, author: pr.user?.login }
        const me = events.includes('comments') || events.includes('reviews') ? await self() : undefined
        // Reviews already there are history, not news.
        if (events.includes('reviews')) await readReviews(w, rt, me, () => true, true)
        if (events.includes('ci')) snap = await snapshot(w, rt, pr)
        else w.sha = pr.head.sha
      } else {
        snap = await snapshot(w, rt)
      }
      if (snap) w.sha = snap.sha
      watches.set(w.id, w)
      runtime.set(w.id, rt)
      save()
      return { watch: w, ...(snap ? { snapshot: snap } : {}) }
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
      timer = setInterval(() => void this.pollDue(), PR_POLL.pollMs)
      timer.unref?.()
      if (resumed) console.log(TAG, `resumed ${resumed} watch${resumed === 1 ? '' : 'es'} after restart`)
    },

    dispose() {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  }
}
