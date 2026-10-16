// task_import — turn a refKey string, a forge URL or a plan into a task,
// idempotently (TaskService.ensureTask keyed by the provider key).
//
// Accepted targets:
//   ref   "github:github.com/owner/name#123" (refKey), or "owner/name#123"
//   url   https://github.com/owner/name/pull/123 | …/issues/123 (extra path ok)
//   plan  { project, path }
//
// A refKey does not say whether #123 is a PR or an issue; the importer asks
// GitHub (`gh api repos/<repo>/issues/<n>` has `pull_request` for PRs).

import type { ForgeRef } from '@sovereign/core'
import { parseRefKey, refKey } from '@sovereign/core'
import type { PrPollService } from './pr-poll.js'
import type { TaskService } from './service.js'
import type { IssueProvider, Task } from './types.js'
import { planKey } from './types.js'

export type ImportTarget =
  /** A forge item; `kind` undefined = not yet known (a bare refKey). */
  { type: 'forge'; ref: ForgeRef; kind?: 'change' | 'issue' } | { type: 'plan'; project: string; path: string }

export interface ImportInput {
  ref?: string
  url?: string
  plan?: { project: string; path: string; name?: string }
}

/** Parse the target of a task_import call. Throws a message fit for the caller. */
export function parseImportTarget(input: ImportInput): ImportTarget {
  const given = [input.ref, input.url, input.plan].filter((v) => v !== undefined && v !== '')
  if (given.length !== 1) throw new Error('task_import needs exactly one of ref, url or plan')

  if (input.plan) {
    const project = input.plan.project?.trim()
    const p = input.plan.path?.trim().replace(/^\/+/, '')
    if (!project || !p) throw new Error('plan needs project and path')
    if (project.includes('/')) throw new Error('plan.project is a project id, without "/"')
    return { type: 'plan', project, path: p }
  }

  if (input.url) return parseForgeUrl(input.url)

  const ref = input.ref!.trim()
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref)
  if (short) {
    return { type: 'forge', ref: { forge: 'github', host: 'github.com', repo: short[1], kind: 'change', id: short[2] } }
  }
  const parsed = parseRefKey(ref, 'change')
  if (!parsed || ref.includes('@')) {
    throw new Error(`Not a change/issue refKey: "${ref}" (want "github:github.com/owner/name#123" or "owner/name#123")`)
  }
  if (parsed.forge !== 'github') throw new Error(`Only GitHub items can be imported for now (got ${parsed.forge})`)
  if (!/^[\w.-]+\/[\w.-]+$/.test(parsed.repo)) throw new Error(`Repo must be "owner/name": ${parsed.repo}`)
  if (!/^\d+$/.test(parsed.id)) throw new Error(`GitHub item numbers are numeric: ${parsed.id}`)
  return { type: 'forge', ref: parsed }
}

export function parseForgeUrl(raw: string): ImportTarget {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error(`Not a URL: "${raw}"`)
  }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') {
    throw new Error(`Only github.com URLs can be imported for now (got ${u.hostname})`)
  }
  const m = /^\/([\w.-]+)\/([\w.-]+)\/(pull|pulls|issues)\/(\d+)(?:\/.*)?$/.exec(u.pathname)
  if (!m) throw new Error(`Not a GitHub pull request or issue URL: "${raw}"`)
  const kind = m[3] === 'issues' ? 'issue' : 'change'
  return {
    type: 'forge',
    kind,
    ref: { forge: 'github', host: 'github.com', repo: `${m[1]}/${m[2]}`, kind, id: m[4] }
  }
}

// ── Importer ──────────────────────────────────────────────────────────

type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>

export interface TaskImporterDeps {
  taskService: TaskService
  prPoll: PrPollService
  sendToThread: (threadId: string, text: string) => Promise<void>
  exec: Exec
}

export interface ImportOpts extends ImportInput {
  threadId?: string
  parentTaskIds?: string[]
  tags?: string[]
  prompt?: string
  membrane?: string | null
  sourceThreadId: string
}

export interface ImportResult {
  task: Task
  created: boolean
}

export interface TaskImporter {
  import(opts: ImportOpts): Promise<ImportResult>
}

export function createTaskImporter(deps: TaskImporterDeps): TaskImporter {
  const { taskService, prPoll, sendToThread, exec } = deps

  /** PR or issue? Asks GitHub. */
  async function resolveKind(ref: ForgeRef): Promise<'change' | 'issue'> {
    const { stdout } = await exec('gh', ['api', `repos/${ref.repo}/issues/${ref.id}`, '--jq', '.pull_request != null'])
    return stdout.trim() === 'true' ? 'change' : 'issue'
  }

  async function assignAndPrompt(task: Task, opts: ImportOpts, defaultPrompt: string): Promise<Task> {
    let current = task
    if (opts.threadId && current.threadId !== opts.threadId) {
      current = await taskService.update(current.id, {
        threadId: opts.threadId,
        ...(current.state === 'pending' ? { state: 'in_progress' as const } : {}),
        sourceThreadId: opts.sourceThreadId
      })
    }
    const target = opts.threadId ?? current.threadId
    if (target && (opts.prompt || opts.threadId)) {
      try {
        await sendToThread(target, opts.prompt ?? defaultPrompt)
      } catch (err) {
        console.warn('[task-import] failed to send prompt:', (err as Error).message)
      }
    }
    return (await taskService.get(current.id)) ?? current
  }

  async function importIssue(ref: ForgeRef, opts: ImportOpts): Promise<ImportResult> {
    const issueRef: ForgeRef = { ...ref, kind: 'issue' }
    const key = refKey(issueRef)
    const known = await taskService.findByProviderKey(key)
    let title = known?.name ?? ''
    let provider: IssueProvider | undefined
    if (!known) {
      const { stdout } = await exec('gh', ['issue', 'view', ref.id, '-R', ref.repo, '--json', 'title,state,url'])
      const data = JSON.parse(stdout) as { title?: string; state?: string; url?: string }
      title = data.title ?? ''
      provider = {
        kind: 'issue',
        refs: [issueRef],
        url: data.url ?? `https://github.com/${ref.repo}/issues/${ref.id}`,
        issueState: data.state === 'CLOSED' ? 'closed' : 'open',
        lastPolledAt: new Date().toISOString()
      }
    }
    const { task, created } = await taskService.ensureTask(key, {
      name: `Issue #${ref.id}: ${title || ref.repo}`,
      description: `GitHub issue: https://github.com/${ref.repo}/issues/${ref.id}`,
      parentTaskIds: opts.parentTaskIds,
      tags: [...(opts.tags ?? []), 'github-issue'],
      autoAssign: false,
      membrane: opts.membrane ?? null,
      sourceThreadId: opts.sourceThreadId,
      provider
    })
    const url = `https://github.com/${ref.repo}/issues/${ref.id}`
    const prompt = `[Issue #${ref.id}] ${title}\n${url}\n\nFetch the issue and its comments (\`gh issue view ${ref.id} -R ${ref.repo} --comments\`), then work it.`
    return { task: await assignAndPrompt(task, opts, prompt), created }
  }

  async function importPlan(project: string, planPath: string, opts: ImportOpts): Promise<ImportResult> {
    const key = planKey(project, planPath)
    const base = planPath.split('/').pop()!.replace(/\.md$/i, '')
    const { task, created } = await taskService.ensureTask(key, {
      name: opts.plan?.name?.trim() || `Plan: ${base}`,
      description: `Plan ${planPath} in ${project}`,
      parentTaskIds: opts.parentTaskIds,
      tags: [...(opts.tags ?? []), 'plan'],
      autoAssign: false,
      membrane: opts.membrane ?? null,
      sourceThreadId: opts.sourceThreadId,
      provider: { kind: 'plan', project, path: planPath, status: 'planned' }
    })
    const prompt = `[Plan] ${task.name}\n${project}: ${planPath}\n\nRead the plan and work on its next open step.`
    return { task: await assignAndPrompt(task, opts, prompt), created }
  }

  return {
    async import(opts) {
      const target = parseImportTarget(opts)
      if (target.type === 'plan') return importPlan(target.project, target.path, opts)

      // An item already tracked under either kind needs no GitHub call.
      const asChange = refKey({ ...target.ref, kind: 'change' })
      const asIssue = refKey({ ...target.ref, kind: 'issue' })
      let kind = target.kind
      if (!kind) {
        if (await taskService.findByProviderKey(asChange)) kind = 'change'
        else if (await taskService.findByProviderKey(asIssue)) kind = 'issue'
        else kind = await resolveKind(target.ref)
      }

      if (kind === 'issue') return importIssue(target.ref, opts)
      const before = await taskService.findByProviderKey(asChange)
      const task = await prPoll.importPr({
        repo: target.ref.repo,
        pr: Number(target.ref.id),
        threadId: opts.threadId,
        parentTaskIds: opts.parentTaskIds,
        tags: opts.tags,
        prompt: opts.prompt,
        membrane: opts.membrane,
        sourceThreadId: opts.sourceThreadId
      })
      return { task, created: !before }
    }
  }
}
