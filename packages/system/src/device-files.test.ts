import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import {
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
    it(`lists a directory's entries with type and size (${label})`, async () => {
      const listing = await files.list(target, root)
      const e = byName(listing.entries)
      expect(listing.path).toBe(root)
      expect(Object.keys(e).sort()).toEqual(['big', 'link', 'small.txt', ODD].sort())
      expect(e['small.txt']).toMatchObject({ type: 'file', size: 3 })
      expect(e.big).toMatchObject({ type: 'dir', size: 0 })
      expect(e[ODD].type).toBe('dir')
      expect(e.link.type).toBe('link')
      expect(e['small.txt'].mtime).toBeGreaterThan(0)
    })

    it(`reports a missing directory as 404 (${label})`, async () => {
      await expect(files.list(target, path.join(root, 'nope'))).rejects.toMatchObject({ status: 404 })
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
})

describe('device files — path handling', () => {
  it('accepts absolute paths only, normalised', () => {
    expect(cleanPath(undefined)).toBe('/')
    expect(cleanPath('/a/b/../c/')).toBe('/a/c')
    expect(() => cleanPath('relative')).toThrow(FsError)
    expect(() => cleanPath('/a\0b')).toThrow(FsError)
  })

  it('single-quotes for a shell, including embedded quotes', () => {
    expect(execFileSync('bash', ['-c', `printf %s ${shQuote(ODD)}`]).toString()).toBe(ODD)
  })
})
