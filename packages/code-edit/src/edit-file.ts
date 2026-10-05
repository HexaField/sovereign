// Runs an edit against a real file: path guards, read, the pure engine,
// compare-and-swap, atomic write, and what the codegraph index knows about
// the change (callers of a changed signature, affected tests).

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { applyOps, type EditOutcome, type SignatureChange } from './apply.js'
import { unifiedDiff } from './unified-diff.js'
import { normaliseSource, restoreSource } from './text.js'
import { EditError, type Analyzer, type EditArgs, type EditFilesArgs, type EditOp } from './types.js'
import { createAnalyzer } from './analyzer.js'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

const MAX_BYTES = 1024 * 1024
const DENIED_DIRS = new Set(['.git', 'node_modules'])
const SECRET_FILE = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i
const NOT_SECRET = /^\.env\.(?:example|sample|template)$/i
const CALLER_CAP = 15
const TEST_CAP = 8

export interface EditFileOptions {
  analyzer?: Analyzer
  /** Directories edits may touch. Default: the user's home directory. */
  roots?: string[]
  /** Look up callers and affected tests in the codegraph index. Default true. */
  graph?: boolean
}

export interface EditFileResult {
  /** The real path edited. */
  path: string
  written: boolean
  report: string
}

export interface EditFilesResult {
  /** The real paths written; empty for a dry run. */
  written: string[]
  report: string
}

let sharedAnalyzer: Analyzer | undefined

export async function editFile(args: EditArgs, opts: EditFileOptions = {}): Promise<EditFileResult> {
  const plan = await planEdit(args.file, args.ops, opts)
  if (plan.next !== undefined && !args.dryRun) commit(plan)
  return result(plan, !!args.dryRun)
}

/**
 * Several files in one call, all or nothing: every file is read and edited in
 * memory first, so one failing op writes nothing anywhere; if a write fails
 * partway, the files already written get their old bytes back.
 */
export async function editFiles(args: EditFilesArgs, opts: EditFileOptions = {}): Promise<EditFilesResult> {
  if (args.edits.length === 0) throw new EditError('No edits given.')
  const seen = new Set<string>()
  for (const { file } of args.edits) {
    if (!path.isAbsolute(file)) throw new EditError(`file must be an absolute path: ${file}`)
    const target = realTarget(file)
    if (seen.has(target)) throw new EditError(`${file} appears twice; give each file once, with all its ops.`)
    seen.add(target)
  }
  const plans: Plan[] = []
  for (const edit of args.edits) {
    try {
      plans.push(await planEdit(edit.file, edit.ops, opts))
    } catch (err) {
      throw err instanceof EditError ? new EditError(`${edit.file}: ${err.message}`) : err
    }
  }
  const changed = plans.filter((p) => p.next !== undefined)
  if (!args.dryRun) {
    for (const plan of changed) unchangedOnDisk(plan)
    const done: Plan[] = []
    for (const plan of changed) {
      try {
        commit(plan)
        done.push(plan)
      } catch (err) {
        const unrestored = [plan, ...done.reverse()].flatMap((p) => {
          try {
            restore(p)
            return []
          } catch {
            return [p.label]
          }
        })
        const restored = done.length - unrestored.filter((l) => l !== plan.label).length
        throw new EditError(
          `writing ${plan.label} failed (${(err as Error).message})` +
            (restored ? `; restored the ${restored} file${restored === 1 ? '' : 's'} already written` : '') +
            (unrestored.length ? `; could not restore ${unrestored.join(', ')}` : '') +
            '.'
        )
      }
    }
  }
  const results = await Promise.all(plans.map((plan) => result(plan, !!args.dryRun)))
  const unchanged = plans.length - changed.length
  const head = `${args.dryRun ? 'Dry run of' : 'Edited'} ${changed.length} of ${plans.length} files${unchanged ? ` (${unchanged} unchanged)` : ''}.`
  return {
    written: args.dryRun ? [] : changed.map((p) => p.target),
    report: [head, ...results.map((r) => r.report)].join('\n\n')
  }
}

/** Everything an edit needs before writing: the file as read and the text it becomes. */
interface Plan {
  target: string
  label: string
  exists: boolean
  bytes: Buffer
  source: ReturnType<typeof normaliseSource>
  outcome: EditOutcome
  /** The bytes to write; undefined when the ops leave the text unchanged. */
  next?: string
  root?: string
  changes: string[]
  /** Set once a create has put the file in place; the first directory it made. Both go on rollback. */
  created?: boolean
  createdDir?: string
}

async function planEdit(file: string, ops: EditOp[], opts: EditFileOptions): Promise<Plan> {
  if (!path.isAbsolute(file)) throw new EditError(`file must be an absolute path: ${file}`)
  const analyzer = opts.analyzer ?? (sharedAnalyzer ??= createAnalyzer())
  const target = realTarget(file)
  guard(target, opts.roots ?? [os.homedir()])

  const exists = fs.existsSync(target)
  const bytes = exists ? readBytes(target) : Buffer.alloc(0)
  const source = normaliseSource(decodeUtf8(bytes, target))
  const label = projectRelative(target)
  await analyzer.prepare?.(target)
  const outcome = applyOps(target, source.text, ops, analyzer, { label, exists })
  if (outcome.text === source.text) return { target, label, exists, bytes, source, outcome, changes: [] }

  const root = opts.graph === false ? undefined : codegraphRoot(target)
  const changes = await changeReport(root, target, outcome.signatureChanges)
  return { target, label, exists, bytes, source, outcome, next: restoreSource(outcome.text, source), root, changes }
}

/** Write a plan's new text, unless the file changed on disk since it was read. */
function commit(plan: Plan): void {
  if (plan.exists) {
    unchangedOnDisk(plan)
    writeAtomic(plan.target, plan.next!)
    return
  }
  plan.createdDir = fs.mkdirSync(path.dirname(plan.target), { recursive: true })
  // Written beside the target, then linked into place: never a partial file,
  // and the link fails if something else created the target meanwhile.
  const tmp = tempBeside(plan.target)
  try {
    fs.writeFileSync(tmp, plan.next!, { flag: 'wx' })
    try {
      fs.linkSync(tmp, plan.target)
    } catch (err) {
      // A filesystem without hard links: an exclusive copy still refuses an existing target.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw err
      fs.copyFileSync(tmp, plan.target, fs.constants.COPYFILE_EXCL)
    }
    plan.created = true
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

function unchangedOnDisk(plan: Plan): void {
  const changed = plan.exists
    ? !fs.existsSync(plan.target) || !fs.readFileSync(plan.target).equals(plan.bytes)
    : fs.existsSync(plan.target)
  if (changed) throw new EditError(`${plan.label} changed on disk during the edit; retry.`)
}

/** Undo a commit, whole or partial: the old bytes back, or the created file and its new directories removed. */
function restore(plan: Plan): void {
  if (plan.exists) {
    if (!fs.readFileSync(plan.target).equals(plan.bytes)) writeAtomic(plan.target, plan.bytes)
    return
  }
  if (plan.created) fs.rmSync(plan.target, { force: true })
  if (plan.createdDir) fs.rmSync(plan.createdDir, { recursive: true, force: true })
}

async function result(plan: Plan, dryRun: boolean): Promise<EditFileResult> {
  if (plan.next === undefined) {
    return {
      path: plan.target,
      written: false,
      report: `No change to ${plan.label}: the ops leave the text as it was. Nothing written.`
    }
  }
  const tests = plan.root && !dryRun ? await affectedTests(plan.root, plan.target) : []
  const lines = [
    `${dryRun ? 'Dry run, nothing written:' : plan.exists ? 'Edited' : 'Created'} ${plan.label}`,
    ...plan.outcome.notes,
    ...(plan.outcome.syntaxChecked ? ['syntax ok'] : []),
    ...plan.changes,
    ...(tests.length ? [`affected tests: ${tests.join(', ')}`] : []),
    ...(!dryRun && plan.exists ? ['Read the file again before using the built-in Edit on it.'] : []),
    '',
    unifiedDiff(plan.source.text, plan.outcome.text)
  ]
  return { path: plan.target, written: !dryRun, report: lines.join('\n') }
}

/** The path to write: a symlink's target, or for a new file, the real parent plus the new name. */
function realTarget(file: string): string {
  const resolved = path.resolve(file)
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved)
  const missing: string[] = []
  let dir = resolved
  while (!fs.existsSync(dir)) {
    missing.unshift(path.basename(dir))
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return path.join(fs.realpathSync(dir), ...missing)
}

function guard(target: string, roots: string[]): void {
  const realRoots = roots.map((r) => (fs.existsSync(r) ? fs.realpathSync(r) : path.resolve(r)))
  const inside = (root: string) => {
    const rel = path.relative(root, target)
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  }
  if (!realRoots.some(inside)) {
    throw new EditError(`${target} is outside the allowed roots (${realRoots.join(', ')}).`)
  }
  const segments = target.split(path.sep)
  if (segments.some((s) => DENIED_DIRS.has(s)))
    throw new EditError(`Refusing to edit inside .git or node_modules: ${target}`)
  const base = path.basename(target)
  if (SECRET_FILE.test(base) && !NOT_SECRET.test(base))
    throw new EditError(`Refusing to edit a secrets or key file: ${base}`)
}

function readBytes(file: string): Buffer {
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new EditError(`Not a regular file: ${file}`)
  if (stat.size > MAX_BYTES) throw new EditError(`${file} is ${stat.size} bytes; the limit is ${MAX_BYTES}.`)
  const bytes = fs.readFileSync(file)
  if (bytes.includes(0)) throw new EditError(`${file} looks binary.`)
  return bytes
}

/** Strict: a lenient decode turns every invalid byte into U+FFFD, and the write would keep that. */
function decodeUtf8(bytes: Buffer, file: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new EditError(`${file} is not UTF-8 text; edit it another way.`)
  }
}

/** Temp file in the same directory, created with the target's mode, renamed over the target. */
function writeAtomic(file: string, content: string | Buffer): void {
  const mode = fs.statSync(file).mode & 0o7777
  const tmp = tempBeside(file)
  try {
    fs.writeFileSync(tmp, content, { mode, flag: 'wx' })
    fs.chmodSync(tmp, mode) // the umask may have narrowed the mode at creation
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/** A fresh temp file name in the same directory as `file`, so a rename or link stays on one filesystem. */
function tempBeside(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`)
}

/** Path relative to the enclosing git checkout, else the base name. */
function projectRelative(file: string): string {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.relative(dir, file)
    if (path.dirname(dir) === dir) return path.basename(file)
  }
}

// ── codegraph index lookups (best effort) ────────────────────────────────────

interface CodeGraphLike {
  getNodesInFile(filePath: string): Array<{ id: string; qualifiedName: string }>
  getCallers(
    nodeId: string,
    maxDepth?: number
  ): Array<{ node: { filePath: string; startLine: number }; edge: { line?: number } }>
  close(): void
}

function codegraphRoot(file: string): string | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.codegraph', 'codegraph.db'))) return dir
    if (path.dirname(dir) === dir) return undefined
  }
}

/**
 * One line per changed signature or name, plus its callers from the index,
 * read before the write while the index still describes the old code. The
 * index is optional: when it cannot answer, the changes go without callers.
 */
async function changeReport(root: string | undefined, file: string, changes: SignatureChange[]): Promise<string[]> {
  if (changes.length === 0) return []
  let cg: CodeGraphLike | undefined
  let inFile: Array<{ id: string; qualifiedName: string }> = []
  try {
    if (root) {
      const { CodeGraph } = require('@colbymchenry/codegraph') as {
        CodeGraph: { open(root: string, opts: { readOnly: boolean; sync: boolean }): Promise<CodeGraphLike> }
      }
      cg = await CodeGraph.open(root, { readOnly: true, sync: false })
      inFile = cg.getNodesInFile(path.relative(root, file))
    }
  } catch {
    // Report the changes without callers.
  }
  const callers = (qualifiedName: string): string[] => {
    const node = inFile.find((n) => n.qualifiedName === qualifiedName)
    if (!cg || !node) return []
    try {
      return [...new Set(cg.getCallers(node.id, 1).map((c) => `${c.node.filePath}:${c.edge.line ?? c.node.startLine}`))]
    } catch {
      return []
    }
  }
  try {
    return changes.flatMap((change) => {
      const sites = callers(change.qualifiedName)
      const more = sites.length > CALLER_CAP ? `, … ${sites.length - CALLER_CAP} more` : ''
      return [
        change.renamedTo
          ? `renamed ${change.qualifiedName} → ${change.renamedTo}`
          : `signature changed: ${change.qualifiedName} ${change.before ?? '?'} → ${change.after ?? '?'}`,
        ...(sites.length ? [`  callers to check: ${sites.slice(0, CALLER_CAP).join(', ')}${more}`] : [])
      ]
    })
  } finally {
    cg?.close()
  }
}

/**
 * Tests that import the file directly, else those one step further out.
 * codegraph's default depth (5) lists every test that reaches the file at
 * all: 60 for a core module, with its own test pushed out of view.
 */
async function affectedTests(root: string, file: string): Promise<string[]> {
  for (const depth of ['1', '2']) {
    try {
      const { stdout } = await execFileAsync(
        'codegraph',
        ['affected', path.relative(root, file), '-p', root, '--depth', depth, '--quiet'],
        { timeout: 5_000 }
      )
      const tests = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      if (tests.length > TEST_CAP) return [...tests.slice(0, TEST_CAP), `… ${tests.length - TEST_CAP} more`]
      if (tests.length) return tests
    } catch {
      return []
    }
  }
  return []
}
