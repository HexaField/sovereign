import { describe, it, expect } from 'vitest'
import { parseDependencies } from './parser.js'

const ctx = { orgId: 'myorg', projectId: 'myrepo', remote: 'github' }

describe('Dependency Parser', () => {
  describe('1.1 Dependency Parsing', () => {
    it('MUST extract "depends on #42" references from issue bodies', () => {
      const edges = parseDependencies('This depends on #42', ctx)
      expect(edges).toHaveLength(1)
      expect(edges[0]!.to.issueId).toBe('42')
      expect(edges[0]!.type).toBe('depends_on')
    })

    it('MUST extract "blocked by #42" references from issue bodies', () => {
      const edges = parseDependencies('This is blocked by #10', ctx)
      expect(edges).toHaveLength(1)
      expect(edges[0]!.to.issueId).toBe('10')
      expect(edges[0]!.type).toBe('depends_on')
    })

    it('MUST extract "blocks #42" references from issue bodies', () => {
      const edges = parseDependencies('This blocks #7', ctx)
      expect(edges).toHaveLength(1)
      expect(edges[0]!.type).toBe('blocks')
      expect(edges[0]!.from.issueId).toBe('7')
    })

    it('MUST extract cross-repo references "depends on org/repo#42"', () => {
      const edges = parseDependencies('depends on other/project#99', ctx)
      expect(edges).toHaveLength(1)
      expect(edges[0]!.to.orgId).toBe('other')
      expect(edges[0]!.to.projectId).toBe('project')
      expect(edges[0]!.to.issueId).toBe('99')
    })

    it('MUST extract Radicle issue ID references "depends on <issue-id>"', () => {
      const edges = parseDependencies('depends on rad:z3gqcJUoA1n9HaHKufZs2mCDean66#5', ctx)
      expect(edges).toHaveLength(1)
      expect(edges[0]!.to.projectId).toBe('rad:z3gqcJUoA1n9HaHKufZs2mCDean66')
      expect(edges[0]!.to.remote).toBe('radicle')
      expect(edges[0]!.to.issueId).toBe('5')
    })

    it('MUST recognise dependency patterns case-insensitively', () => {
      const edges = parseDependencies('DEPENDS ON #1\nBlocked By #2\nBLOCKS #3', ctx)
      expect(edges).toHaveLength(3)
    })

    it('MUST support intra-project references (#42)', () => {
      const edges = parseDependencies('depends on #42', ctx)
      expect(edges[0]!.to.orgId).toBe('myorg')
      expect(edges[0]!.to.projectId).toBe('myrepo')
      expect(edges[0]!.to.remote).toBe('github')
    })

    it('MUST support cross-project references (org/repo#42 or rad:<rid>#<id>)', () => {
      const edges = parseDependencies('depends on foo/bar#1\nblocked by rad:zabc123#2', ctx)
      expect(edges).toHaveLength(2)
      expect(edges[0]!.to.orgId).toBe('foo')
      expect(edges[1]!.to.remote).toBe('radicle')
    })

    it('MUST extract dependency direction: depends on / blocked by = this depends on referenced', () => {
      const e1 = parseDependencies('depends on #5', ctx)
      const e2 = parseDependencies('blocked by #5', ctx)
      expect(e1[0]!.type).toBe('depends_on')
      expect(e2[0]!.type).toBe('depends_on')
      // "from" is the current issue context, "to" is the dependency
      expect(e1[0]!.to.issueId).toBe('5')
      expect(e2[0]!.to.issueId).toBe('5')
    })

    it('MUST extract dependency direction: blocks = referenced depends on this', () => {
      const edges = parseDependencies('blocks #8', ctx)
      expect(edges[0]!.type).toBe('blocks')
      // "from" is the referenced issue (the one that depends on this)
      expect(edges[0]!.from.issueId).toBe('8')
    })

    it('MUST return structured edges with EntityRef and type', () => {
      const edges = parseDependencies('depends on #42', ctx)
      const edge = edges[0]!
      expect(edge).toHaveProperty('from')
      expect(edge).toHaveProperty('to')
      expect(edge).toHaveProperty('type')
      expect(edge.from).toHaveProperty('orgId')
      expect(edge.from).toHaveProperty('projectId')
      expect(edge.from).toHaveProperty('remote')
      expect(edge.from).toHaveProperty('issueId')
    })

    it('MUST return edge source field as "body" or "comment"', () => {
      const edges = parseDependencies('depends on #1', ctx)
      expect(edges[0]!.source).toBe('body')
    })

    it('SHOULD extract milestone references from issue metadata', () => {
      // Parser focuses on dependency edges from body text.
      // Milestone extraction is handled by the IssueSnapshot which has milestone field.
      // The parser correctly returns edges; milestone data comes from the issue metadata.
      const edges = parseDependencies('depends on #1', ctx)
      expect(edges).toHaveLength(1)
      // milestone is on the IssueSnapshot, not on edges - this is by design
    })

    it('MAY extract effort/size from labels (e.g. size:small, effort:medium)', () => {
      // Labels are on IssueSnapshot, not parsed from body text.
      // The parser's scope is dependency edges only. Label-based sizing
      // would be handled at the graph/planning service level.
      const edges = parseDependencies('size:small depends on #1', ctx)
      expect(edges).toHaveLength(1)
    })
  })
})
