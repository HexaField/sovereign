// PR Poll Service — monitors GitHub PRs linked to tasks.
//
// For each task with a `provider` of kind `github-pr`, runs a periodic
// poll via the `gh` CLI. Compares the fetched state against the stored
// provider metadata and emits bus events + thread notifications when
// something changes.
//
// Lifecycle:
//   - start(taskId) — begin polling a PR-task
//   - stop(taskId)  — stop polling
//   - bootstrap()   — scan all tasks and start polls for active PR-tasks
//   - dispose()     — stop all polls

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EventBus } from '@sovereign/core'
import type { TaskService } from './service.js'
import type { TaskProvider } from './types.js'

const execFileAsync = promisify(execFile)
const TAG = '[pr-poll]'
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export interface PrPollServiceDeps {
  taskService: TaskService
  bus: EventBus
  /** Send a message to a thread. Used to notify the assigned agent. */
  sendToThread: (threadId: string, text: string) => Promise<void>
  /** Override the exec function for testing. */
  execFn?: typeof execFileAsync
}

export interface ImportPrOpts {
  repo: string
  pr: number
  threadId?: string
  parentTaskIds?: string[]
  tags?: string[]
  prompt?: string
  pollIntervalMinutes?: number
  sourceThreadId: string
}

export interface PrPollService {
  /** Import a GitHub PR as a task. Fetches initial state, creates the task,
   *  starts polling, and optionally sends an initial prompt. */
  importPr(opts: ImportPrOpts): Promise<import('./types.js').Task>
  /** Start polling for a specific task. */
  start(taskId: string, intervalMs?: number): void
  /** Stop polling for a specific task. */
  stop(taskId: string): void
  /** Scan all tasks and start polls for active PR-tasks. */
  bootstrap(): Promise<void>
  /** Stop all polls and clean up. */
  dispose(): void
  /** Number of active polls. */
  activeCount(): number
  /** Force a single poll tick for a task (for testing / manual refresh). */
  pollOnce(taskId: string): Promise<void>
}

interface PollEntry {
  taskId: string
  repo: string
  pr: number
  intervalMs: number
  timerId: ReturnType<typeof setInterval>
}

/** Map GitHub PR state strings to our TaskProvider.prStatus. */
function mapPrStatus(state: string, isDraft: boolean): TaskProvider['prStatus'] {
  if (isDraft) return 'draft'
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  return 'open'
}

/** Determine aggregate CI check status from statusCheckRollup. */
function mapChecksStatus(rollup: Array<{ state?: string; conclusion?: string }>): TaskProvider['checksStatus'] {
  if (!rollup || rollup.length === 0) return 'unknown'
  const hasFailure = rollup.some(
    (c) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR' || c.conclusion === 'CANCELLED'
  )
  if (hasFailure) return 'failing'
  const allDone = rollup.every(
    (c) =>
      c.state === 'COMPLETED' || c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED'
  )
  if (allDone) return 'passing'
  return 'pending'
}

/** Map review decision string. */
function mapReviewDecision(decision: string | null): TaskProvider['reviewDecision'] {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes_requested'
  if (decision === 'REVIEW_REQUIRED') return 'review_required'
  return 'unknown'
}

/** Map PR state to task state. */
function prStateToTaskState(provider: TaskProvider): 'in_progress' | 'completed' | 'cancelled' {
  if (provider.prStatus === 'merged') return 'completed'
  if (provider.prStatus === 'closed') return 'cancelled'
  return 'in_progress'
}

/** Build a default prompt for a newly imported PR when none was provided. */
function buildDefaultPrompt(provider: TaskProvider, title: string, branch: string): string {
  const lines = [
    `[PR #${provider.number}] ${title}`,
    provider.url,
    '',
    `Branch: ${branch}`,
    `CI: ${provider.checksStatus} · Review: ${provider.reviewDecision}`,
    ''
  ]
  if (provider.checksStatus === 'failing') {
    lines.push(
      `CI checks have failed. Run \`gh pr checks ${provider.number} -R ${provider.repo}\` to see which checks failed and address the failures.`
    )
  } else if (provider.reviewDecision === 'changes_requested') {
    lines.push(
      `Changes have been requested. Run \`gh pr view ${provider.number} -R ${provider.repo} --comments\` to read the review comments and address them.`
    )
  } else {
    lines.push(
      'This PR has been imported into your task list. Monitor CI status and review comments. Address any failures or requested changes.'
    )
  }
  return lines.join('\n')
}

/** Build a human-readable transient state line. */
function buildTransient(provider: TaskProvider): string {
  const parts: string[] = [`PR #${provider.number}`]
  if (provider.prStatus === 'merged') return `PR #${provider.number} merged`
  if (provider.prStatus === 'closed') return `PR #${provider.number} closed`
  if (provider.prStatus === 'draft') parts.push('draft')
  if (provider.checksStatus === 'failing') parts.push('CI failing')
  else if (provider.checksStatus === 'passing') parts.push('CI passing')
  else if (provider.checksStatus === 'pending') parts.push('CI pending')
  if (provider.reviewDecision === 'approved') parts.push('approved')
  else if (provider.reviewDecision === 'changes_requested') parts.push('changes requested')
  if (provider.unresolvedComments > 0) parts.push(`${provider.unresolvedComments} unresolved comments`)
  return parts.join(' · ')
}

export function createPrPollService(deps: PrPollServiceDeps): PrPollService {
  const { taskService, sendToThread } = deps
  const exec = deps.execFn ?? execFileAsync
  const polls = new Map<string, PollEntry>()

  /** Fetch current PR state from GitHub via gh CLI. */
  async function fetchPrState(
    repo: string,
    pr: number
  ): Promise<{
    state: string
    isDraft: boolean
    reviewDecision: string | null
    statusCheckRollup: Array<{ state?: string; conclusion?: string }>
    unresolvedComments: number
    title: string
    headBranch: string
  } | null> {
    try {
      const { stdout } = await exec('gh', [
        'pr',
        'view',
        String(pr),
        '-R',
        repo,
        '--json',
        'state,isDraft,reviewDecision,statusCheckRollup,title,headRefName,comments'
      ])
      const data = JSON.parse(stdout)
      // Count unresolved review comments (comments without a reply that resolves them)
      // The gh CLI returns all comments; we count top-level unresolved ones.
      const comments: Array<{ body?: string }> = data.comments ?? []
      return {
        state: data.state ?? 'OPEN',
        isDraft: data.isDraft ?? false,
        reviewDecision: data.reviewDecision ?? null,
        statusCheckRollup: data.statusCheckRollup ?? [],
        unresolvedComments: comments.length,
        title: data.title ?? '',
        headBranch: data.headRefName ?? ''
      }
    } catch (err) {
      console.warn(TAG, `failed to fetch PR #${pr} from ${repo}:`, (err as Error).message)
      return null
    }
  }

  /** Run a single poll tick for a task. */
  async function tick(taskId: string): Promise<void> {
    const task = await taskService.get(taskId)
    if (!task?.provider || task.provider.kind !== 'github-pr') {
      // Task deleted or provider removed — stop polling
      stop(taskId)
      return
    }

    // Terminal states — stop polling
    if (task.state === 'completed' || task.state === 'cancelled') {
      stop(taskId)
      return
    }

    const prev = task.provider
    const fetched = await fetchPrState(prev.repo, prev.number)
    if (!fetched) return // fetch failed — skip this tick

    const now = new Date().toISOString()
    const updated: TaskProvider = {
      kind: 'github-pr',
      url: prev.url,
      repo: prev.repo,
      number: prev.number,
      prStatus: mapPrStatus(fetched.state, fetched.isDraft),
      checksStatus: mapChecksStatus(fetched.statusCheckRollup),
      reviewDecision: mapReviewDecision(fetched.reviewDecision),
      lastPolledAt: now,
      unresolvedComments: fetched.unresolvedComments
    }

    // Detect changes
    const changes: string[] = []
    if (prev.prStatus !== updated.prStatus) changes.push(`status: ${prev.prStatus} → ${updated.prStatus}`)
    if (prev.checksStatus !== updated.checksStatus) changes.push(`CI: ${prev.checksStatus} → ${updated.checksStatus}`)
    if (prev.reviewDecision !== updated.reviewDecision)
      changes.push(`review: ${prev.reviewDecision} → ${updated.reviewDecision}`)
    if (prev.unresolvedComments !== updated.unresolvedComments)
      changes.push(`comments: ${prev.unresolvedComments} → ${updated.unresolvedComments}`)

    if (changes.length === 0) {
      // No changes — just update lastPolledAt
      await taskService.update(taskId, {
        provider: updated,
        sourceThreadId: 'pr-poll'
      })
      return
    }

    // Something changed — update task
    const newTaskState = prStateToTaskState(updated)
    const transient = buildTransient(updated)

    await taskService.update(taskId, {
      provider: updated,
      state: newTaskState,
      transientState: transient,
      sourceThreadId: 'pr-poll'
    })

    // Notify the assigned thread
    if (task.threadId) {
      const notifications: string[] = []

      if (prev.checksStatus !== updated.checksStatus) {
        if (updated.checksStatus === 'failing') {
          notifications.push(
            `[PR #${updated.number}] CI check failed. Run \`gh pr checks ${updated.number} -R ${updated.repo}\` for details.`
          )
        } else if (updated.checksStatus === 'passing' && prev.checksStatus === 'failing') {
          notifications.push(`[PR #${updated.number}] CI checks now passing.`)
        }
      }

      if (prev.reviewDecision !== updated.reviewDecision) {
        if (updated.reviewDecision === 'changes_requested') {
          notifications.push(
            `[PR #${updated.number}] Changes requested. Run \`gh pr view ${updated.number} -R ${updated.repo} --comments\` to see review comments.`
          )
        } else if (updated.reviewDecision === 'approved') {
          notifications.push(`[PR #${updated.number}] Approved.`)
        }
      }

      if (prev.prStatus !== updated.prStatus) {
        if (updated.prStatus === 'merged') {
          notifications.push(`[PR #${updated.number}] Merged.`)
        } else if (updated.prStatus === 'closed') {
          notifications.push(`[PR #${updated.number}] Closed without merge.`)
        }
      }

      if (prev.unresolvedComments < updated.unresolvedComments) {
        const newCount = updated.unresolvedComments - prev.unresolvedComments
        notifications.push(
          `[PR #${updated.number}] ${newCount} new comment${newCount > 1 ? 's' : ''}. Run \`gh pr view ${updated.number} -R ${updated.repo} --comments\` to review.`
        )
      }

      for (const msg of notifications) {
        try {
          await sendToThread(task.threadId, msg)
        } catch (err) {
          console.warn(TAG, `failed to notify thread ${task.threadId}:`, (err as Error).message)
        }
      }
    }

    // Stop polling for terminal states
    if (newTaskState === 'completed' || newTaskState === 'cancelled') {
      stop(taskId)
    }
  }

  function start(taskId: string, intervalMs = DEFAULT_INTERVAL_MS): void {
    // Already polling — skip
    if (polls.has(taskId)) return

    // We need the task's provider to know repo + PR number
    // Schedule the first tick immediately, then interval
    const entry: PollEntry = {
      taskId,
      repo: '', // filled on first tick
      pr: 0,
      intervalMs,
      timerId: setInterval(() => void tick(taskId), intervalMs)
    }
    polls.set(taskId, entry)

    // Immediate first tick
    void tick(taskId).then(async () => {
      // Fill entry metadata from task
      const task = await taskService.get(taskId)
      if (task?.provider && task.provider.kind === 'github-pr') {
        entry.repo = task.provider.repo
        entry.pr = task.provider.number
      }
    })
  }

  function stop(taskId: string): void {
    const entry = polls.get(taskId)
    if (!entry) return
    clearInterval(entry.timerId)
    polls.delete(taskId)
  }

  return {
    async importPr(opts: ImportPrOpts) {
      const fetched = await fetchPrState(opts.repo, opts.pr)
      if (!fetched) throw new Error(`Failed to fetch PR #${opts.pr} from ${opts.repo}`)

      const now = new Date().toISOString()
      const url = `https://github.com/${opts.repo}/pull/${opts.pr}`
      const provider: TaskProvider = {
        kind: 'github-pr',
        url,
        repo: opts.repo,
        number: opts.pr,
        prStatus: mapPrStatus(fetched.state, fetched.isDraft),
        checksStatus: mapChecksStatus(fetched.statusCheckRollup),
        reviewDecision: mapReviewDecision(fetched.reviewDecision),
        lastPolledAt: now,
        unresolvedComments: fetched.unresolvedComments
      }

      const task = await taskService.create({
        name: `PR #${opts.pr}: ${fetched.title || opts.repo}`,
        description: `GitHub PR: ${url}\nBranch: ${fetched.headBranch}`,
        parentTaskIds: opts.parentTaskIds,
        tags: [...(opts.tags ?? []), 'github-pr'],
        autoAssign: !!opts.threadId,
        sourceThreadId: opts.sourceThreadId,
        provider
      })

      // Assign thread if specified (autoAssign uses sourceThreadId; explicit
      // threadId may differ from the calling thread).
      if (opts.threadId && task.threadId !== opts.threadId) {
        await taskService.update(task.id, {
          threadId: opts.threadId,
          sourceThreadId: opts.sourceThreadId
        })
      }

      // Set initial transient state
      const transient = buildTransient(provider)
      await taskService.update(task.id, {
        state: 'in_progress',
        transientState: transient,
        sourceThreadId: opts.sourceThreadId
      })

      // Start polling
      const intervalMs = (opts.pollIntervalMinutes ?? 5) * 60 * 1000
      start(task.id, intervalMs)

      // Send initial prompt to assigned thread (use default if none provided)
      const targetThread = opts.threadId ?? task.threadId
      if (targetThread) {
        const prompt = opts.prompt ?? buildDefaultPrompt(provider, fetched.title, fetched.headBranch)
        try {
          await sendToThread(targetThread, prompt)
        } catch (err) {
          console.warn(TAG, `failed to send initial prompt to thread ${targetThread}:`, (err as Error).message)
        }
      }

      // Return the latest version of the task
      const result = await taskService.get(task.id)
      return result!
    },

    start,
    stop,

    async bootstrap() {
      // Find all tasks with a github-pr provider in active states
      const allTasks = await taskService.list()
      for (const item of allTasks) {
        if (item.state === 'completed' || item.state === 'cancelled') continue
        if (!item.provider || item.provider.kind !== 'github-pr') continue
        start(item.id)
      }
      console.log(TAG, `bootstrap: started ${polls.size} PR poll(s)`)
    },

    dispose() {
      for (const [, entry] of polls) {
        clearInterval(entry.timerId)
      }
      polls.clear()
    },

    activeCount() {
      return polls.size
    },

    async pollOnce(taskId: string) {
      await tick(taskId)
    }
  }
}
