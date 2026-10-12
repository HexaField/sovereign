import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSubagentSystemPrompt, findRepoContext, selectSubagentMcpServers } from './subagent-runner.js'

describe('claude-code/subagent-runner', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sov-runner-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  describe('findRepoContext', () => {
    it('finds the nearest AGENTS.md above cwd, preferring it over CLAUDE.md', () => {
      const repo = join(root, 'repo')
      mkdirSync(join(repo, 'packages', 'a'), { recursive: true })
      writeFileSync(join(repo, 'AGENTS.md'), ' agents ')
      writeFileSync(join(repo, 'CLAUDE.md'), 'claude')
      expect(findRepoContext(join(repo, 'packages', 'a'), root)).toEqual({
        file: join(repo, 'AGENTS.md'),
        text: 'agents'
      })
    })

    it('falls back to CLAUDE.md and stops at stopAt', () => {
      mkdirSync(join(root, 'repo', 'sub'), { recursive: true })
      writeFileSync(join(root, 'repo', 'CLAUDE.md'), 'claude')
      writeFileSync(join(root, 'AGENTS.md'), 'above')
      expect(findRepoContext(join(root, 'repo', 'sub'), join(root, 'repo'))?.text).toBe('claude')
      mkdirSync(join(root, 'other'))
      expect(findRepoContext(join(root, 'other'), join(root, 'other'))).toBeNull()
    })
  })

  describe('buildSubagentSystemPrompt', () => {
    it('joins SUBAGENT.md, repo context and environment', () => {
      const cfg = join(root, 'cfg')
      const repo = join(root, 'repo')
      mkdirSync(cfg)
      mkdirSync(repo)
      writeFileSync(join(cfg, 'SUBAGENT.md'), 'Rules.\n')
      writeFileSync(join(repo, 'AGENTS.md'), 'Repo.')
      const prompt = buildSubagentSystemPrompt({ configDir: cfg, cwd: repo, home: root, now: new Date('2026-10-12') })
      expect(prompt).toBe(
        `Rules.\n\n# Repo context (${join(repo, 'AGENTS.md')})\n\nRepo.\n\n# Environment\n\n- Working directory: ${repo}\n- Platform: ${process.platform}\n- Date: 2026-10-12`
      )
    })

    it('skips repo context when cwd is the config dir', () => {
      const cfg = join(root, 'cfg')
      mkdirSync(cfg)
      writeFileSync(join(cfg, 'SUBAGENT.md'), 'Rules.')
      writeFileSync(join(cfg, 'AGENTS.md'), 'Personality source.')
      const prompt = buildSubagentSystemPrompt({ configDir: cfg, cwd: cfg, home: root })
      expect(prompt).not.toContain('Personality source.')
      expect(prompt.startsWith('Rules.\n\n# Environment')).toBe(true)
    })
  })

  describe('selectSubagentMcpServers', () => {
    it('keeps only the subagent servers, merging user-scope ones', () => {
      const claudeJson = join(root, '.claude.json')
      writeFileSync(claudeJson, JSON.stringify({ mcpServers: { semble: { command: 's' }, other: { command: 'o' } } }))
      const out = selectSubagentMcpServers(
        { sovereign: { url: 'u' }, ad4m: { url: 'a' }, code: { command: 'c' } },
        claudeJson
      )
      expect(out).toEqual({ semble: { command: 's' }, code: { command: 'c' }, sovereign: { url: 'u' } })
    })

    it('works without ~/.claude.json', () => {
      expect(selectSubagentMcpServers({ sovereign: { url: 'u' } }, join(root, 'missing.json'))).toEqual({
        sovereign: { url: 'u' }
      })
    })
  })
})
