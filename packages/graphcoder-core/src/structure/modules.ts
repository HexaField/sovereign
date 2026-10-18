// Which module a file belongs to. P2's module map (authored lanes × tiers)
// will supply its own `ModuleOf`; until a repo has one, a module is a
// directory: the package, then the first directory below its source root.

import type { PackageInfo } from '../hygiene.js'

export interface ModuleId {
  module: string
  label: string
}

/** The module a repo-relative file belongs to */
export type ModuleOf = (filePath: string) => ModuleId

/** Directories that hold a package's sources rather than name a part of it */
const SOURCE_ROOTS: ReadonlySet<string> = new Set(['src', 'lib', 'source', 'sources'])

/**
 * Directory modules: a file's package directory (its nearest manifest, from `readPackages`; the repo root when it
 * has none), then `depth` directories below it. A source root (`src`, `lib`) does not count towards the depth, so
 * `rust-executor/src/perspectives/mod.rs` and `core/src/model/Ad4mModel.ts` land in `rust-executor/src/perspectives`
 * and `core/src/model`. A file with fewer directories above it belongs to the deepest one it has.
 */
export function directoryModules(packages: ReadonlyMap<string, PackageInfo>, depth = 1): ModuleOf {
  return (filePath) => {
    const dir = packages.get(filePath)?.dir ?? ''
    const rel = dir === '' ? filePath : filePath.slice(dir.length + 1)
    const dirs = rel.split('/').slice(0, -1)
    const take = dirs.length > 0 && SOURCE_ROOTS.has(dirs[0]) ? depth + 1 : depth
    const module = [dir, ...dirs.slice(0, take)].filter(Boolean).join('/') || '.'
    return { module, label: module }
  }
}
