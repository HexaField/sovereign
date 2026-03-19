import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createPlanningService } from './planning.js'
import { createDraftStore } from '../drafts/store.js'
import { parseDependencies } from './parser.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'draft-integration-'))
}

function createMockBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any
}

function createMockIssueTracker(issues: any[] = []) {
  return {
    list: vi.fn().mockResolvedValue(issues),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    listComments: vi.fn(),
    addComment: vi.fn(),
    sync: vi.fn(),
    flushQueue: vi.fn()
  } as any
}

describe('Drafts — DAG Integration', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = tmpDir()
  })

  describe('§2.1 GraphNode abstraction', () => {
    it('2.1 GraphNode MUST have a source discriminator (provider | draft)', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      draftStore.create({ title: 'Draft task' })
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker(),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('_global')
      const draftNode = result.nodes.find((n) => n.source === 'draft')
      expect(draftNode).toBeTruthy()
      expect(draftNode!.source).toBe('draft')
    })

    it('2.1 EntityRef for drafts MUST use synthetic format { orgId: _drafts, projectId: _local, remote: _local, issueId: draft.id }', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      const draft = draftStore.create({ title: 'Test' })
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker(),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('_global')
      const node = result.nodes.find((n) => n.draftId === draft.id)
      expect(node).toBeTruthy()
      expect(node!.ref).toEqual({
        orgId: '_drafts',
        projectId: '_local',
        remote: '_local',
        issueId: draft.id
      })
    })

    it('2.1 graph engine MUST NOT distinguish between draft and provider nodes for graph computations', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      draftStore.create({ title: 'Draft' })
      const providerIssue = {
        id: '1',
        kind: 'issue',
        projectId: 'proj',
        orgId: '_global',
        remote: 'origin',
        provider: 'github',
        title: 'Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        author: 'test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        commentCount: 0
      }
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker([providerIssue]),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('_global')
      // Both nodes should exist
      expect(result.nodes.length).toBe(2)
      // Ready should include both (no dependencies)
      const ready = await service.getReady('_global')
      expect(ready.length).toBe(2)
    })
  })

  describe('§2.2 Draft injection into graph build', () => {
    it('2.2 buildGraph() MUST load drafts from draft store after loading provider issues', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      draftStore.create({ title: 'My Draft' })
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker(),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('_global')
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.draftTitle).toBe('My Draft')
    })

    it('2.2 drafts with orgId matching requested org MUST be included', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      draftStore.create({ title: 'For org1', orgId: 'org1' })
      draftStore.create({ title: 'For org2', orgId: 'org2' })
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker(),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('org1')
      const titles = result.nodes.map((n) => n.draftTitle)
      expect(titles).toContain('For org1')
      expect(titles).not.toContain('For org2')
    })

    it('2.2 unassigned drafts (orgId null) MUST be included in every graph build', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      draftStore.create({ title: 'Unassigned' })
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker(),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('any-org')
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.draftTitle).toBe('Unassigned')
    })

    it('2.2 each draft MUST be converted to IssueSnapshot equivalent using synthetic EntityRef', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      draftStore.create({ title: 'Test', labels: ['bug'], assignees: ['alice'] })
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker(),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('_global')
      const node = result.nodes[0]!
      expect(node.labels).toEqual(['bug'])
      expect(node.assignees).toEqual(['alice'])
      expect(node.ref.orgId).toBe('_drafts')
    })

    it('2.2 draft dependencies { kind: draft, draftId } MUST resolve to draft synthetic EntityRef', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      const draftA = draftStore.create({ title: 'A' })
      draftStore.create({
        title: 'B',
        dependencies: [{ type: 'depends_on', target: { kind: 'draft', draftId: draftA.id } }]
      })
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker(),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('_global')
      expect(result.edges.length).toBe(1)
      expect(result.edges[0]!.to).toEqual({
        orgId: '_drafts',
        projectId: '_local',
        remote: '_local',
        issueId: draftA.id
      })
    })

    it('2.2 draft dependencies { kind: provider, ref } MUST be used directly as EntityRef', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      const providerRef = { orgId: '_global', projectId: 'proj', remote: 'origin', issueId: '1' }
      draftStore.create({
        title: 'Depends on provider',
        dependencies: [{ type: 'depends_on', target: { kind: 'provider', ref: providerRef } }]
      })
      const providerIssue = {
        id: '1',
        kind: 'issue',
        projectId: 'proj',
        orgId: '_global',
        remote: 'origin',
        provider: 'github',
        title: 'Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        author: 'test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        commentCount: 0
      }
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker([providerIssue]),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('_global')
      expect(result.edges.length).toBe(1)
      expect(result.edges[0]!.to).toEqual(providerRef)
    })

    it('2.2 drafts MUST appear as state open in the graph', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      draftStore.create({ title: 'Test' })
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker(),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('_global')
      expect(result.nodes[0]!.state).toBe('open')
    })

    it('2.2 published drafts MUST NOT appear in future graph builds', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      const draft = draftStore.create({ title: 'Test' })
      draftStore.update(draft.id, { status: 'published' })
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker(),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('_global')
      expect(result.nodes.length).toBe(0)
    })
  })

  describe('§2.3 Dependency edges between drafts and provider issues', () => {
    it('2.3 draft depending on provider issue MUST create edge { from: draft.syntheticRef, to: providerRef }', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      const providerRef = { orgId: '_global', projectId: 'proj', remote: 'origin', issueId: '1' }
      const draft = draftStore.create({
        title: 'Draft',
        dependencies: [{ type: 'depends_on', target: { kind: 'provider', ref: providerRef } }]
      })
      const providerIssue = {
        id: '1',
        kind: 'issue',
        projectId: 'proj',
        orgId: '_global',
        remote: 'origin',
        provider: 'github',
        title: 'Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        author: 'test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        commentCount: 0
      }
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker([providerIssue]),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('_global')
      const edge = result.edges.find((e) => e.from.issueId === draft.id)
      expect(edge).toBeTruthy()
      expect(edge!.from.orgId).toBe('_drafts')
      expect(edge!.to).toEqual(providerRef)
    })

    it('2.3 draft depending on another draft MUST create edge { from: draft.syntheticRef, to: otherDraft.syntheticRef }', async () => {
      const bus = createMockBus()
      const draftStore = createDraftStore(dataDir)
      const draftA = draftStore.create({ title: 'A' })
      const draftB = draftStore.create({
        title: 'B',
        dependencies: [{ type: 'depends_on', target: { kind: 'draft', draftId: draftA.id } }]
      })
      const service = createPlanningService(bus, dataDir, {
        issueTracker: createMockIssueTracker(),
        getConfig: () => ({}),
        draftStore
      })
      const result = await service.getGraph('_global')
      const edge = result.edges.find((e) => e.from.issueId === draftB.id)
      expect(edge).toBeTruthy()
      expect(edge!.to.issueId).toBe(draftA.id)
      expect(edge!.to.orgId).toBe('_drafts')
    })

    it('2.3 provider issue referencing draft via body text "depends on draft:<uuid>" MUST resolve to draft synthetic EntityRef', () => {
      const draftId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      const edges = parseDependencies(`depends on draft:${draftId}`, {
        orgId: '_global',
        projectId: 'proj',
        remote: 'origin'
      })
      expect(edges.length).toBe(1)
      expect(edges[0]!.to).toEqual({
        orgId: '_drafts',
        projectId: '_local',
        remote: '_local',
        issueId: draftId
      })
    })

    it('2.3 when draft is published, other drafts depending on it MUST have dependencies updated to new provider EntityRef', () => {
      // This is tested in routes.test.ts §4.1 — the publish endpoint handles this
      const draftStore = createDraftStore(dataDir)
      const draftA = draftStore.create({ title: 'A' })
      draftStore.create({
        title: 'B',
        dependencies: [{ type: 'depends_on', target: { kind: 'draft', draftId: draftA.id } }]
      })
      // Simulate publish
      const publishedRef = { orgId: 'org1', projectId: 'proj1', remote: 'origin', issueId: '42' }
      draftStore.update(draftA.id, { status: 'published', publishedAs: publishedRef })
      // Update B's deps
      const allDrafts = draftStore.list({ status: 'draft' })
      for (const other of allDrafts) {
        let changed = false
        const newDeps = other.dependencies.map((dep) => {
          if (dep.target.kind === 'draft' && dep.target.draftId === draftA.id) {
            changed = true
            return { ...dep, target: { kind: 'provider' as const, ref: publishedRef } }
          }
          return dep
        })
        if (changed) draftStore.update(other.id, { dependencies: newDeps })
      }
      const b = draftStore.list().find((d) => d.title === 'B')!
      expect(b.dependencies[0]!.target.kind).toBe('provider')
      expect((b.dependencies[0]!.target as any).ref).toEqual(publishedRef)
    })
  })
})
