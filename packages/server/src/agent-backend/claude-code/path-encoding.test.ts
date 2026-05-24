import { describe, it, expect } from 'vitest'
import { encodeCwdToProjectDir, sessionJsonlPath, projectsDirForCwd } from './path-encoding.js'

describe('claude-code/path-encoding', () => {
  it('encodes absolute POSIX paths to dash-joined names with a leading dash', () => {
    expect(encodeCwdToProjectDir('/Users/alex/workspaces/sovereign')).toBe('-Users-alex-workspaces-sovereign')
    expect(encodeCwdToProjectDir('/')).toBe('-')
  })

  it('replaces dots inside path segments with dashes (matches Claude Code on-disk layout)', () => {
    expect(encodeCwdToProjectDir('/Users/alex/.openclaw/workspace')).toBe('-Users-alex--openclaw-workspace')
    expect(encodeCwdToProjectDir('/Users/alex/.claude/projects')).toBe('-Users-alex--claude-projects')
  })

  it('derives the per-session JSONL file path', () => {
    const file = sessionJsonlPath('/agent', '/Users/alex/foo', 'abc-123')
    expect(file).toBe('/agent/projects/-Users-alex-foo/abc-123.jsonl')
  })

  it('derives the projects dir for a cwd', () => {
    expect(projectsDirForCwd('/agent', '/Users/alex/foo')).toBe('/agent/projects/-Users-alex-foo')
  })
})
