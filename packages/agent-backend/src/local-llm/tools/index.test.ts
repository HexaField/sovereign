import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createToolExecutor, type ToolExecutorConfig } from './index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-tools-')))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeExecutor(overrides: Partial<ToolExecutorConfig> = {}) {
  return createToolExecutor({
    allowedCwds: [tmpDir],
    bashTimeout: 5000,
    filesRead: new Set<string>(),
    cwd: tmpDir,
    ...overrides
  })
}

describe('local-llm tools: Read', () => {
  it('numbers lines like cat -n', async () => {
    const file = path.join(tmpDir, 'a.txt')
    fs.writeFileSync(file, 'one\ntwo\nthree')
    const { execute } = makeExecutor()
    const result = await execute('Read', { file_path: file })
    expect(result.error).toBeUndefined()
    expect(result.content).toBe('     1\tone\n     2\ttwo\n     3\tthree')
  })

  it('supports offset/limit paging', async () => {
    const file = path.join(tmpDir, 'b.txt')
    fs.writeFileSync(file, ['a', 'b', 'c', 'd', 'e'].join('\n'))
    const { execute } = makeExecutor()
    const result = await execute('Read', { file_path: file, offset: 1, limit: 2 })
    expect(result.content).toContain('     2\tb')
    expect(result.content).toContain('     3\tc')
    expect(result.content).not.toContain('\ta')
    expect(result.content).toContain('showing 2-3')
  })

  it('errors on a missing file', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Read', { file_path: path.join(tmpDir, 'nope.txt') })
    expect(result.error).toMatch(/not found/)
  })

  it('errors when file_path is a directory', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Read', { file_path: tmpDir })
    expect(result.error).toMatch(/directory/)
  })

  it('truncates lines longer than 2000 chars', async () => {
    const file = path.join(tmpDir, 'long.txt')
    fs.writeFileSync(file, 'x'.repeat(3000))
    const { execute } = makeExecutor()
    const result = await execute('Read', { file_path: file })
    expect(result.content).toContain('[line truncated]')
    expect(result.content.length).toBeLessThan(2100)
  })

  it('rejects paths outside the sandbox', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'x.txt'), 'hi')
      const { execute } = makeExecutor()
      const result = await execute('Read', { file_path: path.join(outside, 'x.txt') })
      expect(result.error).toMatch(/sandbox/)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('allows any path when allowedCwds is empty', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'x.txt'), 'hi')
      const { execute } = makeExecutor({ allowedCwds: [] })
      const result = await execute('Read', { file_path: path.join(outside, 'x.txt') })
      expect(result.error).toBeUndefined()
      expect(result.content).toContain('hi')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('local-llm tools: Write', () => {
  it('creates a new file and parent directories', async () => {
    const file = path.join(tmpDir, 'nested', 'dir', 'out.txt')
    const { execute } = makeExecutor()
    const result = await execute('Write', { file_path: file, content: 'hello' })
    expect(result.error).toBeUndefined()
    expect(fs.readFileSync(file, 'utf-8')).toBe('hello')
  })

  it('refuses to overwrite a file that has not been read', async () => {
    const file = path.join(tmpDir, 'existing.txt')
    fs.writeFileSync(file, 'original')
    const { execute } = makeExecutor()
    const result = await execute('Write', { file_path: file, content: 'new' })
    expect(result.error).toMatch(/has not been read/)
    expect(fs.readFileSync(file, 'utf-8')).toBe('original')
  })

  it('allows overwrite after the file has been read', async () => {
    const file = path.join(tmpDir, 'existing2.txt')
    fs.writeFileSync(file, 'original')
    const filesRead = new Set<string>()
    const { execute } = makeExecutor({ filesRead })
    await execute('Read', { file_path: file })
    const result = await execute('Write', { file_path: file, content: 'new' })
    expect(result.error).toBeUndefined()
    expect(fs.readFileSync(file, 'utf-8')).toBe('new')
  })

  it('requires content', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Write', { file_path: path.join(tmpDir, 'x.txt') })
    expect(result.error).toMatch(/content is required/)
  })
})

describe('local-llm tools: Edit', () => {
  it('requires the file to have been read first', async () => {
    const file = path.join(tmpDir, 'e1.txt')
    fs.writeFileSync(file, 'foo bar')
    const { execute } = makeExecutor()
    const result = await execute('Edit', { file_path: file, old_string: 'foo', new_string: 'baz' })
    expect(result.error).toMatch(/has not been read/)
  })

  it('replaces a unique match', async () => {
    const file = path.join(tmpDir, 'e2.txt')
    fs.writeFileSync(file, 'foo bar')
    const filesRead = new Set<string>()
    const { execute } = makeExecutor({ filesRead })
    await execute('Read', { file_path: file })
    const result = await execute('Edit', { file_path: file, old_string: 'foo', new_string: 'baz' })
    expect(result.error).toBeUndefined()
    expect(fs.readFileSync(file, 'utf-8')).toBe('baz bar')
  })

  it('errors when old_string appears more than once and replace_all is not set', async () => {
    const file = path.join(tmpDir, 'e3.txt')
    fs.writeFileSync(file, 'foo foo foo')
    const filesRead = new Set<string>()
    const { execute } = makeExecutor({ filesRead })
    await execute('Read', { file_path: file })
    const result = await execute('Edit', { file_path: file, old_string: 'foo', new_string: 'baz' })
    expect(result.error).toMatch(/found 3 times/)
  })

  it('replace_all replaces every occurrence', async () => {
    const file = path.join(tmpDir, 'e4.txt')
    fs.writeFileSync(file, 'foo foo foo')
    const filesRead = new Set<string>()
    const { execute } = makeExecutor({ filesRead })
    await execute('Read', { file_path: file })
    const result = await execute('Edit', { file_path: file, old_string: 'foo', new_string: 'baz', replace_all: true })
    expect(result.error).toBeUndefined()
    expect(fs.readFileSync(file, 'utf-8')).toBe('baz baz baz')
  })

  it('errors when old_string is not found', async () => {
    const file = path.join(tmpDir, 'e5.txt')
    fs.writeFileSync(file, 'foo bar')
    const filesRead = new Set<string>()
    const { execute } = makeExecutor({ filesRead })
    await execute('Read', { file_path: file })
    const result = await execute('Edit', { file_path: file, old_string: 'nope', new_string: 'baz' })
    expect(result.error).toMatch(/not found/)
  })

  it('errors when old_string and new_string are identical', async () => {
    const file = path.join(tmpDir, 'e6.txt')
    fs.writeFileSync(file, 'foo bar')
    const filesRead = new Set<string>()
    const { execute } = makeExecutor({ filesRead })
    await execute('Read', { file_path: file })
    const result = await execute('Edit', { file_path: file, old_string: 'foo', new_string: 'foo' })
    expect(result.error).toMatch(/must differ/)
  })
})

describe('local-llm tools: Bash', () => {
  it('captures stdout', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Bash', { command: 'echo hello-world' })
    expect(result.error).toBeUndefined()
    expect(result.content).toContain('hello-world')
  })

  it('reports a non-zero exit code as an error', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Bash', { command: 'exit 3' })
    expect(result.error).toMatch(/exited with code 3/)
  })

  it('kills commands that exceed the timeout', async () => {
    const { execute } = makeExecutor({ bashTimeout: 200 })
    const result = await execute('Bash', { command: 'sleep 5' })
    expect(result.error).toMatch(/timed out/)
  }, 10_000)

  it('runs in the requested cwd', async () => {
    const sub = path.join(tmpDir, 'subdir')
    fs.mkdirSync(sub)
    const { execute } = makeExecutor()
    const result = await execute('Bash', { command: 'pwd', cwd: sub })
    expect(result.content.trim()).toBe(fs.realpathSync(sub))
  })

  it('rejects a cwd outside the sandbox', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-outside-'))
    try {
      const { execute } = makeExecutor()
      const result = await execute('Bash', { command: 'pwd', cwd: outside })
      expect(result.error).toMatch(/sandbox/)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('requires a command', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Bash', {})
    expect(result.error).toMatch(/command is required/)
  })
})

describe('local-llm tools: Grep', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmpDir, 'one.ts'), 'export function foo() {}\nexport const bar = 1\n')
    fs.writeFileSync(path.join(tmpDir, 'two.ts'), 'export function baz() {}\n')
    fs.mkdirSync(path.join(tmpDir, 'sub'))
    fs.writeFileSync(path.join(tmpDir, 'sub', 'three.ts'), 'export function foo() { return 2 }\n')
  })

  it('files_with_matches mode returns matching file paths', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Grep', { pattern: 'function foo', path: tmpDir })
    expect(result.error).toBeUndefined()
    expect(result.content).toContain('one.ts')
    expect(result.content).toContain(path.join('sub', 'three.ts'))
    expect(result.content).not.toContain('two.ts')
  })

  it('content mode includes line numbers', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Grep', { pattern: 'export const bar', path: tmpDir, output_mode: 'content' })
    expect(result.content).toMatch(/one\.ts:2:export const bar/)
  })

  it('is not an error when there are no matches', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Grep', { pattern: 'zzz_nonexistent_zzz', path: tmpDir })
    expect(result.error).toBeUndefined()
    expect(result.content).toBe('No matches found')
  })

  it('-i makes the search case-insensitive', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Grep', { pattern: 'FUNCTION FOO', path: tmpDir, '-i': true })
    expect(result.content).toContain('one.ts')
  })
})

describe('local-llm tools: Glob', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '')
    fs.writeFileSync(path.join(tmpDir, 'b.js'), '')
    fs.mkdirSync(path.join(tmpDir, 'src'))
    fs.writeFileSync(path.join(tmpDir, 'src', 'c.ts'), '')
    fs.mkdirSync(path.join(tmpDir, 'src', 'nested'))
    fs.writeFileSync(path.join(tmpDir, 'src', 'nested', 'd.ts'), '')
  })

  it('matches a simple extension glob non-recursively when no ** is used', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Glob', { pattern: '*.ts', path: tmpDir })
    expect(result.content).toContain('a.ts')
    expect(result.content).not.toContain('c.ts')
  })

  it('** matches across directories', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Glob', { pattern: '**/*.ts', path: tmpDir })
    expect(result.content).toContain('a.ts')
    expect(result.content).toContain(path.join('src', 'c.ts'))
    expect(result.content).toContain(path.join('src', 'nested', 'd.ts'))
    expect(result.content).not.toContain('b.js')
  })

  it('scoped glob matches only within the given subdirectory', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Glob', { pattern: 'src/**/*.ts', path: tmpDir })
    expect(result.content).toContain(path.join('src', 'c.ts'))
    expect(result.content).not.toMatch(/(^|\/)a\.ts/)
  })

  it('sorts results by modification time, most recent first', async () => {
    const { execute } = makeExecutor()
    const older = path.join(tmpDir, 'older.ts')
    const newer = path.join(tmpDir, 'newer.ts')
    fs.writeFileSync(older, '')
    fs.utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    fs.writeFileSync(newer, '')
    const result = await execute('Glob', { pattern: '*.ts', path: tmpDir })
    const lines = result.content.split('\n')
    expect(lines.indexOf(newer)).toBeLessThan(lines.indexOf(older))
  })

  it('returns a friendly message when nothing matches', async () => {
    const { execute } = makeExecutor()
    const result = await execute('Glob', { pattern: '*.nonexistent', path: tmpDir })
    expect(result.content).toBe('No files matched')
  })
})

describe('local-llm tools: LS', () => {
  it('lists files and directories with type markers', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hi')
    fs.mkdirSync(path.join(tmpDir, 'folder'))
    const { execute } = makeExecutor()
    const result = await execute('LS', { path: tmpDir })
    expect(result.content).toMatch(/file\s+.*file\.txt/)
    expect(result.content).toMatch(/dir\s+.*folder\//)
  })

  it('respects ignore glob patterns', async () => {
    fs.writeFileSync(path.join(tmpDir, 'keep.txt'), '')
    fs.writeFileSync(path.join(tmpDir, 'skip.log'), '')
    const { execute } = makeExecutor()
    const result = await execute('LS', { path: tmpDir, ignore: ['*.log'] })
    expect(result.content).toContain('keep.txt')
    expect(result.content).not.toContain('skip.log')
  })

  it('defaults to the session cwd when no path is given', async () => {
    fs.writeFileSync(path.join(tmpDir, 'only.txt'), '')
    const { execute } = makeExecutor()
    const result = await execute('LS', {})
    expect(result.content).toContain('only.txt')
  })

  it('errors on a non-directory path', async () => {
    const file = path.join(tmpDir, 'f.txt')
    fs.writeFileSync(file, '')
    const { execute } = makeExecutor()
    const result = await execute('LS', { path: file })
    expect(result.error).toMatch(/Not a directory/)
  })
})

describe('local-llm tools: unknown tool', () => {
  it('returns an error instead of throwing', async () => {
    const { execute } = makeExecutor()
    const result = await execute('DoesNotExist', {})
    expect(result.error).toMatch(/Unknown tool/)
  })
})
