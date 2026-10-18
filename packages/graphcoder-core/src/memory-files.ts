import type { RepoFiles } from './ports.js'

/** `RepoFiles` held in memory: for tests, and for data that is not on disk (a file set read from a git ref). */
export function createMemoryFiles(initial: Record<string, string> = {}): RepoFiles & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    read: async (path) => files.get(path) ?? null,
    write: async (path, text) => {
      files.set(path, text)
    },
    list: async (dir) => {
      const prefix = dir === '' ? '' : `${dir.replace(/\/$/, '')}/`
      const names = new Set<string>()
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split('/')[0])
      }
      return [...names].sort()
    },
    remove: async (path) => files.delete(path)
  }
}
