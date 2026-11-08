// Graphcoder's boundary: the CLI imports no Sovereign package but Graphcoder's
// own, and no package its manifest does not declare.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { boundaryViolations, packageOf } from '@sovereign/graphcoder-core/boundary'

const src = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(src, '../package.json'), 'utf-8'))
const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
  'vitest'
])
const files = (fs.readdirSync(src, { recursive: true }) as string[])
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => ({ path: f, source: fs.readFileSync(path.join(src, f), 'utf-8') }))

describe('graphcoder-cli boundary', () => {
  it('scans the package', () => {
    expect(files.length).toBeGreaterThanOrEqual(3)
  })

  it('imports no Sovereign package but graphcoder-core and graphcoder-server', () => {
    const allowed = ({ specifier }: { specifier: string }) =>
      !specifier.startsWith('@sovereign/') ||
      ['@sovereign/graphcoder-core', '@sovereign/graphcoder-server'].includes(packageOf(specifier)!)
    expect(boundaryViolations(files, allowed)).toEqual([])
  })

  it('imports only node built-ins and declared packages', () => {
    const allowed = ({ specifier }: { specifier: string }) => {
      const pkg = packageOf(specifier)
      return pkg === null || pkg.startsWith('node:') || declared.has(pkg)
    }
    expect(boundaryViolations(files, allowed)).toEqual([])
  })
})
