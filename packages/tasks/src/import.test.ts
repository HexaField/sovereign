// task_import: parsing refKeys, URLs and plans, and importing them idempotently.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTaskImporter, parseImportTarget } from './import.js'
import { createPrPollService } from './pr-poll.js'
import { createTaskService, type TaskService } from './service.js'
import { createInMemoryTaskStore } from './store.js'
import { makeBus } from './testing/helpers.js'

describe('parseImportTarget', () => {
  it('parses a refKey (kind unknown until GitHub is asked)', () => {
    expect(parseImportTarget({ ref: 'github:github.com/coasys/ad4m#1390' })).toEqual({
      type: 'forge',
      ref: { forge: 'github', host: 'github.com', repo: 'coasys/ad4m', kind: 'change', id: '1390' }
    })
  })

  it('parses the owner/name#N shorthand', () => {
    expect(parseImportTarget({ ref: 'coasys/we#159' })).toMatchObject({
      type: 'forge',
      ref: { repo: 'coasys/we', id: '159' }
    })
  })

  it('parses PR and issue URLs, with extra path and query', () => {
    expect(parseImportTarget({ url: 'https://github.com/coasys/ad4m/pull/712/files?w=1' })).toEqual({
      type: 'forge',
      kind: 'change',
      ref: { forge: 'github', host: 'github.com', repo: 'coasys/ad4m', kind: 'change', id: '712' }
    })
    expect(parseImportTarget({ url: 'https://github.com/coasys/we/issues/12#issuecomment-1' })).toEqual({
      type: 'forge',
      kind: 'issue',
      ref: { forge: 'github', host: 'github.com', repo: 'coasys/we', kind: 'issue', id: '12' }
    })
  })

  it('parses a plan and trims a leading slash', () => {
    expect(parseImportTarget({ plan: { project: 'sovereign', path: '/plans/forge.md' } })).toEqual({
      type: 'plan',
      project: 'sovereign',
      path: 'plans/forge.md'
    })
  })

  it('rejects anything else with a clear message', () => {
    expect(() => parseImportTarget({})).toThrow(/exactly one/)
    expect(() => parseImportTarget({ ref: 'coasys/we#1', url: 'https://github.com/coasys/we/pull/1' })).toThrow(
      /exactly one/
    )
    expect(() => parseImportTarget({ ref: 'github:github.com/coasys/we@feat/x' })).toThrow(/refKey/)
    expect(() => parseImportTarget({ ref: 'radicle:seed.example/rad:z3abc#abc' })).toThrow(/Only GitHub/)
    expect(() => parseImportTarget({ ref: 'github:github.com/coasys/we#abc' })).toThrow(/numeric/)
    expect(() => parseImportTarget({ url: 'https://gitlab.com/a/b/-/merge_requests/1' })).toThrow(/github.com/)
    expect(() => parseImportTarget({ url: 'https://github.com/coasys/we/tree/main' })).toThrow(/pull request or issue/)
    expect(() => parseImportTarget({ url: 'not a url' })).toThrow(/Not a URL/)
    expect(() => parseImportTarget({ plan: { project: 'a/b', path: 'x.md' } })).toThrow(/project id/)
  })
})

describe('task importer', () => {
  let svc: TaskService
  let sent: Array<{ threadId: string; text: string }>
  let exec: ReturnType<typeof vi.fn>

  function prJson(state = 'OPEN') {
    return JSON.stringify({
      state,
      isDraft: false,
      reviewDecision: null,
      statusCheckRollup: [],
      title: 'Add the widget',
      headRefName: 'feat/widget',
      comments: []
    })
  }

  beforeEach(() => {
    svc = createTaskService({ store: createInMemoryTaskStore(), bus: makeBus().bus })
    sent = []
    exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'api') return { stdout: args[1].endsWith('/7') ? 'false\n' : 'true\n' }
      if (args[0] === 'pr') return { stdout: prJson() }
      if (args[0] === 'issue')
        return {
          stdout: JSON.stringify({
            title: 'Crash on start',
            state: 'OPEN',
            url: 'https://github.com/org/repo/issues/7'
          })
        }
      throw new Error(`unexpected gh ${args.join(' ')}`)
    })
  })

  function importer() {
    const sendToThread = async (threadId: string, text: string) => void sent.push({ threadId, text })
    const prPoll = createPrPollService({ taskService: svc, bus: makeBus().bus, sendToThread, execFn: exec as never })
    return { importer: createTaskImporter({ taskService: svc, prPoll, sendToThread, exec: exec as never }), prPoll }
  }

  it('imports a refKey that GitHub says is a PR, once', async () => {
    const { importer: imp, prPoll } = importer()
    const first = await imp.import({ ref: 'github:github.com/org/repo#42', membrane: 'coasys', sourceThreadId: 't' })
    const again = await imp.import({ url: 'https://github.com/org/repo/pull/42', sourceThreadId: 't' })
    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    expect(again.task.id).toBe(first.task.id)
    expect(first.task).toMatchObject({ membrane: 'coasys', provider: { kind: 'change', status: 'open' } })
    // The second import knew the item: no second "PR or issue?" call.
    expect(exec.mock.calls.filter((c) => c[1][0] === 'api')).toHaveLength(1)
    prPoll.dispose()
  })

  it('imports a refKey that GitHub says is an issue, assigns it and sends the prompt', async () => {
    const { importer: imp } = importer()
    const { task, created } = await imp.import({
      ref: 'github:github.com/org/repo#7',
      threadId: 'thread-1',
      sourceThreadId: 't'
    })
    expect(created).toBe(true)
    expect(task).toMatchObject({
      name: 'Issue #7: Crash on start',
      threadId: 'thread-1',
      state: 'in_progress',
      provider: { kind: 'issue', issueState: 'open', refs: [{ kind: 'issue', repo: 'org/repo', id: '7' }] }
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('gh issue view 7 -R org/repo')
    const again = await imp.import({ url: 'https://github.com/org/repo/issues/7', sourceThreadId: 't' })
    expect(again).toMatchObject({ created: false, task: { id: task.id } })
  })

  it('imports a plan with no GitHub call, under a stream', async () => {
    const { importer: imp } = importer()
    const stream = await svc.createStream({ name: 'Forge', sourceThreadId: 't' })
    const { task } = await imp.import({
      plan: { project: 'sovereign', path: 'plans/forge.md', name: 'Forge plan' },
      parentTaskIds: [stream.id],
      sourceThreadId: 't'
    })
    expect(task).toMatchObject({
      name: 'Forge plan',
      provider: { kind: 'plan', project: 'sovereign', path: 'plans/forge.md', status: 'planned' },
      parentTasks: [{ id: stream.id }]
    })
    expect(exec).not.toHaveBeenCalled()
    expect((await svc.findByProviderKey('plan:sovereign/plans/forge.md'))!.id).toBe(task.id)
  })
})
