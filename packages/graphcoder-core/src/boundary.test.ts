// Graphcoder's boundary, enforced. graphcoder-core imports nothing at runtime
// but its own files (tests may use node built-ins and vitest), and no other
// Sovereign package imports Graphcoder except through the contract types — the
// composition root (packages/server) aside, which wires Graphcoder in.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { boundaryViolations, importsOf, packageOf, type ImportRef } from './boundary.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packagesDir = path.resolve(here, '../..')

/** `.ts`/`.tsx` sources under a directory; this file is left out, its fixtures quote imports */
function sources(dir: string): Array<{ path: string; source: string }> {
  if (!fs.existsSync(dir)) return []
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !f.split(path.sep).includes('node_modules'))
    .map((f) => path.join(dir, f))
    .filter((f) => f !== fileURLToPath(import.meta.url))
    .map((f) => ({ path: path.relative(packagesDir, f), source: fs.readFileSync(f, 'utf-8') }))
}

const isTest = (file: string) => /\.test\.tsx?$/.test(file)

describe('importsOf', () => {
  it('finds static, type-only, re-exported, side-effect and dynamic imports with their lines', () => {
    const source = [
      "import fs from 'node:fs'",
      'import type { A } from "./a.js"',
      'import {',
      '  b,',
      '  type C',
      "} from '@scope/pkg/sub'",
      "export * from './re.js'",
      "export type { D } from './d.js'",
      "import './side-effect.js'",
      "const lazy = await import('lazy-pkg')",
      "const req = require('cjs-pkg')",
      "export const notAnImport = 'from somewhere'"
    ].join('\n')
    expect(importsOf(source).map((r: ImportRef) => [r.specifier, r.typeOnly, r.line])).toEqual([
      ['node:fs', false, 1],
      ['./a.js', true, 2],
      ['@scope/pkg/sub', false, 3],
      ['./re.js', false, 7],
      ['./d.js', true, 8],
      ['./side-effect.js', false, 9],
      ['lazy-pkg', false, 10],
      ['cjs-pkg', false, 11]
    ])
  })

  it('names the package of a specifier', () => {
    expect(packageOf('@sovereign/graphcoder-core/contract')).toBe('@sovereign/graphcoder-core')
    expect(packageOf('express')).toBe('express')
    expect(packageOf('node:fs')).toBe('node:fs')
    expect(packageOf('./x.js')).toBeNull()
  })
})

describe('graphcoder-core boundary', () => {
  const own = sources(here)

  it('scans the package', () => {
    expect(own.length).toBeGreaterThan(10)
  })

  it('imports no Sovereign package', () => {
    expect(boundaryViolations(own, (ref) => !ref.specifier.startsWith('@sovereign/'))).toEqual([])
  })

  it('has no runtime import outside its own files, and no type import of a package', () => {
    const runtime = own.filter((f) => !isTest(f.path))
    expect(boundaryViolations(runtime, (ref) => packageOf(ref.specifier) === null)).toEqual([])
  })
})

describe('Sovereign → Graphcoder boundary', () => {
  const isGraphcoder = (spec: string) => packageOf(spec)?.startsWith('@sovereign/graphcoder-') ?? false
  const outside = fs
    .readdirSync(packagesDir)
    .filter((name) => !name.startsWith('graphcoder-') && name !== 'server')
    .flatMap((name) => sources(path.join(packagesDir, name, 'src')))

  it('scans the other packages', () => {
    expect(outside.length).toBeGreaterThan(100)
  })

  it('keeps the client feature (features/graphcoder) to its own files, solid-js, and Forge and contract types', () => {
    const feature = sources(path.join(packagesDir, 'client', 'src', 'features', 'graphcoder'))
    expect(feature.length).toBeGreaterThan(3)
    const types = new Set(['@sovereign/core/forge', '@sovereign/graphcoder-core/contract'])
    const allowed = (ref: ImportRef) =>
      ref.specifier.startsWith('./') ||
      ref.specifier === 'solid-js' ||
      ref.specifier === 'vitest' ||
      (ref.typeOnly && types.has(ref.specifier))
    expect(boundaryViolations(feature, allowed)).toEqual([])
  })

  it('lets other packages import only the contract types', () => {
    const allowed = (ref: ImportRef) =>
      !isGraphcoder(ref.specifier) || (ref.specifier === '@sovereign/graphcoder-core/contract' && ref.typeOnly)
    expect(boundaryViolations(outside, allowed)).toEqual([])
  })
})
