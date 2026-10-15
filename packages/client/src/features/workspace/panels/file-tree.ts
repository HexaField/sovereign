// Pure helpers for the file panel's lazily loaded tree. Node paths are
// relative to their root; a subtree fetch returns paths relative to its
// directory, so merging prefixes them.

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: TreeNode[]
}

/** The root that holds `filePath` — the longest match, so nested roots win. */
export function rootFor(roots: readonly { path: string }[], filePath: string): string | undefined {
  let best: string | undefined
  for (const { path } of roots) {
    if (filePath.startsWith(path + '/') && (!best || path.length > best.length)) best = path
  }
  return best
}

/** The directories above a root-relative file path, outermost first: "a/b/c.md" → ["a", "a/b"]. */
export function ancestorDirs(relPath: string): string[] {
  const parts = relPath.split('/').slice(0, -1)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

export function findNode<T extends TreeNode>(nodes: readonly T[], path: string): T | undefined {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children && path.startsWith(n.path + '/')) return findNode(n.children as T[], path)
  }
  return undefined
}

/** `nodes` with `children` (paths relative to `dirPath`) set as `dirPath`'s children. */
export function withChildren<T extends TreeNode>(nodes: readonly T[], dirPath: string, children: readonly T[]): T[] {
  return nodes.map((n) => {
    if (n.type !== 'directory') return n
    if (n.path === dirPath) return { ...n, children: children.map((c) => ({ ...c, path: `${dirPath}/${c.path}` })) }
    if (n.children && dirPath.startsWith(n.path + '/'))
      return { ...n, children: withChildren(n.children as T[], dirPath, children) }
    return n
  })
}

/** Directory paths outermost first, so each merge finds its parent already loaded. */
export function byDepth(dirs: readonly string[]): string[] {
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)
}
