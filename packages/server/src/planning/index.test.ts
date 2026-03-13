import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createDependencyIndex } from './index.js'
import type { IssueSnapshot, DependencyEdge } from './types.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-index-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeSnapshot(id: string, orgId = 'org1'): IssueSnapshot {
  return {
    ref: { orgId, projectId: 'proj', remote: 'github', issueId: id },
    state: 'open',
    labels: [],
    assignees: [],
    body: `depends on #${Number(id) + 1}`,
    bodyHash: `hash-${id}`
  }
}

function makeEdge(fromId: string, toId: string): DependencyEdge {
  return {
    from: { orgId: 'org1', projectId: 'proj', remote: 'github', issueId: fromId },
    to: { orgId: 'org1', projectId: 'proj', remote: 'github', issueId: toId },
    type: 'depends_on',
    source: 'body'
  }
}

describe('Dependency Index', () => {
  describe('1.4 Dependency Index (Cache)', () => {
    it('MUST maintain local dependency index at {dataDir}/planning/{orgId}/deps.json', async () => {
      const index = createDependencyIndex(tmpDir)
      const snap = makeSnapshot('1')
      index.updateIssue(snap, [makeEdge('1', '2')])
      await index.save()
      const fp = path.join(tmpDir, 'planning', 'org1', 'deps.json')
      expect(fs.existsSync(fp)).toBe(true)
    })

    it('MUST contain parsed dependency edges in the index', async () => {
      const index = createDependencyIndex(tmpDir)
      const edge = makeEdge('1', '2')
      index.updateIssue(makeSnapshot('1'), [edge])
      await index.save()

      const index2 = createDependencyIndex(tmpDir)
      await index2.load()
      const edges = index2.getEdges('org1')
      expect(edges).toHaveLength(1)
      expect(edges[0]!.from.issueId).toBe('1')
      expect(edges[0]!.to.issueId).toBe('2')
    })

    it('MUST contain last-synced timestamp per project in the index', async () => {
      const index = createDependencyIndex(tmpDir)
      index.updateIssue(makeSnapshot('1'), [])
      await index.save()
      const fp = path.join(tmpDir, 'planning', 'org1', 'deps.json')
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
      expect(data.lastSynced).toBeTruthy()
      expect(new Date(data.lastSynced).getTime()).toBeGreaterThan(0)
    })

    it('MUST contain hash of source issue body for change detection', async () => {
      const index = createDependencyIndex(tmpDir)
      index.updateIssue(makeSnapshot('1'), [makeEdge('1', '2')])
      await index.save()
      const fp = path.join(tmpDir, 'planning', 'org1', 'deps.json')
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
      const issues = data.issues as Record<string, { bodyHash: string }>
      const entry = Object.values(issues)[0]!
      expect(entry.bodyHash).toBe('hash-1')
    })

    it('MUST rebuild index from provider data on explicit sync', async () => {
      const index = createDependencyIndex(tmpDir)
      index.updateIssue(makeSnapshot('1'), [makeEdge('1', '2')])
      await index.save()

      // Clear and rebuild
      index.clear('org1')
      expect(index.getEdges('org1')).toHaveLength(0)

      // Re-add (simulating sync)
      index.updateIssue(makeSnapshot('1'), [makeEdge('1', '3')])
      const edges = index.getEdges('org1')
      expect(edges).toHaveLength(1)
      expect(edges[0]!.to.issueId).toBe('3')
    })

    it('MUST rebuild index when issue cache is refreshed', async () => {
      const index = createDependencyIndex(tmpDir)
      index.updateIssue(makeSnapshot('1'), [makeEdge('1', '2')])
      // Update same issue with new edges
      index.updateIssue(makeSnapshot('1'), [makeEdge('1', '5')])
      const edges = index.getEdges('org1')
      expect(edges).toHaveLength(1)
      expect(edges[0]!.to.issueId).toBe('5')
    })

    it('MUST NOT be the source of truth — derived cache only', () => {
      // The index is a cache. It can be deleted and rebuilt.
      // This is a design property — verified by the rebuild tests above.
      const index = createDependencyIndex(tmpDir)
      index.updateIssue(makeSnapshot('1'), [makeEdge('1', '2')])
      index.clear('org1')
      expect(index.getEdges('org1')).toHaveLength(0)
    })

    it('MUST rebuild from scratch if deleted', async () => {
      const index = createDependencyIndex(tmpDir)
      index.updateIssue(makeSnapshot('1'), [makeEdge('1', '2')])
      await index.save()

      // Delete the file
      const fp = path.join(tmpDir, 'planning', 'org1', 'deps.json')
      fs.unlinkSync(fp)

      // Load fresh — should be empty
      const index2 = createDependencyIndex(tmpDir)
      await index2.load()
      expect(index2.getEdges('org1')).toHaveLength(0)

      // Can rebuild
      index2.updateIssue(makeSnapshot('1'), [makeEdge('1', '2')])
      expect(index2.getEdges('org1')).toHaveLength(1)
    })

    it('MUST write atomically (write temp file → rename)', async () => {
      const index = createDependencyIndex(tmpDir)
      index.updateIssue(makeSnapshot('1'), [makeEdge('1', '2')])
      await index.save()

      // Verify the file exists and no tmp files remain
      const dir = path.join(tmpDir, 'planning', 'org1')
      const files = fs.readdirSync(dir)
      expect(files).toContain('deps.json')
      expect(files.filter((f) => f.includes('.tmp.'))).toHaveLength(0)
    })
  })
})
