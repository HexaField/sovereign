// File system viewer for tailnet devices: list a directory, size its
// subdirectories, download a file or a directory (tar.gz).
//
// The local device runs commands directly; others run them over SSH (the
// same BatchMode access the device monitor uses). Every remote command goes
// in as a script on stdin with the path single-quoted, so no path reaches a
// shell unquoted.
//
// Folder sizes come from `du -x -d 1` run as a background job per
// (device, path). du prints each subdirectory as it finishes, so the client
// polls and sees sizes fill in; a finished result stays cached for a while,
// and a job nobody polls any more is killed.

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

// Lists one directory as NUL-separated records: type, size, mtime (s), name.
const LINUX_LIST = `find "$P" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0'`
const MACOS_LIST = `find "$P" -mindepth 1 -maxdepth 1 -print0 | xargs -0 -r stat -f '%HT%t%z%t%m%t%N' | tr '\\n' '\\0'`

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
  polledAt: number
  finishedAt?: number
}

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
        throw new FsError(e?.code === 'ENOENT' ? 404 : e?.code === 'EACCES' ? 403 : 400, `${e?.code ?? 'error'}: ${p}`)
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

  function sweep(now: number): void {
    for (const [key, job] of jobs) {
      if (job.finishedAt && now - job.finishedAt > sizesTtlMs) jobs.delete(key)
      else if (!job.finishedAt && now - job.polledAt > idleKillMs) {
        job.proc?.kill('SIGKILL')
        jobs.delete(key)
      }
    }
  }

  /** Current sizes of `path`'s subdirectories; starts a du job on first call. */
  function sizes(device: string, target: FsTarget, rawPath: unknown): DirSizes {
    const p = cleanPath(rawPath)
    const now = Date.now()
    sweep(now)
    const key = `${device}\0${p}`
    const existing = jobs.get(key)
    if (existing) {
      existing.polledAt = now
      return existing.result
    }
    const result: DirSizes = { path: p, sizes: {}, done: false, partial: false }
    const job: SizeJob = { result, polledAt: now }
    jobs.set(key, job)
    // -x: stay on this file system. nice: never compete with real work.
    const proc = run(target, p, `nice -n 19 du -x -d 1 -k "$P"`)
    job.proc = proc
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
    proc.stderr!.on('data', () => (result.partial = true))
    const finish = () => {
      result.done = true
      job.finishedAt = Date.now()
      job.proc = undefined
    }
    proc.on('close', finish)
    proc.on('error', finish)
    return result
  }

  /**
   * Stream a file, or a directory as tar.gz, into `out`. Resolves with the
   * download name once the first bytes arrive; rejects if nothing comes.
   */
  async function download(
    target: FsTarget,
    rawPath: unknown,
    out: Writable & { headersSent?: boolean },
    onStart: (name: string, isDir: boolean) => void
  ): Promise<void> {
    const p = cleanPath(rawPath)
    if (p === '/') throw new FsError(400, 'cannot download the whole file system')
    const base = path.posix.basename(p)
    const parent = path.posix.dirname(p)
    // The kind goes out on stderr's first line, before any data, so one round
    // trip serves both cases; stdout buffers until the pipe starts.
    const script = `if [ -d "$P" ]; then echo DIR >&2; cd ${shQuote(parent)} && tar -czf - -- ${shQuote(base)}; elif [ -f "$P" ]; then echo FILE >&2; cat -- "$P"; else echo MISSING >&2; exit 2; fi`
    const child = run(target, p, script)
    let kind: 'DIR' | 'FILE' | 'MISSING' | undefined
    let started = false
    let errText = ''
    out.on('close', () => child.kill('SIGKILL'))
    await new Promise<void>((resolve, reject) => {
      const begin = () => {
        if (started || !kind || kind === 'MISSING') return
        started = true
        onStart(kind === 'DIR' ? `${base}.tar.gz` : base, kind === 'DIR')
        child.stdout!.pipe(out)
        resolve()
      }
      child.stderr!.on('data', (d: Buffer) => {
        errText += d.toString()
        if (!kind) {
          const first = errText.split('\n')[0]
          if (first === 'DIR' || first === 'FILE' || first === 'MISSING') kind = first
          begin()
        }
      })
      child.on('close', (code) => {
        if (started) return
        if (kind === 'MISSING' || code === 2) reject(new FsError(404, `not found: ${p}`))
        else if (kind === 'FILE' && code === 0) {
          // An empty file: start with no bytes.
          begin()
          out.end()
        } else reject(new FsError(502, errText.trim().split('\n').pop() || 'download failed'))
      })
    })
  }

  function dispose(): void {
    for (const job of jobs.values()) job.proc?.kill('SIGKILL')
    jobs.clear()
  }

  return { list, sizes, download, dispose }
}

export type DeviceFiles = ReturnType<typeof createDeviceFiles>
