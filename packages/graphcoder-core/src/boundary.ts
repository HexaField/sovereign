// The import scanner behind the boundary tests. Graphcoder stays separable from
// Sovereign only while no Graphcoder package imports Sovereign code, and no
// Sovereign package imports Graphcoder beyond the contract types. Each
// Graphcoder package runs this over its own sources; graphcoder-core also
// runs it over the rest of the repo.

export interface ImportRef {
  specifier: string
  /** `import type` / `export type`: erased at build time, no runtime link */
  typeOnly: boolean
  /** 1-based */
  line: number
}

const STATIC = /^[ \t]*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"\n]+)['"]/gm
const DYNAMIC = /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g

const lineAt = (source: string, index: number) => source.slice(0, index).split('\n').length

/** Every module specifier a TypeScript source names: static imports and re-exports, `import()` and `require()`. */
export function importsOf(source: string): ImportRef[] {
  const refs: ImportRef[] = []
  for (const m of source.matchAll(STATIC)) {
    refs.push({ specifier: m[2], typeOnly: m[1] !== undefined, line: lineAt(source, m.index ?? 0) })
  }
  for (const m of source.matchAll(DYNAMIC)) {
    refs.push({ specifier: m[1], typeOnly: false, line: lineAt(source, m.index ?? 0) })
  }
  return refs.sort((a, b) => a.line - b.line)
}

/** The package a specifier names: `@scope/name` or `name`; null for a relative path */
export function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export interface BoundaryViolation {
  file: string
  line: number
  specifier: string
}

/** The imports in `files` that `allowed` refuses. */
export function boundaryViolations(
  files: Array<{ path: string; source: string }>,
  allowed: (ref: ImportRef) => boolean
): BoundaryViolation[] {
  return files.flatMap(({ path, source }) =>
    importsOf(source)
      .filter((ref) => !allowed(ref))
      .map((ref) => ({ file: path, line: ref.line, specifier: ref.specifier }))
  )
}
