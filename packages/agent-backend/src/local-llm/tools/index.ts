// Built-in tool executor — implements the 7 core tools the local-llm backend
// provides natively (Read, Write, Edit, Bash, Grep, Glob, LS). Every tool is
// a real, working implementation against the local filesystem/shell; none of
// them are stubs.
//
// All filesystem/shell-touching tools are constrained to `config.allowedCwds`
// (the "sandbox" from local-llm's config) when that list is non-empty. Paths
// are resolved through symlinks (`fs.realpathSync`) before the containment
// check so a symlink can't be used to escape the sandbox.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { Dirent } from 'node:fs'

export interface ToolResult {
  content: string
  error?: string
}

export interface ToolExecutorConfig {
  /** Directories tool calls may touch. Empty array = no restriction. */
  allowedCwds: string[]
  /** Maximum ms a Bash/Grep command may run before being killed. */
  bashTimeout: number
  /** Track files read this session — Write/Edit refuse to touch unread files. */
  filesRead: Set<string>
  /** Default working directory for Bash/Grep/Glob/LS when the tool call omits one. */
  cwd: string
}

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_CHARS = 2000
const MAX_BASH_OUTPUT_CHARS = 30_000
const GREP_DEFAULT_HEAD_LIMIT = 250
const GLOB_MAX_RESULTS = 500
const LS_SKIP_DIRS = new Set(['.git', 'node_modules'])

export function createToolExecutor(config: ToolExecutorConfig) {
  const { filesRead } = config

  // Resolve the sandbox roots through symlinks once up front — cheap, and
  // means every per-call containment check is a plain string comparison.
  const allowedRoots = config.allowedCwds.map((dir) => realpathBestEffort(path.resolve(dir)))

  async function execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (toolName) {
        case 'Read':
          return await executeRead(input)
        case 'Write':
          return await executeWrite(input)
        case 'Edit':
          return await executeEdit(input)
        case 'Bash':
          return await executeBash(input)
        case 'Grep':
          return await executeGrep(input)
        case 'Glob':
          return await executeGlob(input)
        case 'LS':
          return await executeLS(input)
        default:
          return { content: '', error: `Unknown tool: ${toolName}` }
      }
    } catch (err) {
      // Belt-and-braces — no individual tool implementation should throw
      // (they all catch their own fs/process errors), but a tool call must
      // never take down the whole tool loop.
      return { content: '', error: `Tool ${toolName} failed: ${(err as Error).message ?? String(err)}` }
    }
  }

  // ── Path sandboxing ─────────────────────────────────────────────────

  /** Resolve symlinks for a path that may not exist yet — walks up to the
   *  nearest existing ancestor, realpaths that, then re-appends the tail. */
  function realpathBestEffort(absPath: string): string {
    try {
      return fs.realpathSync(absPath)
    } catch {
      let dir = path.dirname(absPath)
      const tail: string[] = [path.basename(absPath)]
      while (dir !== path.dirname(dir)) {
        try {
          const realDir = fs.realpathSync(dir)
          return path.join(realDir, ...tail.reverse())
        } catch {
          tail.push(path.basename(dir))
          dir = path.dirname(dir)
        }
      }
      return absPath
    }
  }

  /** Returns an error string if `target` falls outside every allowed root, else null. */
  function checkAllowedPath(target: string): string | null {
    if (allowedRoots.length === 0) return null
    const resolved = realpathBestEffort(path.resolve(target))
    const ok = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
    if (ok) return null
    return `Path outside allowed sandbox directories: ${resolved}. Allowed: ${allowedRoots.join(', ')}`
  }

  // ── Read ─────────────────────────────────────────────────────────────

  async function executeRead(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = typeof input.file_path === 'string' ? input.file_path.trim() : ''
    if (!filePath) return { content: '', error: 'file_path is required' }
    const resolved = path.resolve(filePath)
    const pathError = checkAllowedPath(resolved)
    if (pathError) return { content: '', error: pathError }
    if (!fs.existsSync(resolved)) return { content: '', error: `File not found: ${resolved}` }
    const stat = await fsp.stat(resolved)
    if (stat.isDirectory()) return { content: '', error: `Path is a directory, not a file: ${resolved}` }

    let raw: string
    try {
      raw = await fsp.readFile(resolved, 'utf-8')
    } catch (err) {
      return { content: '', error: `Failed to read file: ${(err as Error).message}` }
    }

    const lines = raw.split('\n')
    const offset = Number.isInteger(input.offset) && (input.offset as number) >= 0 ? (input.offset as number) : 0
    const limit =
      Number.isInteger(input.limit) && (input.limit as number) > 0 ? (input.limit as number) : DEFAULT_READ_LIMIT
    const slice = lines.slice(offset, offset + limit)

    filesRead.add(resolved)

    if (slice.length === 0) {
      return {
        content: offset > 0 ? `(no lines at offset ${offset} — file has ${lines.length} lines)` : '(empty file)'
      }
    }

    const numbered = slice.map((line, i) => {
      const lineNo = offset + i + 1
      const truncated = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line
      return `${String(lineNo).padStart(6, ' ')}\t${truncated}`
    })
    const hasMore = offset + slice.length < lines.length
    const body = numbered.join('\n')
    return {
      content: hasMore
        ? `${body}\n\n[File has ${lines.length} lines total; showing ${offset + 1}-${offset + slice.length}. Pass a larger offset to continue.]`
        : body
    }
  }

  // ── Write ────────────────────────────────────────────────────────────

  async function executeWrite(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = typeof input.file_path === 'string' ? input.file_path.trim() : ''
    const content = typeof input.content === 'string' ? input.content : undefined
    if (!filePath) return { content: '', error: 'file_path is required' }
    if (content === undefined) return { content: '', error: 'content is required' }
    const resolved = path.resolve(filePath)
    const pathError = checkAllowedPath(resolved)
    if (pathError) return { content: '', error: pathError }

    if (fs.existsSync(resolved)) {
      const stat = await fsp.stat(resolved)
      if (stat.isDirectory()) return { content: '', error: `Path is a directory, not a file: ${resolved}` }
      if (!filesRead.has(resolved)) {
        return {
          content: '',
          error: `File exists and has not been read yet: ${resolved}. Read it first, then Write to overwrite it.`
        }
      }
    }

    try {
      await fsp.mkdir(path.dirname(resolved), { recursive: true })
      await fsp.writeFile(resolved, content, 'utf-8')
    } catch (err) {
      return { content: '', error: `Failed to write file: ${(err as Error).message}` }
    }
    filesRead.add(resolved)
    return { content: `File written: ${resolved} (${Buffer.byteLength(content, 'utf-8')} bytes)` }
  }

  // ── Edit ─────────────────────────────────────────────────────────────

  async function executeEdit(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = typeof input.file_path === 'string' ? input.file_path.trim() : ''
    const oldString = typeof input.old_string === 'string' ? input.old_string : undefined
    const newString = typeof input.new_string === 'string' ? input.new_string : undefined
    const replaceAll = input.replace_all === true

    if (!filePath) return { content: '', error: 'file_path is required' }
    if (oldString === undefined) return { content: '', error: 'old_string is required' }
    if (newString === undefined) return { content: '', error: 'new_string is required' }
    if (oldString === newString) return { content: '', error: 'old_string and new_string must differ' }
    if (oldString === '') return { content: '', error: 'old_string must not be empty — use Write for new files' }

    const resolved = path.resolve(filePath)
    const pathError = checkAllowedPath(resolved)
    if (pathError) return { content: '', error: pathError }
    if (!fs.existsSync(resolved)) return { content: '', error: `File not found: ${resolved}` }
    if (!filesRead.has(resolved)) {
      return { content: '', error: `File has not been read yet: ${resolved}. Read it before editing.` }
    }

    let raw: string
    try {
      raw = await fsp.readFile(resolved, 'utf-8')
    } catch (err) {
      return { content: '', error: `Failed to read file: ${(err as Error).message}` }
    }

    const occurrences = countOccurrences(raw, oldString)
    if (occurrences === 0) return { content: '', error: `old_string not found in ${resolved}` }
    if (occurrences > 1 && !replaceAll) {
      return {
        content: '',
        error: `old_string found ${occurrences} times in ${resolved}. Include more context to make it unique, or pass replace_all: true.`
      }
    }

    const updated = replaceAll ? splitJoinReplace(raw, oldString, newString) : replaceOnce(raw, oldString, newString)
    try {
      await fsp.writeFile(resolved, updated, 'utf-8')
    } catch (err) {
      return { content: '', error: `Failed to write file: ${(err as Error).message}` }
    }
    return { content: `Edited ${resolved} (${occurrences} replacement${occurrences === 1 ? '' : 's'})` }
  }

  // ── Bash ─────────────────────────────────────────────────────────────

  async function executeBash(input: Record<string, unknown>): Promise<ToolResult> {
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command.trim()) return { content: '', error: 'command is required' }
    const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? path.resolve(input.cwd) : config.cwd
    const pathError = checkAllowedPath(cwd)
    if (pathError) return { content: '', error: pathError }
    if (!fs.existsSync(cwd)) return { content: '', error: `cwd does not exist: ${cwd}` }

    const requested =
      Number.isInteger(input.timeout) && (input.timeout as number) > 0 ? (input.timeout as number) : undefined
    const timeoutMs = requested ? Math.min(requested, config.bashTimeout) : config.bashTimeout

    const { stdout, stderr, code, timedOut } = await runCommand(command, [], { cwd, timeoutMs, shell: true })
    const combined = combineOutput(stdout, stderr)
    if (timedOut) return { content: combined, error: `Command timed out after ${timeoutMs}ms` }
    if (code !== 0) return { content: combined, error: `Command exited with code ${code}` }
    return { content: combined || '(command produced no output)' }
  }

  // ── Grep ─────────────────────────────────────────────────────────────

  async function executeGrep(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern) return { content: '', error: 'pattern is required' }
    const searchPath = typeof input.path === 'string' && input.path.trim() ? path.resolve(input.path) : config.cwd
    const pathError = checkAllowedPath(searchPath)
    if (pathError) return { content: '', error: pathError }
    if (!fs.existsSync(searchPath)) return { content: '', error: `Path not found: ${searchPath}` }

    const outputMode =
      input.output_mode === 'content' || input.output_mode === 'count' ? input.output_mode : 'files_with_matches'

    const args: string[] = []
    if (outputMode === 'files_with_matches') args.push('--files-with-matches')
    else if (outputMode === 'count') args.push('--count')
    if (input['-i'] === true) args.push('--ignore-case')
    if (outputMode === 'content') {
      if (input['-n'] !== false) args.push('--line-number')
      if (Number.isInteger(input['-C'])) args.push('--context', String(input['-C']))
      if (Number.isInteger(input['-B'])) args.push('--before-context', String(input['-B']))
      if (Number.isInteger(input['-A'])) args.push('--after-context', String(input['-A']))
    }
    if (typeof input.glob === 'string' && input.glob) args.push('--glob', input.glob)
    if (typeof input.type === 'string' && input.type) args.push('--type', input.type)
    if (input.multiline === true) args.push('--multiline', '--multiline-dotall')
    args.push('--color', 'never', '--no-heading', '--', pattern, searchPath)

    const { stdout, stderr, code, timedOut } = await runCommand('rg', args, {
      cwd: config.cwd,
      timeoutMs: config.bashTimeout
    })
    if (timedOut) return { content: '', error: `rg timed out after ${config.bashTimeout}ms` }
    // rg exit codes: 0 = matches found, 1 = no matches (not an error), 2 = real error.
    if (code !== 0 && code !== 1) {
      return { content: '', error: stderr.trim() || `rg exited with code ${code}` }
    }

    let lines = stdout.split('\n').filter((l) => l.length > 0)
    if (lines.length === 0) return { content: 'No matches found' }
    const headLimit =
      Number.isInteger(input.head_limit) && (input.head_limit as number) > 0
        ? (input.head_limit as number)
        : GREP_DEFAULT_HEAD_LIMIT
    const truncated = lines.length > headLimit
    lines = lines.slice(0, headLimit)
    const body = lines.join('\n')
    return { content: truncated ? `${body}\n\n[output truncated to ${headLimit} lines]` : body }
  }

  // ── Glob ─────────────────────────────────────────────────────────────

  async function executeGlob(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern) return { content: '', error: 'pattern is required' }
    const base = typeof input.path === 'string' && input.path.trim() ? path.resolve(input.path) : config.cwd
    const pathError = checkAllowedPath(base)
    if (pathError) return { content: '', error: pathError }
    if (!fs.existsSync(base)) return { content: '', error: `Path not found: ${base}` }

    const regex = globToRegExp(pattern)
    const results: Array<{ file: string; mtimeMs: number }> = []
    await walkDir(base, results)

    const matched = results.filter((r) => regex.test(toPosixRelative(base, r.file)))
    matched.sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (matched.length === 0) return { content: 'No files matched' }

    const truncated = matched.length > GLOB_MAX_RESULTS
    const body = matched
      .slice(0, GLOB_MAX_RESULTS)
      .map((m) => m.file)
      .join('\n')
    return { content: truncated ? `${body}\n\n[truncated to ${GLOB_MAX_RESULTS} of ${matched.length} matches]` : body }
  }

  // ── LS ───────────────────────────────────────────────────────────────

  async function executeLS(input: Record<string, unknown>): Promise<ToolResult> {
    const target = typeof input.path === 'string' && input.path.trim() ? path.resolve(input.path) : config.cwd
    const pathError = checkAllowedPath(target)
    if (pathError) return { content: '', error: pathError }
    if (!fs.existsSync(target)) return { content: '', error: `Path not found: ${target}` }
    const stat = await fsp.stat(target)
    if (!stat.isDirectory()) return { content: '', error: `Not a directory: ${target}` }

    const ignoreGlobs = Array.isArray(input.ignore)
      ? input.ignore.filter((x): x is string => typeof x === 'string')
      : []
    const ignoreRegexes = ignoreGlobs.map(globToRegExp)

    let entries: Dirent[]
    try {
      entries = await fsp.readdir(target, { withFileTypes: true })
    } catch (err) {
      return { content: '', error: `Failed to list directory: ${(err as Error).message}` }
    }

    const rows: string[] = []
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignoreRegexes.some((re) => re.test(entry.name))) continue
      const full = path.join(target, entry.name)
      let kind: string
      let size = 0
      let mtime = ''
      try {
        const st = await fsp.stat(full)
        size = st.size
        mtime = st.mtime.toISOString()
        kind = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file'
      } catch {
        kind = 'unreadable'
      }
      rows.push(`${kind.padEnd(6)} ${String(size).padStart(10)}  ${mtime}  ${entry.name}${kind === 'dir' ? '/' : ''}`)
    }
    if (rows.length === 0) return { content: '(empty directory)' }
    return { content: rows.join('\n') }
  }

  // ── Shared helpers ───────────────────────────────────────────────────

  /** Recursively collect files (not directories) under `dir`, skipping `.git`/`node_modules`. */
  async function walkDir(dir: string, out: Array<{ file: string; mtimeMs: number }>): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return // permission denied / not a directory — skip silently
    }
    for (const entry of entries) {
      if (entry.isDirectory() && LS_SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walkDir(full, out)
      } else {
        try {
          const st = await fsp.stat(full)
          out.push({ file: full, mtimeMs: st.mtimeMs })
        } catch {
          /* broken symlink or race with deletion — skip */
        }
      }
    }
  }

  return { execute }
}

// ── Free functions (no closure state — pure helpers) ─────────────────────

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle)
  if (idx === -1) return haystack
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length)
}

function splitJoinReplace(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement)
}

function combineOutput(stdout: string, stderr: string): string {
  const combined = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout
  if (combined.length <= MAX_BASH_OUTPUT_CHARS) return combined
  return `${combined.slice(0, MAX_BASH_OUTPUT_CHARS)}\n\n[output truncated — ${combined.length - MAX_BASH_OUTPUT_CHARS} more characters]`
}

function toPosixRelative(base: string, file: string): string {
  return path.relative(base, file).split(path.sep).join('/')
}

/** Escape one character for literal inclusion in a RegExp source string. */
function escapeRegExpChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

/**
 * Convert a glob pattern (`*`, `**`, `?`, `{a,b}`, `[abc]`) into a RegExp
 * anchored to a full match. `**` matches across path separators (zero or
 * more segments); a single `*`/`?` never crosses a `/`.
 */
function globToRegExp(glob: string): RegExp {
  let out = ''
  let i = 0
  const n = glob.length
  while (i < n) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*'
      i += 2
      if (glob[i] === '/') i++ // swallow one following slash so '**/*.ts' also matches root files
      continue
    }
    if (c === '*') {
      out += '[^/]*'
      i++
      continue
    }
    if (c === '?') {
      out += '[^/]'
      i++
      continue
    }
    if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) {
        out += '\\{'
        i++
        continue
      }
      const options = glob
        .slice(i + 1, end)
        .split(',')
        .map((opt) => opt.split('').map(escapeRegExpChar).join(''))
      out += `(?:${options.join('|')})`
      i = end + 1
      continue
    }
    if (c === '[') {
      const end = glob.indexOf(']', i)
      if (end === -1) {
        out += '\\['
        i++
        continue
      }
      out += glob.slice(i, end + 1)
      i = end + 1
      continue
    }
    out += escapeRegExpChar(c)
    i++
  }
  return new RegExp(`^${out}$`)
}

// ── Process runner ─────────────────────────────────────────────────────

interface RunCommandResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

/** Spawn `cmd` (argv-style, or shell:true for a raw command string) and collect output with a timeout. */
function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; shell?: boolean }
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, shell: opts.shell ?? false })
    } catch (err) {
      resolve({ stdout: '', stderr: (err as Error).message, code: -1, timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ stdout, stderr, code: null, timedOut: true })
    }, opts.timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8')
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr: stderr || err.message, code: -1, timedOut: false })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut: false })
    })
  })
}
