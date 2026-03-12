import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { buildTree } from './tree.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovereign-tree-'))
  await fs.mkdir(path.join(tmpDir, 'src'))
  await fs.writeFile(path.join(tmpDir, 'readme.md'), '# Hello')
  await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), 'export {}')
  await fs.mkdir(path.join(tmpDir, '.git'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('File Tree Builder', () => {
  it('lists directory contents one level deep', async () => {
    const nodes = await buildTree(tmpDir)
    expect(nodes.length).toBe(2) // src + readme.md (.git excluded)
    const names = nodes.map((n) => n.name)
    expect(names).toContain('src')
    expect(names).toContain('readme.md')
  })

  it('returns files with type and size', async () => {
    const nodes = await buildTree(tmpDir)
    const file = nodes.find((n) => n.name === 'readme.md')
    expect(file?.type).toBe('file')
    expect(file?.size).toBeGreaterThan(0)
  })

  it('excludes .git directory by default', async () => {
    const nodes = await buildTree(tmpDir)
    expect(nodes.find((n) => n.name === '.git')).toBeUndefined()
  })

  it('supports custom exclude patterns', async () => {
    await fs.mkdir(path.join(tmpDir, 'node_modules'))
    const nodes = await buildTree(tmpDir, { exclude: ['.git', 'node_modules'] })
    expect(nodes.find((n) => n.name === 'node_modules')).toBeUndefined()
  })

  it('handles symlinks gracefully', async () => {
    await fs.symlink(path.join(tmpDir, 'readme.md'), path.join(tmpDir, 'link.md'))
    const nodes = await buildTree(tmpDir)
    const link = nodes.find((n) => n.name === 'link.md')
    expect(link?.type).toBe('file')
  })
})
