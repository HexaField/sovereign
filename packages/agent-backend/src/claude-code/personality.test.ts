import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDefaultSubagentFile, ensureLayeredContextFile, findUnreachableAgentModels } from './personality.js'

describe('claude-code/personality', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sov-cc-pers-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('seeds .claude/CLAUDE.md when missing, leaves existing files untouched', () => {
    ensureLayeredContextFile(cwd)
    const path = join(cwd, '.claude', 'CLAUDE.md')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toMatch(/Sovereign workspace context/)

    writeFileSync(path, '# my own layered context\nentirely user-owned.\n')
    ensureLayeredContextFile(cwd)
    expect(readFileSync(path, 'utf-8')).toBe('# my own layered context\nentirely user-owned.\n')
  })

  it('writes the default subagent template', () => {
    ensureDefaultSubagentFile(cwd)
    const path = join(cwd, '.claude', 'agents', 'sovereign-default-subagent.md')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toMatch(/sovereign-default-subagent/)
  })

  it('flags agent definitions whose model a Claude session cannot reach', () => {
    const dir = join(cwd, 'agents')
    mkdirSync(join(dir, 'team', 'x.md'), { recursive: true }) // a directory named *.md
    const agent = (name: string, model?: string) =>
      `---\nname: ${name}\n${model !== undefined ? `model: ${model}\n` : ''}description: d\n---\nbody\n`
    // unreachable: local models, wherever and however they are written
    writeFileSync(join(dir, 'local.md'), agent('local', 'qwen3.8-27b'))
    writeFileSync(join(dir, 'crlf.md'), agent('crlf', "'qwen3.6-35b-a3b'").replace(/\n/g, '\r\n'))
    writeFileSync(join(dir, 'team', 'nested.md'), '\uFEFF' + agent('nested', 'gemma-4-26b').replace('---\n', '--- \n'))
    // reachable: every form the CLI resolves to Claude
    const claude = [
      'claude-opus-5-5',
      '"sonnet"',
      'fable',
      'Opus',
      'opus[1m]',
      'haiku # fast',
      'best',
      'opusplan',
      'Inherit'
    ]
    claude.forEach((m, i) => writeFileSync(join(dir, `claude-${i}.md`), agent(`claude-${i}`, m)))
    writeFileSync(join(dir, 'default.md'), agent('default'))
    writeFileSync(join(dir, 'empty.md'), agent('empty', '')) // must not read the next line as the model
    // never loaded by the CLI
    writeFileSync(join(dir, 'unnamed.md'), '---\nmodel: qwen3.8-27b\ndescription: d\n---\n')
    writeFileSync(join(dir, 'undescribed.md'), '---\nname: u\nmodel: qwen3.8-27b\n---\n')
    writeFileSync(join(dir, 'notes.txt'), agent('notes', 'qwen3.8-27b'))
    writeFileSync(join(dir, 'body-only.md'), '# no frontmatter\nmodel: qwen3.8-27b\n')

    const found = findUnreachableAgentModels(cwd).sort((a, b) => a.name.localeCompare(b.name))
    expect(found).toEqual([
      { file: join(dir, 'crlf.md'), name: 'crlf', model: 'qwen3.6-35b-a3b' },
      { file: join(dir, 'local.md'), name: 'local', model: 'qwen3.8-27b' },
      { file: join(dir, 'team', 'nested.md'), name: 'nested', model: 'gemma-4-26b' }
    ])
  })

  it('finds nothing when the agents directory is missing', () => {
    expect(findUnreachableAgentModels(cwd)).toEqual([])
  })
})
