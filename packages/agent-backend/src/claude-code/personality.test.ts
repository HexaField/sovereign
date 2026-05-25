import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDefaultSubagentFile, ensureLayeredContextFile, ensurePersonalityFile } from './personality.js'

describe('claude-code/personality', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sov-cc-pers-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('writes CLAUDE.md if missing, leaves user file alone if present', () => {
    ensurePersonalityFile(cwd)
    const path = join(cwd, 'CLAUDE.md')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toMatch(/Sovereign Agent/)

    writeFileSync(path, '# user override\n')
    ensurePersonalityFile(cwd)
    expect(readFileSync(path, 'utf-8')).toBe('# user override\n')
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
})
