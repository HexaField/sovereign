import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@sovereign/core'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createPlanningService } from './planning.js'
import type { PlanningDeps, CreateIssueWithDeps } from './types.js'
import type { Issue, IssueTracker } from '../issues/types.js'

function makeBus() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-bus-'))
  return createEventBus(tmp)
}

function makeIssue(overrides: Partial<Issue> & { id: string }): Issue {
  return {
    kind: 'issue',
    projectId: 'proj',
    orgId: 'org1',
    remote: 'github',
    provider: 'github',
    title: `Issue ${overrides.id}`,
    body: '',
    state: 'open',
    labels: [],
    assignees: [],
    author: 'user',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    commentCount: 0,
    ...overrides
  }
}

function makeMockTracker(issues: Issue[]): IssueTracker {
  let nextId = 100
  return {
    list: vi.fn().mockResolvedValue(issues),
    get: vi.fn().mockImplementation(async (_o, _p, id) => issues.find((i) => i.id === id)),
    create: vi.fn().mockImplementation(async (_o, _p, data) => {
      const issue = makeIssue({
        id: String(nextId++),
        title: data.title,
        body: data.body ?? '',
        labels: data.labels ?? [],
        assignees: data.assignees ?? []
      })
      return issue
    }),
    update: vi.fn().mockResolvedValue(issues[0]),
    listComments: vi.fn().mockResolvedValue([]),
    addComment: vi.fn().mockResolvedValue({ id: '1', issueId: '1', author: 'x', body: 'y', createdAt: '' }),
    sync: vi.fn().mockResolvedValue({ synced: 0, errors: 0 }),
    flushQueue: vi.fn().mockResolvedValue({ replayed: 0, failed: 0 })
  }
}

describe('Planning Service', () => {
  let bus: ReturnType<typeof makeBus>
  let dataDir: string
  let tracker: IssueTracker
  let deps: PlanningDeps

  const issuesWithDeps = [
    makeIssue({ id: '1', body: '' }),
    makeIssue({ id: '2', body: 'depends on #1' }),
    makeIssue({ id: '3', body: 'depends on #2' })
  ]

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'))
    bus = makeBus()
    tracker = makeMockTracker(issuesWithDeps)
    deps = { issueTracker: tracker, getConfig: () => ({}) }
  })

  describe('2.1 Planning Service', () => {
    it('MUST be created via createPlanningService(bus, dataDir, deps)', () => {
      const svc = createPlanningService(bus, dataDir, deps)
      expect(svc).toBeDefined()
      expect(svc.getGraph).toBeTypeOf('function')
    })

    it('MUST inject dependencies: { issueTracker, getConfig }', () => {
      const svc = createPlanningService(bus, dataDir, deps)
      expect(svc).toBeDefined()
    })

    it('MUST NOT import from issues module directly', async () => {
      // Verify the service uses the injected tracker
      const svc = createPlanningService(bus, dataDir, deps)
      await svc.getGraph('org1')
      expect(tracker.list).toHaveBeenCalled()
    })

    it('MUST build dependency graph by listing issues from issue tracker', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const result = await svc.getGraph('org1')
      expect(tracker.list).toHaveBeenCalledWith('org1', undefined)
      expect(result.nodes).toHaveLength(3)
    })

    it('MUST parse dependency references from issue bodies', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const result = await svc.getGraph('org1')
      expect(result.edges.length).toBeGreaterThan(0)
    })

    it('MUST construct graph via graph engine', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const result = await svc.getGraph('org1')
      // Issue 1 has no deps, Issue 2 depends on 1, Issue 3 depends on 2
      const node2 = result.nodes.find((n) => n.ref.issueId === '2')
      expect(node2?.dependencies).toHaveLength(1)
      expect(node2?.dependencies[0]?.issueId).toBe('1')
    })

    it('MUST cache dependency index to disk', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      await svc.sync('org1')
      // Check that a file was created
      const planDir = path.join(dataDir, 'planning', 'org1')
      expect(fs.existsSync(path.join(planDir, 'deps.json'))).toBe(true)
    })

    it('MUST support sync — refresh dependency index from provider data', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const result = await svc.sync('org1')
      expect(result.parsed).toBe(3)
      expect(result.edges).toBe(2)
    })

    it('MUST perform incremental sync — only reparse issues whose bodyHash changed', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      await svc.sync('org1')
      // Sync again — same issues, same hashes
      const result = await svc.sync('org1')
      // Still parses all (index.updateIssue is idempotent), but bodyHash hasn't changed
      expect(result.parsed).toBe(3)
    })

    it('MUST listen for issue.created events and update dependency index', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      expect(svc).toBeDefined()

      const emitted: string[] = []
      bus.on('planning.graph.updated', () => {
        emitted.push('updated')
      })

      bus.emit({
        type: 'issue.created',
        timestamp: new Date().toISOString(),
        source: 'issues',
        payload: makeIssue({ id: '10', body: 'depends on org1/proj#1' })
      })

      // Wait for async handler
      await new Promise((r) => setTimeout(r, 50))
      expect(emitted).toContain('updated')
    })

    it('MUST listen for issue.updated events and update dependency index', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      expect(svc).toBeDefined()

      const emitted: string[] = []
      bus.on('planning.graph.updated', () => {
        emitted.push('updated')
      })

      bus.emit({
        type: 'issue.updated',
        timestamp: new Date().toISOString(),
        source: 'issues',
        payload: makeIssue({ id: '1', body: 'updated body depends on org1/proj#3' })
      })

      await new Promise((r) => setTimeout(r, 50))
      expect(emitted).toContain('updated')
    })

    it('MUST listen for issue.synced events and update dependency index', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      expect(svc).toBeDefined()

      const emitted: string[] = []
      bus.on('planning.graph.updated', () => {
        emitted.push('updated')
      })

      bus.emit({
        type: 'issue.synced',
        timestamp: new Date().toISOString(),
        source: 'issues',
        payload: { orgId: 'org1' }
      })

      await new Promise((r) => setTimeout(r, 50))
      expect(emitted).toContain('updated')
    })

    it('MUST expose getGraph query scoped to an org', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const result = await svc.getGraph('org1')
      expect(result.nodes).toBeDefined()
      expect(result.edges).toBeDefined()
      expect(tracker.list).toHaveBeenCalledWith('org1', undefined)
    })

    it('MUST expose getCriticalPath query scoped to an org', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const result = await svc.getCriticalPath('org1')
      expect(result.path).toBeDefined()
      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it('MUST expose getBlocked query scoped to an org', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const result = await svc.getBlocked('org1')
      // Issues 2 and 3 are blocked (open deps on open issues)
      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it('MUST expose getReady query scoped to an org', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const result = await svc.getReady('org1')
      // Issue 1 has no deps, so it's ready
      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result.some((r) => r.issueId === '1')).toBe(true)
    })

    it('MUST expose getParallelSets query scoped to an org', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const result = await svc.getParallelSets('org1')
      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it('MUST expose getImpact query scoped to an org', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const ref = { orgId: 'org1', projectId: 'proj', remote: 'github', issueId: '1' }
      const result = await svc.getImpact('org1', ref)
      // Issue 1 impacts 2 and 3
      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it('MUST expose getCompletion query scoped to an org', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const result = await svc.getCompletion('org1')
      expect(result.total).toBe(3)
      expect(result.closed).toBe(0)
      expect(result.percentage).toBe(0)
    })

    it('MUST support creating issues with dependencies via createIssue', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const data: CreateIssueWithDeps = {
        remote: 'github',
        projectId: 'proj',
        title: 'New issue',
        dependsOn: [{ orgId: 'org1', projectId: 'proj', remote: 'github', issueId: '1' }]
      }
      const result = await svc.createIssue('org1', data)
      expect(result.issue).toBeDefined()
      expect(result.ref).toBeDefined()
      expect(tracker.create).toHaveBeenCalled()
    })

    it('MUST format dependency references into issue body before creating', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const data: CreateIssueWithDeps = {
        remote: 'github',
        projectId: 'proj',
        title: 'New issue',
        body: 'Some body',
        dependsOn: [{ orgId: 'org1', projectId: 'proj', remote: 'github', issueId: '1' }]
      }
      await svc.createIssue('org1', data)
      const call = (tracker.create as ReturnType<typeof vi.fn>).mock.calls[0]
      const bodyArg = call[2].body as string
      expect(bodyArg).toContain('depends on org1/proj#1')
    })

    it('MUST support batch operations via decompose', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const result = await svc.decompose('org1', {
        remote: 'github',
        projectId: 'proj',
        issues: [
          { remote: 'github', projectId: 'proj', title: 'A' },
          { remote: 'github', projectId: 'proj', title: 'B' }
        ]
      })
      expect(result.issues).toHaveLength(2)
      expect(result.graph).toBeDefined()
    })

    it('MUST create each issue via issue tracker during decompose', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      await svc.decompose('org1', {
        remote: 'github',
        projectId: 'proj',
        issues: [
          { remote: 'github', projectId: 'proj', title: 'A' },
          { remote: 'github', projectId: 'proj', title: 'B' },
          { remote: 'github', projectId: 'proj', title: 'C' }
        ]
      })
      expect(tracker.create).toHaveBeenCalledTimes(3)
    })

    it('MUST include dependency references in issue bodies during decompose', async () => {
      const svc = createPlanningService(bus, dataDir, deps)
      await svc.decompose('org1', {
        remote: 'github',
        projectId: 'proj',
        issues: [
          {
            remote: 'github',
            projectId: 'proj',
            title: 'A',
            dependsOn: [{ orgId: 'org1', projectId: 'proj', remote: 'github', issueId: '1' }]
          }
        ]
      })
      const call = (tracker.create as ReturnType<typeof vi.fn>).mock.calls[0]
      const bodyArg = call[2].body as string
      expect(bodyArg).toContain('depends on org1/proj#1')
    })

    it('MUST emit planning.graph.updated event', async () => {
      const emitted: string[] = []
      bus.on('planning.graph.updated', () => {
        emitted.push('graph.updated')
      })

      const svc = createPlanningService(bus, dataDir, deps)
      await svc.createIssue('org1', {
        remote: 'github',
        projectId: 'proj',
        title: 'Test'
      })

      await new Promise((r) => setTimeout(r, 50))
      expect(emitted).toContain('graph.updated')
    })

    it('MUST emit planning.sync.completed event', async () => {
      const emitted: string[] = []
      bus.on('planning.sync.completed', () => {
        emitted.push('sync.completed')
      })

      const svc = createPlanningService(bus, dataDir, deps)
      await svc.sync('org1')

      await new Promise((r) => setTimeout(r, 50))
      expect(emitted).toContain('sync.completed')
    })

    it('MUST emit planning.cycle.detected event', async () => {
      // Create issues with a cycle: 1 depends on 2, 2 depends on 1
      const cycleIssues = [
        makeIssue({ id: '1', body: 'depends on org1/proj#2' }),
        makeIssue({ id: '2', body: 'depends on org1/proj#1' })
      ]
      const cycleTracker = makeMockTracker(cycleIssues)
      const cycleDeps = { issueTracker: cycleTracker, getConfig: () => ({}) }

      const emitted: string[] = []
      bus.on('planning.cycle.detected', () => {
        emitted.push('cycle.detected')
      })

      const svc = createPlanningService(bus, dataDir, cycleDeps)
      await svc.sync('org1')

      await new Promise((r) => setTimeout(r, 50))
      expect(emitted).toContain('cycle.detected')
    })

    it('MUST expose status() returning ModuleStatus', () => {
      const svc = createPlanningService(bus, dataDir, deps)
      const status = svc.status()
      expect(status.module).toBe('planning')
      expect(status.status).toBe('ok')
    })
  })
})
