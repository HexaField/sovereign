// File system viewer for tailnet devices: list a directory, size its
// subdirectories, download a file or a directory (tar.gz).
//
// The local device runs commands directly; others run them over SSH (the
// same BatchMode access the device monitor uses). Every remote command goes
// in as a script on stdin with the path single-quoted, so no path reaches a
// shell unquoted.
//
// Folder sizes come from a `du -x -d 1` job per (device, path). du prints
// each subdirectory as it finishes, so pollers see sizes fill in. A finished
// result stays cached; a du nobody polls for `idleKillMs` is killed.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Writable } from 'node:stream'

export interface FsTarget {
  /** Runs commands directly when true; over SSH otherwise. */
  local: boolean
  sshHost: string
  osHint: 'linux' | 'macos'
}

export interface FsEntry {
  name: string
  type: 'dir' | 'file' | 'link' | 'other'
  /** Apparent size in bytes (files and links); 0 for directories until sized. */
  size: number
  /** Modification time, ms since epoch. */
  mtime: number
}

export interface FsListing {
  path: string
  entries: FsEntry[]
}

export interface DirSizes {
  path: string
  /** Child directory name → bytes on disk, as du reports each one. */
  sizes: Record<string, number>
  /** Bytes on disk of the whole directory, once du finishes. */
  total?: number
  done: boolean
  /** du could not read some entries (permissions): sizes are lower bounds. */
  partial: boolean
  /** du never reported the directory (unreachable device, unreadable path). */
  error?: string
}

export interface DeviceFilesOptions {
  /** Command that runs a script from stdin on a remote host. Tests swap in a local shell. */
  remoteShell?: (sshHost: string) => [string, string[]]
  /** Keep a finished size result this long (ms). */
  sizesTtlMs?: number
  /** Kill a running du nobody has polled for this long (ms). */
  idleKillMs?: number
}

const defaultRemoteShell = (sshHost: string): [string, string[]] => [
  'ssh',
  [sshHost, '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', 'bash', '-s']
]

/** Single-quote a string for a POSIX shell. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** An absolute, normalised path, or an error for anything else. */
export function cleanPath(raw: unknown): string {
  const p = typeof raw === 'string' && raw.length > 0 ? raw : '/'
  if (p.includes('\0') || !p.startsWith('/')) throw new FsError(400, 'path must be absolute')
  const n = path.posix.normalize(p)
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n
}

export class FsError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** RFC 5987 Content-Disposition for a download name. */
export function attachmentHeader(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename*=UTF-8''${encoded}`
}

// Lists one directory as NUL-separated records: type, size, mtime (s), name.
// -H: follow $P itself when it is a symlink to a directory (macOS /tmp, /var).
const LINUX_LIST = `find -H "$P" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0'`
const MACOS_LIST = `find -H "$P" -mindepth 1 -maxdepth 1 -print0 | xargs -0 -r stat -f '%HT%t%z%t%m%t%N' | tr '\\n' '\\0'`

// Download: the kind goes out on stderr as a marker line before any data.
// Login shells and ssh may write to stderr first, so the marker can come on any line.
const MARK = '@@SOVEREIGN-FS@@'
// A directory archives its physical path, so a symlink to a directory gets
// the target's contents (tar alone would archive just the link).
const DOWNLOAD = `if [ -d "$P" ]; then
  [ -r "$P" ] && [ -x "$P" ] || exit 3
  D=$(cd -P "$P" && pwd -P) || exit 3
  [ "$D" = / ] && exit 4
  echo ${MARK}DIR >&2
  cd "\${D%/*}/" && tar -czf - -- "\${D##*/}"
elif [ -f "$P" ]; then
  [ -r "$P" ] || exit 3
  echo ${MARK}FILE >&2
  cat -- "$P"
else exit 2; fi`

/** Exit codes after the stream started that still mean a usable download. */
const okExit = (kind: 'DIR' | 'FILE', code: number | null) =>
  // tar: 1 = a file changed while read, 2 = some files unreadable (GNU).
  code === 0 || (kind === 'DIR' && (code === 1 || code === 2))

export function parseListing(raw: string, dir: string, macos: boolean): FsEntry[] {
  const entries: FsEntry[] = []
  for (const rec of raw.split('\0')) {
    if (!rec) continue
    const [kind, size, mtime, ...rest] = rec.split('\t')
    let name = rest.join('\t')
    if (macos)
      name = name.startsWith(dir === '/' ? '/' : `${dir}/`)
        ? name.slice(dir === '/' ? 1 : dir.length + 1)
        : path.posix.basename(name)
    const type: FsEntry['type'] = macos
      ? kind === 'Directory'
        ? 'dir'
        : kind === 'Regular File'
          ? 'file'
          : kind === 'Symbolic Link'
            ? 'link'
            : 'other'
      : kind === 'd'
        ? 'dir'
        : kind === 'f'
          ? 'file'
          : kind === 'l'
            ? 'link'
            : 'other'
    entries.push({
      name,
      type,
      size: type === 'dir' ? 0 : Number(size) || 0,
      mtime: Math.round(Number(mtime) * 1000) || 0
    })
  }
  return entries
}

interface SizeJob {
  result: DirSizes
  proc?: ChildProcess
  /** Kills an unpolled du, or drops a finished result. */
  timer?: ReturnType<typeof setTimeout>
}

/** How long a failed size job stays visible, so pollers see it end. */
const FAILED_TTL_MS = 10_000

export function createDeviceFiles(options: DeviceFilesOptions = {}) {
  const remoteShell = options.remoteShell ?? defaultRemoteShell
  const sizesTtlMs = options.sizesTtlMs ?? 10 * 60_000
  const idleKillMs = options.idleKillMs ?? 60_000
  const jobs = new Map<string, SizeJob>()

  /** Run a script with $P set to `p`, on the device. */
  function run(target: FsTarget, p: string, script: string): ChildProcess {
    const body = `P=${shQuote(p)}\n${script}\n`
    const child = target.local
      ? spawn('bash', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(...remoteShell(target.sshHost), { stdio: ['pipe', 'pipe', 'pipe'] })
    // A child that exits before reading its script gives EPIPE here; its exit reports the failure.
    child.stdin!.on('error', () => {})
    child.stdin!.end(body)
    return child
  }

  function collect(child: ChildProcess, timeoutMs: number): Promise<{ out: string; err: string; code: number | null }> {
    return new Promise((resolve) => {
      let out = ''
      let err = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.stdout!.on('data', (d) => (out += d))
      child.stderr!.on('data', (d) => (err += d))
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ out, err, code })
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ out, err: err + String(e), code: -1 })
      })
    })
  }

  async function list(target: FsTarget, rawPath: unknown): Promise<FsListing> {
    const p = cleanPath(rawPath)
    if (target.local) {
      let names: fs.Dirent[]
      try {
        names = await fs.promises.readdir(p, { withFileTypes: true })
      } catch (e: any) {
        const status = e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 404 : e?.code === 'EACCES' ? 403 : 400
        throw new FsError(status, `${e?.code ?? 'error'}: ${p}`)
      }
      const entries = await Promise.all(
        names.map(async (d): Promise<FsEntry> => {
          const type: FsEntry['type'] = d.isDirectory()
            ? 'dir'
            : d.isFile()
              ? 'file'
              : d.isSymbolicLink()
                ? 'link'
                : 'other'
          try {
            const st = await fs.promises.lstat(path.posix.join(p, d.name))
            return { name: d.name, type, size: type === 'dir' ? 0 : st.size, mtime: st.mtimeMs }
          } catch {
            return { name: d.name, type, size: 0, mtime: 0 }
          }
        })
      )
      return { path: p, entries }
    }
    const macos = target.osHint === 'macos'
    const script = `[ -d "$P" ] || { echo "not a directory" >&2; exit 2; }\n[ -r "$P" ] || { echo "permission denied" >&2; exit 3; }\n${macos ? MACOS_LIST : LINUX_LIST}`
    const { out, err, code } = await collect(run(target, p, script), 15_000)
    if (code === 2) throw new FsError(404, `not a directory: ${p}`)
    if (code === 3) throw new FsError(403, `permission denied: ${p}`)
    if (code !== 0 && !out) throw new FsError(502, err.trim().split('\n').pop() || 'device unreachable')
    return { path: p, entries: parseListing(out, p, macos) }
  }

  /** Drop the job after `ms`, killing its du if it still runs. */
  function expire(key: string, job: SizeJob, ms: number): void {
    clearTimeout(job.timer)
    job.timer = setTimeout(() => {
      job.proc?.kill('SIGKILL')
      if (jobs.get(key) === job) jobs.delete(key)
    }, ms)
    job.timer.unref?.()
  }

  /** Current sizes of `path`'s subdirectories; starts a du job on first call. */
  function sizes(device: string, target: FsTarget, rawPath: unknown): DirSizes {
    const p = cleanPath(rawPath)
    const key = `${device}\0${p}`
    const existing = jobs.get(key)
    if (existing) {
      if (!existing.result.done) expire(key, existing, idleKillMs)
      return existing.result
    }
    const result: DirSizes = { path: p, sizes: {}, done: false, partial: false }
    const job: SizeJob = { result }
    jobs.set(key, job)
    expire(key, job, idleKillMs)
    // -x: stay on this file system. -H: follow $P if it is a symlink. nice: never compete with real work.
    const proc = run(target, p, `nice -n 19 du -x -H -d 1 -k "$P"`)
    job.proc = proc
    let errText = ''
    let buf = ''
    proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const tab = line.indexOf('\t')
        if (tab < 0) continue
        const bytes = (parseInt(line.slice(0, tab), 10) || 0) * 1024
        const full = line.slice(tab + 1)
        if (full === p) result.total = bytes
        else result.sizes[path.posix.basename(full)] = bytes
      }
    })
    // Only du's own complaints mean missing sizes; ssh warnings do not.
    proc.stderr!.on('data', (d: Buffer) => {
      errText += d.toString()
      if (/^du: /m.test(errText)) result.partial = true
    })
    const finish = () => {
      if (result.done) return
      result.done = true
      job.proc = undefined
      if (result.total === undefined) {
        result.error = errText.trim().split('\n').pop() || 'du failed'
        expire(key, job, FAILED_TTL_MS)
      } else expire(key, job, sizesTtlMs)
    }
    proc.on('close', finish)
    proc.on('error', finish)
    return result
  }

  /**
   * Stream a file, or a directory as tar.gz, into `out`. Calls `onStart` and
   * resolves once the device reports what it sends; rejects if it sends
   * nothing. A stream that breaks after the start destroys `out`, so the
   * receiver sees a failed download instead of a short file.
   */
  async function download(
    target: FsTarget,
    rawPath: unknown,
    out: Writable,
    onStart: (name: string, isDir: boolean) => void
  ): Promise<void> {
    const p = cleanPath(rawPath)
    if (p === '/') throw new FsError(400, 'cannot download the whole file system')
    const base = path.posix.basename(p)
    const child = run(target, p, DOWNLOAD)
    let kind: 'DIR' | 'FILE' | undefined
    let errText = ''
    out.on('close', () => child.kill('SIGKILL'))
    await new Promise<void>((resolve, reject) => {
      child.stderr!.on('data', (d: Buffer) => {
        if (kind) return // tar warnings after the start are not needed
        errText += d.toString()
        const m = errText.match(new RegExp(`^${MARK}(DIR|FILE)$`, 'm'))
        if (!m) return
        kind = m[1] as 'DIR' | 'FILE'
        onStart(kind === 'DIR' ? `${base}.tar.gz` : base, kind === 'DIR')
        child.stdout!.pipe(out, { end: false })
        resolve()
      })
      const fail = (code: number | null) => {
        if (code === 2) return reject(new FsError(404, `not found: ${p}`))
        if (code === 3) return reject(new FsError(403, `permission denied: ${p}`))
        if (code === 4) return reject(new FsError(400, 'cannot download the whole file system'))
        reject(new FsError(502, errText.trim().split('\n').pop() || 'download failed'))
      }
      child.on('error', (e) => {
        errText += String(e)
        if (kind) out.destroy()
        else fail(-1)
      })
      child.on('close', (code) => {
        if (!kind) fail(code)
        else if (okExit(kind, code)) out.end()
        else out.destroy()
      })
    })
  }

  function dispose(): void {
    for (const job of jobs.values()) {
      clearTimeout(job.timer)
      job.proc?.kill('SIGKILL')
    }
    jobs.clear()
  }

  return { list, sizes, download, dispose }
}

export type DeviceFiles = ReturnType<typeof createDeviceFiles>
