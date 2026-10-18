// Package manifests for edge hygiene: which package each file belongs to and
// which packages its manifest declares. Files come through `RepoFiles`.

import type { PackageInfo } from './hygiene.js'
import type { RepoFiles } from './ports.js'

/** A Cargo.toml's package name and dependencies; null for a workspace-only manifest, which owns no code */
export function parseCargoManifest(text: string): PackageInfo | null {
  const name = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(text)?.[1]
  if (!name) return null
  const deps: string[] = []
  let inDeps = false
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line)
    if (header) {
      inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(header[1].trim())
      continue
    }
    const dep = inDeps ? /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line) : null
    // A renamed dependency (`alias = { package = "real" }`) depends on the real package
    if (dep) deps.push(/package\s*=\s*"([^"]+)"/.exec(line)?.[1] ?? dep[1])
  }
  return { name, deps }
}

/** A package.json's name and dependencies of every kind; null when it is not valid JSON */
export function parsePackageJson(text: string, dirName: string): PackageInfo | null {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  const deps = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) => {
    const block = json[k]
    return block && typeof block === 'object' ? Object.keys(block) : []
  })
  return { name: typeof json.name === 'string' ? json.name : dirName, deps }
}

const parentDir = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/**
 * The nearest package manifest (Cargo.toml with a `[package]`, else package.json) at or above each file's
 * directory, up to the repo root. Paths are repo-relative. Files under no manifest are absent from the result.
 */
export async function readPackages(files: RepoFiles, filePaths: Iterable<string>): Promise<Map<string, PackageInfo>> {
  const byDir = new Map<string, Promise<PackageInfo | null>>()
  const manifestIn = async (dir: string): Promise<PackageInfo | null> => {
    const prefix = dir === '' ? '' : `${dir}/`
    const cargo = await files.read(`${prefix}Cargo.toml`)
    if (cargo !== null) return parseCargoManifest(cargo)
    const pkg = await files.read(`${prefix}package.json`)
    return pkg === null ? null : parsePackageJson(pkg, dir.split('/').pop() || '.')
  }
  const lookup = (dir: string): Promise<PackageInfo | null> => {
    let found = byDir.get(dir)
    if (!found) {
      found = manifestIn(dir).then((info) => info ?? (dir === '' ? null : lookup(parentDir(dir))))
      byDir.set(dir, found)
    }
    return found
  }
  const result = new Map<string, PackageInfo>()
  await Promise.all(
    [...new Set(filePaths)].map(async (file) => {
      const info = await lookup(parentDir(file))
      if (info) result.set(file, info)
    })
  )
  return result
}
