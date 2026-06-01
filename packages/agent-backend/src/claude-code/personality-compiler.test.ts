import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPersonalityCompiler, type PersonalityManifest } from './personality-compiler.js'

let tmpDir: string
let outputPath: string

const SEP = '\n\n---\n\n'

function manifest(files: string[], separator: string = SEP): PersonalityManifest {
  return { files, separator }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personality-'))
  outputPath = path.join(tmpDir, 'CLAUDE.md.out')
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('personality compiler', () => {
  it('writes an exact concatenation of sources joined by the configured separator', () => {
    fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), 'You are Hex.')
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), 'You value precision.')
    fs.writeFileSync(path.join(tmpDir, 'TOOLS.md'), 'You have tools.')
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest(['IDENTITY.md', 'SOUL.md', 'TOOLS.md'], '\n===\n'),
      log: () => {}
    })
    expect(compiler.compile()).toBe(true)
    const out = fs.readFileSync(outputPath, 'utf-8')
    expect(out).toBe('You are Hex.\n===\nYou value precision.\n===\nYou have tools.\n')
  })

  it('owns the whole file — overwrites any pre-existing content', () => {
    fs.writeFileSync(
      outputPath,
      '<!-- BEGIN sovereign-workspaces -->\nleftover\n<!-- END sovereign-workspaces -->\n\nhand-written notes\n'
    )
    fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), 'Hex')
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest(['IDENTITY.md']),
      log: () => {}
    })
    compiler.compile()
    const out = fs.readFileSync(outputPath, 'utf-8')
    expect(out).toBe('Hex\n')
  })

  it('skips files listed in the manifest but missing from disk', () => {
    fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), 'A')
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), 'B')
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest(['IDENTITY.md', 'GHOST.md', 'SOUL.md'], '\n---\n'),
      log: () => {}
    })
    compiler.compile()
    expect(compiler.currentOrder()).toEqual(['IDENTITY.md', 'SOUL.md'])
    const out = fs.readFileSync(outputPath, 'utf-8')
    expect(out).toBe('A\n---\nB\n')
  })

  it('returns false (no write) when re-compiling unchanged sources', () => {
    fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), 'stable')
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest(['IDENTITY.md']),
      log: () => {}
    })
    expect(compiler.compile()).toBe(true)
    const mtime1 = fs.statSync(outputPath).mtimeMs
    expect(compiler.compile()).toBe(false)
    const mtime2 = fs.statSync(outputPath).mtimeMs
    expect(mtime2).toBe(mtime1)
  })

  it('does not write when manifest is empty', () => {
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest([]),
      log: () => {}
    })
    expect(compiler.compile()).toBe(false)
    expect(fs.existsSync(outputPath)).toBe(false)
  })

  it('does not write when every listed file is missing', () => {
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest(['NONEXISTENT.md']),
      log: () => {}
    })
    expect(compiler.compile()).toBe(false)
    expect(fs.existsSync(outputPath)).toBe(false)
  })

  it('survives source dir missing entirely at compile time', () => {
    const missing = path.join(tmpDir, 'does-not-exist')
    const compiler = createPersonalityCompiler({
      sourceDir: missing,
      outputPath,
      manifest: manifest(['IDENTITY.md']),
      log: () => {}
    })
    expect(() => compiler.compile()).not.toThrow()
  })

  it('start() then stop() is safe and idempotent', () => {
    fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), 'X')
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest(['IDENTITY.md']),
      log: () => {},
      debounceMs: 20
    })
    compiler.start()
    compiler.start()
    compiler.stop()
    compiler.stop()
  })

  it('refuses to include CLAUDE.md as a source even when manifest lists it', () => {
    fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), 'real-source')
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'COMPILED-OUTPUT-NOT-A-SOURCE')
    const logs: string[] = []
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest(['IDENTITY.md', 'CLAUDE.md']),
      log: (m) => logs.push(m)
    })
    compiler.compile()
    expect(compiler.currentOrder()).toEqual(['IDENTITY.md'])
    const out = fs.readFileSync(outputPath, 'utf-8')
    expect(out).not.toContain('COMPILED-OUTPUT-NOT-A-SOURCE')
    expect(logs.some((m) => m.includes('refusing to include'))).toBe(true)
  })

  it('warns when CLAUDE.md exists in the source dir (cwd walk-up duplication risk)', () => {
    fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), 'X')
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'legacy approximation')
    const logs: string[] = []
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest(['IDENTITY.md']),
      log: (m) => logs.push(m)
    })
    compiler.compile()
    expect(logs.some((m) => m.includes('WARNING') && m.includes('doubling'))).toBe(true)
  })

  it('output contains no fence markers, no header, no extra text', () => {
    fs.writeFileSync(path.join(tmpDir, 'A.md'), 'first body')
    fs.writeFileSync(path.join(tmpDir, 'B.md'), 'second body')
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest(['A.md', 'B.md']),
      log: () => {}
    })
    compiler.compile()
    const out = fs.readFileSync(outputPath, 'utf-8')
    expect(out).toBe('first body\n\n---\n\nsecond body\n')
    expect(out).not.toContain('<!--')
    expect(out).not.toContain('Compiled by')
    expect(out).not.toContain('Source directory')
    expect(out).not.toContain('Manifest:')
  })

  it('setManifest swaps the assembly order and triggers a recompile', async () => {
    fs.writeFileSync(path.join(tmpDir, 'A.md'), 'A')
    fs.writeFileSync(path.join(tmpDir, 'B.md'), 'B')
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest(['A.md', 'B.md']),
      log: () => {},
      debounceMs: 5
    })
    compiler.compile()
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe('A\n\n---\n\nB\n')
    compiler.setManifest(manifest(['B.md', 'A.md']))
    await new Promise((r) => setTimeout(r, 30))
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe('B\n\n---\n\nA\n')
  })

  it('setManifest with a new separator triggers a rewrite', async () => {
    fs.writeFileSync(path.join(tmpDir, 'A.md'), 'A')
    fs.writeFileSync(path.join(tmpDir, 'B.md'), 'B')
    const compiler = createPersonalityCompiler({
      sourceDir: tmpDir,
      outputPath,
      manifest: manifest(['A.md', 'B.md'], '\n---\n'),
      log: () => {},
      debounceMs: 5
    })
    compiler.compile()
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe('A\n---\nB\n')
    compiler.setManifest(manifest(['A.md', 'B.md'], '\n===\n'))
    await new Promise((r) => setTimeout(r, 30))
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe('A\n===\nB\n')
  })
})
