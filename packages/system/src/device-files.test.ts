import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import {
  attachmentHeader,
  createDeviceFiles,
  cleanPath,
  shQuote,
  parseListing,
  FsError,
  type FsEntry,
  type FsTarget
} from './device-files.js'

// "Remote" devices run the same scripts through a local bash instead of ssh,
// so the quoting and parsing of the remote path get exercised for real.
const files = createDeviceFiles({ remoteShell: () => ['bash', ['-s']] })
const local: FsTarget = { local: true, sshHost: '', osHint: 'linux' }
const remote: FsTarget = { local: false, sshHost: 'unused', osHint: 'linux' }

let root: string
const ODD = `it's a "$HOME" dir`

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-fs-'))
  fs.mkdirSync(path.join(root, 'big'))
  fs.writeFileSync(path.join(root, 'big', 'blob.bin'), Buffer.alloc(300_000, 1))
  fs.mkdirSync(path.join(root, ODD))
  fs.writeFileSync(path.join(root, ODD, 'note.txt'), 'hello')
  fs.writeFileSync(path.join(root, 'small.txt'), 'abc')
  fs.symlinkSync('small.txt', path.join(root, 'link'))
  fs.mkdirSync(path.join(root, 'aside'))
  fs.symlinkSync(path.join(root, 'big'), path.join(root, 'aside', 'biglink'))
  fs.mkdirSync(path.join(root, 'aside', '-rf'))
  fs.writeFileSync(path.join(root, 'aside', '-rf', 'x'), 'x')
  fs.writeFileSync(path.join(root, 'aside', 'locked'), 'secret')
  fs.chmodSync(path.join(root, 'aside', 'locked'), 0)
})
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  files.dispose()
})

const byName = (entries: FsEntry[]) => Object.fromEntries(entries.map((e) => [e.name, e]))

describe('device files — list', () => {
  for (const [label, target] of [
    ['local', local],
    ['remote', remote]
  ] as const) {
    it(`lists the user's home directory when no path is given (${label})`, async () => {
      // The "remote" shell runs locally, so its $HOME is this user's too.
      expect((await files.list(target, undefined)).path).toBe(os.homedir())
      expect((await files.list(target, '')).path).toBe(os.homedir())
    })

    it(`lists a directory's entries with type and size (${label})`, async () => {
      const listing = await files.list(target, root)
      const e = byName(listing.entries)
      expect(listing.path).toBe(root)
      expect(Object.keys(e).sort()).toEqual(['aside', 'big', 'link', 'small.txt', ODD].sort())
      expect(e['small.txt']).toMatchObject({ type: 'file', size: 3 })
      expect(e.big).toMatchObject({ type: 'dir', size: 0 })
      expect(e[ODD].type).toBe('dir')
      expect(e.link.type).toBe('link')
      expect(e['small.txt'].mtime).toBeGreaterThan(0)
    })

    it(`reports a missing directory as 404 (${label})`, async () => {
      await expect(files.list(target, path.join(root, 'nope'))).rejects.toMatchObject({ status: 404 })
    })

    it(`lists through a symlink to a directory (${label})`, async () => {
      const listing = await files.list(target, path.join(root, 'aside', 'biglink'))
      expect(listing.entries.map((e) => e.name)).toEqual(['blob.bin'])
    })
  }

  it('parses the macOS stat format', () => {
    const raw = ['Directory\t96\t1700000000\t/Users/j/docs', 'Regular File\t12\t1700000001\t/Users/j/a b.txt', ''].join(
      '\0'
    )
    expect(parseListing(raw, '/Users/j', true)).toEqual([
      { name: 'docs', type: 'dir', size: 0, mtime: 1_700_000_000_000 },
      { name: 'a b.txt', type: 'file', size: 12, mtime: 1_700_000_001_000 }
    ])
  })
})

describe('device files — sizes', () => {
  it('sizes subdirectories with du, filling in until done (remote path, odd names)', async () => {
    let s = files.sizes('dev', remote, root)
    for (let i = 0; i < 100 && !s.done; i++) {
      await new Promise((r) => setTimeout(r, 20))
      s = files.sizes('dev', remote, root)
    }
    expect(s.done).toBe(true)
    expect(s.sizes.big).toBeGreaterThanOrEqual(290_000)
    expect(s.sizes[ODD]).toBeGreaterThan(0)
    expect(s.total).toBeGreaterThanOrEqual(s.sizes.big)
    // A second call serves the cached result.
    expect(files.sizes('dev', remote, root)).toBe(s)
  })

  const settle = async (get: () => { done: boolean }) => {
    for (let i = 0; i < 100 && !get().done; i++) await new Promise((r) => setTimeout(r, 20))
  }

  it('sizes the target of a symlinked directory', async () => {
    const link = path.join(root, 'aside', 'biglink')
    await settle(() => files.sizes('dev', remote, link))
    expect(files.sizes('dev', remote, link).total).toBeGreaterThanOrEqual(290_000)
  })

  it('kills a du nobody polls, without waiting for another request', async () => {
    const slow = createDeviceFiles({
      remoteShell: () => ['bash', ['-c', 'cat >/dev/null; sleep 30']],
      idleKillMs: 100
    })
    const s = slow.sizes('dev', remote, root)
    await new Promise((r) => setTimeout(r, 400))
    expect(s.done).toBe(true)
    slow.dispose()
  })

  it('reports an unreachable device as an error, not as partial sizes', async () => {
    const down = createDeviceFiles({
      remoteShell: () => [
        'bash',
        [
          '-c',
          'cat >/dev/null; echo "Warning: Permanently added x" >&2; echo "ssh: connect to host x: Connection refused" >&2; exit 255'
        ]
      ]
    })
    const get = () => down.sizes('dev', remote, root)
    await settle(get)
    expect(get()).toMatchObject({
      done: true,
      partial: false,
      error: 'ssh: connect to host x: Connection refused'
    })
    down.dispose()
  })

  /** A device whose "du" prints `out` on stdout and `err` on stderr; it also sees the script on stdin. */
  const fakeDu = (body: string, opts = {}) =>
    createDeviceFiles({ remoteShell: () => ['bash', ['-c', `S=$(cat); ${body}`]], ...opts })

  it('stops a du that runs past the cap, polled or not, with a reason', async () => {
    const slow = fakeDu('sleep 30', { maxRunMs: 150, idleKillMs: 60_000 })
    const get = () => slow.sizes('dev', remote, root)
    await settle(get)
    expect(get()).toMatchObject({ done: true, error: 'stopped after 0.15 s: folder too large to count' })
    slow.dispose()
  })

  it("passes du's first complaints through verbatim", async () => {
    const d = fakeDu(
      `printf '1\\t/x/a\\n'; for i in 1 2 3 4; do echo "du: /x/b$i: Permission denied" >&2; done; printf '9\\t/x\\n'`
    )
    const get = () => d.sizes('dev', remote, '/x')
    await settle(get)
    expect(get()).toMatchObject({
      done: true,
      partial: true,
      total: 9 * 1024,
      sizes: { a: 1024 },
      warnings: ['du: /x/b1: Permission denied', 'du: /x/b2: Permission denied', 'du: /x/b3: Permission denied']
    })
    d.dispose()
  })

  it('at the macOS root and /System, skips the Volumes folder so the data volume counts once', async () => {
    // The fake du reports the requested path as the total, plus a `skip` entry when given `-I Volumes`.
    const d = fakeDu(
      `case "$S" in *"-I Volumes "*) printf '1\\t/skip\\n';; esac; printf '5\\t%s\\n' "$(printf %s "$S" | sed -n "s/^P='\\(.*\\)'$/\\1/p")"`
    )
    const mac: FsTarget = { local: false, sshHost: 'unused', osHint: 'macos' }
    for (const p of ['/', '/System']) {
      const get = () => d.sizes('mac', mac, p)
      await settle(get)
      expect(get()).toMatchObject({ done: true, total: 5 * 1024, sizes: { skip: 1024 } })
    }
    d.dispose()
  })

  it('below the macOS root, runs one du as usual', async () => {
    const d = fakeDu(
      `printf '7\\t/Users/josh\\n9\\t/Users\\n'
       case "$S" in *"-I Volumes"*) printf '1\\t/Users/skip\\n';; esac`
    )
    const mac: FsTarget = { local: false, sshHost: 'unused', osHint: 'macos' }
    const get = () => d.sizes('mac', mac, '/Users')
    await settle(get)
    expect(get()).toMatchObject({ done: true, total: 9 * 1024 })
    expect(get().sizes).toEqual({ josh: 7 * 1024 })
    d.dispose()
  })
})

describe('device files — download', () => {
  const grab = async (target: FsTarget, p: string) => {
    const out = new PassThrough()
    const chunks: Buffer[] = []
    out.on('data', (c) => chunks.push(c))
    const ended = new Promise((r) => out.on('end', r))
    let meta: { name: string; isDir: boolean } | undefined
    await files.download(target, p, out, (name, isDir) => (meta = { name, isDir }))
    await ended
    return { meta, body: Buffer.concat(chunks) }
  }

  it('streams a file as is', async () => {
    const { meta, body } = await grab(remote, path.join(root, ODD, 'note.txt'))
    expect(meta).toEqual({ name: 'note.txt', isDir: false })
    expect(body.toString()).toBe('hello')
  })

  it('streams a directory as tar.gz that unpacks to the same tree', async () => {
    const { meta, body } = await grab(local, path.join(root, ODD))
    expect(meta).toEqual({ name: `${ODD}.tar.gz`, isDir: true })
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-fs-out-'))
    fs.writeFileSync(path.join(dest, 'x.tar.gz'), body)
    execFileSync('tar', ['-xzf', 'x.tar.gz'], { cwd: dest })
    expect(fs.readFileSync(path.join(dest, ODD, 'note.txt'), 'utf8')).toBe('hello')
    fs.rmSync(dest, { recursive: true, force: true })
  })

  it('rejects a missing path with 404, and the root with 400', async () => {
    await expect(grab(remote, path.join(root, 'nope'))).rejects.toMatchObject({ status: 404 })
    await expect(grab(local, '/')).rejects.toMatchObject({ status: 400 })
  })

  const untar = (body: Buffer) => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-fs-out-'))
    fs.writeFileSync(path.join(dest, 'x.tar.gz'), body)
    execFileSync('tar', ['-xzf', 'x.tar.gz'], { cwd: dest })
    return dest
  }

  it('archives the contents of a symlinked directory, not just the link', async () => {
    const { meta, body } = await grab(remote, path.join(root, 'aside', 'biglink'))
    expect(meta).toEqual({ name: 'biglink.tar.gz', isDir: true })
    const dest = untar(body)
    expect(fs.statSync(path.join(dest, 'big', 'blob.bin')).size).toBe(300_000)
    fs.rmSync(dest, { recursive: true, force: true })
  })

  it('archives a directory whose name starts with a dash', async () => {
    const dest = untar((await grab(remote, path.join(root, 'aside', '-rf'))).body)
    expect(fs.readFileSync(path.join(dest, '-rf', 'x'), 'utf8')).toBe('x')
    fs.rmSync(dest, { recursive: true, force: true })
  })

  it.skipIf(process.getuid?.() === 0)('rejects an unreadable file with 403 before sending headers', async () => {
    let started = false
    await expect(
      files.download(remote, path.join(root, 'aside', 'locked'), new PassThrough(), () => (started = true))
    ).rejects.toMatchObject({ status: 403 })
    expect(started).toBe(false)
  })

  it('finds the start marker after other stderr output (ssh warnings, login shells)', async () => {
    const noisy = createDeviceFiles({
      remoteShell: () => ['bash', ['-c', 'echo "Warning: Permanently added x" >&2; exec bash -s']]
    })
    const out = new PassThrough()
    const chunks: Buffer[] = []
    out.on('data', (c) => chunks.push(c))
    const ended = new Promise((r) => out.on('end', r))
    await noisy.download(remote, path.join(root, 'big', 'blob.bin'), out, () => {})
    await ended
    expect(Buffer.concat(chunks).length).toBe(300_000)
  })

  it('destroys the output when the stream breaks after the start', async () => {
    const dropped = createDeviceFiles({
      remoteShell: () => ['bash', ['-c', 'bash -s; exit 255']]
    })
    const out = new PassThrough()
    out.resume()
    let ended = false
    out.on('end', () => (ended = true))
    const closed = new Promise((r) => out.on('close', r))
    await dropped.download(remote, path.join(root, 'small.txt'), out, () => {})
    await closed
    expect(ended).toBe(false)
    expect(out.destroyed).toBe(true)
  })
})

describe('device files — path handling', () => {
  it('accepts absolute paths only, normalised', () => {
    expect(cleanPath(undefined)).toBe('/')
    expect(cleanPath('/a/b/../c/')).toBe('/a/c')
    expect(() => cleanPath('relative')).toThrow(FsError)
    expect(() => cleanPath('/a\0b')).toThrow(FsError)
  })

  it('encodes the RFC 5987 delimiters in a download name', () => {
    expect(attachmentHeader("it's (1)*.txt")).toBe("attachment; filename*=UTF-8''it%27s%20%281%29%2A.txt")
  })

  it('single-quotes for a shell, including embedded quotes', () => {
    expect(execFileSync('bash', ['-c', `printf %s ${shQuote(ODD)}`]).toString()).toBe(ODD)
  })
})
