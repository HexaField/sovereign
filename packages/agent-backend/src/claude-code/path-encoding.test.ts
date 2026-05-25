import { describe, it, expect } from 'vitest'
import { encodeCwdToProjectDir, sessionJsonlPath, projectsDirForCwd } from './path-encoding.js'

describe('claude-code/path-encoding', () => {
  it('encodes absolute POSIX paths to dash-joined names with a leading dash', () => {
    expect(encodeCwdToProjectDir('/Users/josh/workspaces/sovereign')).toBe('-Users-josh-workspaces-sovereign')
    expect(encodeCwdToProjectDir('/')).toBe('-')
  })

  it('replaces dots inside path segments with dashes (matches Claude Code on-disk layout)', () => {
    expect(encodeCwdToProjectDir('/Users/josh/.openclaw/workspace')).toBe('-Users-josh--openclaw-workspace')
    expect(encodeCwdToProjectDir('/Users/josh/.claude/projects')).toBe('-Users-josh--claude-projects')
  })

  it('derives the per-session JSONL file path', () => {
    const file = sessionJsonlPath('/agent', '/Users/josh/foo', 'abc-123')
    expect(file).toBe('/agent/projects/-Users-josh-foo/abc-123.jsonl')
  })

  it('derives the projects dir for a cwd', () => {
    expect(projectsDirForCwd('/agent', '/Users/josh/foo')).toBe('/agent/projects/-Users-josh-foo')
  })
})
