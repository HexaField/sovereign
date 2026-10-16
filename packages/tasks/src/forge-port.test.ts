// The provider ↔ work-graph status mapping behind the Forge TaskPort. The
// port itself is held to the TaskPort contract in packages/work-graph
// (task-port.contract.test.ts).

import { afterAll, describe, expect, it } from 'vitest'
import { createForgeTaskPort, statusOf, withStatus } from './forge-port.js'
import { createForgeMetaStore } from './meta.js'
import { createTaskService } from './service.js'
import { createInMemoryTaskStore } from './store.js'
import { cleanupTempDirs, makeBus, tempDir } from './testing/helpers.js'
import type { ChangeProvider, IssueProvider } from './types.js'

afterAll(cleanupTempDirs)

const ref = { forge: 'github' as const, host: 'github.com', repo: 'acme/widget', kind: 'change' as const, id: '4' }
const change: ChangeProvider = {
  kind: 'change',
  refs: [ref],
  url: 'https://github.com/acme/widget/pull/4',
  status: 'open',
  checksStatus: 'unknown',
  reviewDecision: 'unknown',
  unresolvedComments: 2,
  lastPolledAt: '2026-10-01T00:00:00.000Z'
}

describe('forge port status mapping', () => {
  it('maps a change both ways; an unread comment count keeps the stored one; green clears failed checks', () => {
    expect(statusOf(change)).toEqual({
      kind: 'change',
      state: 'open',
      checks: 'none',
      review: 'none',
      unresolvedComments: 2,
      lastPolledAt: change.lastPolledAt
    })
    const red = withStatus(change, {
      kind: 'change',
      state: 'open',
      checks: 'failing',
      failedChecks: ['build'],
      review: 'changes_requested',
      lastPolledAt: '2026-10-02T00:00:00.000Z'
    }) as ChangeProvider
    expect(red).toMatchObject({
      checksStatus: 'failing',
      failedChecks: ['build'],
      reviewDecision: 'changes_requested',
      unresolvedComments: 2,
      lastPolledAt: '2026-10-02T00:00:00.000Z'
    })
    const green = withStatus(red, {
      kind: 'change',
      state: 'merged',
      checks: 'passing',
      lastPolledAt: 'x'
    }) as ChangeProvider
    expect(green.failedChecks).toBeUndefined()
    expect(green).toMatchObject({ status: 'merged', checksStatus: 'passing', reviewDecision: 'changes_requested' })
    expect(() => withStatus(change, { kind: 'issue', state: 'open', lastPolledAt: 'x' })).toThrow(/issue/)
  })

  it('maps an issue close reason and a plan status', () => {
    const issue: IssueProvider = {
      kind: 'issue',
      refs: [{ ...ref, kind: 'issue' }],
      url: '',
      issueState: 'open',
      lastPolledAt: 'x'
    }
    const closed = withStatus(issue, {
      kind: 'issue',
      state: 'closed:not_planned',
      unresolvedComments: 1,
      lastPolledAt: 'y'
    })
    expect(closed).toMatchObject({ issueState: 'closed', closedReason: 'not_planned', unresolvedComments: 1 })
    expect(statusOf(closed)).toMatchObject({ state: 'closed:not_planned', unresolvedComments: 1 })
    expect(statusOf(withStatus(closed, { kind: 'issue', state: 'open', lastPolledAt: 'z' }))!.state).toBe('open')
    const plan = withStatus(
      { kind: 'plan', project: 'p', path: 'a.md', status: 'planned' },
      { kind: 'plan', state: 'done', lastPolledAt: '' }
    )
    expect(plan).toMatchObject({ status: 'done' })
  })

  it('takes a plan path from the key, not from init', async () => {
    const service = createTaskService({ store: createInMemoryTaskStore(), bus: makeBus().bus })
    const port = createForgeTaskPort({ service, meta: createForgeMetaStore({ dir: tempDir(), connect: null }) })
    const t = await port.ensureTask('plan:widget/plans/x.md', {
      name: 'X',
      membrane: 'acme',
      kind: 'plan',
      plan: { project: 'widget', path: '/home/somewhere/plans/x.md' }
    })
    expect((await service.get(t.id))!.provider).toEqual({
      kind: 'plan',
      project: 'widget',
      path: 'plans/x.md',
      status: 'planned'
    })
    await expect(port.ensureTask('not-a-key', { name: 'n', membrane: 'acme', kind: 'change' })).rejects.toThrow(
      /forge key/
    )
    await expect(
      port.setStatus((await port.createStream('acme', 's')).id, { kind: 'change', state: 'open', lastPolledAt: '' })
    ).rejects.toThrow(/no forge item/)
  })
})
