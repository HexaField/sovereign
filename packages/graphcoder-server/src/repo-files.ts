// `RepoFiles` over a checkout on disk. Paths are repo-relative; one that is
// absolute or climbs out of the checkout is refused, so a slug or a manifest
// path from outside can never reach another file.

import fs from 'node:fs/promises'
import path from 'node:path'
import type { RepoFiles } from '@sovereign/graphcoder-core'

const isMissing = (err: unknown) =>
  (err as NodeJS.ErrnoException)?.code === 'ENOENT' || (err as NodeJS.ErrnoException)?.code === 'ENOTDIR'

export function createNodeRepoFiles(repoPath: string): RepoFiles {
  const root = path.resolve(repoPath)
  const resolve = (rel: string): string => {
    if (path.isAbsolute(rel)) throw new Error(`Not a repo-relative path: ${rel}`)
    const abs = path.resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path leaves the repo: ${rel}`)
    return abs
  }
  return {
    read: async (rel) => {
      try {
        return await fs.readFile(resolve(rel), 'utf-8')
      } catch (err) {
        if (isMissing(err) || (err as NodeJS.ErrnoException)?.code === 'EISDIR') return null
        throw err
      }
    },
    write: async (rel, text) => {
      const abs = resolve(rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      // Write beside, then rename over: a reader never sees half a file
      const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`
      try {
        await fs.writeFile(tmp, text, 'utf-8')
        await fs.rename(tmp, abs)
      } catch (err) {
        await fs.rm(tmp, { force: true })
        throw err
      }
    },
    list: async (rel) => {
      try {
        return (await fs.readdir(resolve(rel))).sort()
      } catch (err) {
        if (isMissing(err)) return []
        throw err
      }
    },
    remove: async (rel) => {
      try {
        await fs.unlink(resolve(rel))
        return true
      } catch (err) {
        if (isMissing(err)) return false
        throw err
      }
    }
  }
}
