import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { FileTreeNode } from './types.js'

export interface BuildTreeOptions {
  exclude?: string[]
}

export async function buildTree(dirPath: string, opts?: BuildTreeOptions): Promise<FileTreeNode[]> {
  const exclude = opts?.exclude ?? ['.git']
  const entries = await fs.readdir(dirPath, { withFileTypes: true })

  const nodes: FileTreeNode[] = []
  for (const entry of entries) {
    if (exclude.includes(entry.name)) continue

    const entryPath = path.join(dirPath, entry.name)
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()

    // Handle symlinks
    if (entry.isSymbolicLink()) {
      try {
        const stat = await fs.stat(entryPath)
        isDir = stat.isDirectory()
        isFile = stat.isFile()
      } catch {
        // Broken symlink — skip
        continue
      }
    }

    if (isDir) {
      nodes.push({
        name: entry.name,
        path: entry.name,
        type: 'directory'
      })
    } else if (isFile) {
      const stat = await fs.stat(entryPath)
      nodes.push({
        name: entry.name,
        path: entry.name,
        type: 'file',
        size: stat.size
      })
    }
  }

  // Sort: directories first, then alphabetically within each group
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return nodes
}
