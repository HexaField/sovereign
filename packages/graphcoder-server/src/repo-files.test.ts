import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAnnotation, ensureKind, loadAllAnnotations, saveAnnotation } from '@sovereign/graphcoder-core'
import { createNodeRepoFiles } from './repo-files.js'

let dir: string | undefined
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})
const tmpRepo = () => (dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphcoder-files-'))))

describe('createNodeRepoFiles', () => {
  it('reads, writes (creating directories), lists and removes repo-relative files', async () => {
    const repo = tmpRepo()
    const files = createNodeRepoFiles(repo)
    expect(await files.read('.graphcoder/x.json')).toBeNull()
    expect(await files.list('.graphcoder')).toEqual([])
    await files.write('.graphcoder/annotations/b.json', '{}\n')
    await files.write('.graphcoder/annotations/a.json', '[]\n')
    expect(await files.read('.graphcoder/annotations/a.json')).toBe('[]\n')
    expect(await files.list('.graphcoder/annotations')).toEqual(['a.json', 'b.json'])
    expect(await files.read('.graphcoder/annotations')).toBeNull()
    expect(await files.remove('.graphcoder/annotations/a.json')).toBe(true)
    expect(await files.remove('.graphcoder/annotations/a.json')).toBe(false)
    // no temporary file is left beside a written one
    expect(fs.readdirSync(path.join(repo, '.graphcoder/annotations'))).toEqual(['b.json'])
  })

  it('refuses absolute paths and paths that leave the repo', async () => {
    const repo = tmpRepo()
    const files = createNodeRepoFiles(path.join(repo, 'inner'))
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'secret')
    await expect(files.read('../outside.txt')).rejects.toThrow(/leaves the repo/)
    await expect(files.read(path.join(repo, 'outside.txt'))).rejects.toThrow(/repo-relative/)
    await expect(files.write('a/../../x', 'y')).rejects.toThrow(/leaves the repo/)
    expect(fs.existsSync(path.join(repo, 'x'))).toBe(false)
  })

  it('carries the core annotation store and kind registry onto disk', async () => {
    const repo = tmpRepo()
    const files = createNodeRepoFiles(repo)
    const slug = await saveAnnotation(files, createAnnotation('Request Flow', [], { kind: 'data-flow', ordered: true }))
    await ensureKind(files, 'data-flow')
    expect(fs.existsSync(path.join(repo, '.graphcoder', 'annotations', `${slug}.json`))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(repo, '.graphcoder', 'annotation-kinds.json'), 'utf-8'))[0].name).toBe(
      'data-flow'
    )
    expect((await loadAllAnnotations(files)).map((a) => [a.id, a.shape])).toEqual([['request-flow', 'polyline']])
  })
})
