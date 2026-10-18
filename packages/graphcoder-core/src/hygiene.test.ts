import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from './graph.js'
import { createEdgeHygiene, importedNames, isTestPath, type PackageInfo } from './hygiene.js'

function file(path: string): GraphNode {
  return {
    id: `file:${path}`,
    kind: 'file',
    name: path.split('/').pop()!,
    qualifiedName: path,
    filePath: path,
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0
  }
}

function fn(name: string, path: string): GraphNode {
  return { ...file(path), id: `fn:${path}:${name}`, kind: 'function', name, qualifiedName: name }
}

function edge(
  source: GraphNode,
  target: GraphNode,
  meta: Record<string, unknown> = { confidence: 0.95, resolvedBy: 'qualified-name' },
  kind: GraphEdge['kind'] = 'calls'
): GraphEdge {
  return { source: source.id, target: target.id, kind, metadata: meta }
}

/** ui → api → db: two symbols in two files each */
function chain() {
  const db = [fn('query', 'src/db/q.ts'), fn('store', 'src/db/s.ts')]
  const api = [fn('handle', 'src/api/h.ts'), fn('route', 'src/api/r.ts')]
  const ui = [fn('render', 'src/ui/v.tsx'), fn('click', 'src/ui/c.tsx')]
  return { nodes: [...db, ...api, ...ui], db, api, ui }
}

const byName = { confidence: 0.9, resolvedBy: 'exact-match' }
const sure = { confidence: 0.95, resolvedBy: 'qualified-name' }

describe('edge hygiene', () => {
  it('drops low-confidence edges and common names bound by name', () => {
    const { nodes, db, api } = chain()
    const clone = fn('clone', 'src/db/q.ts')
    const h = createEdgeHygiene([...nodes, clone])
    expect(h.reject(edge(api[0], db[0], { confidence: 0.4, resolvedBy: 'exact-match' }))).toBe('low-confidence')
    expect(h.reject(edge(api[1], db[1], { confidence: 0.5, resolvedBy: 'fuzzy' }))).toBe('low-confidence')
    expect(h.reject(edge(api[0], clone))).toBe('common-name')
    expect(h.reject(edge(api[0], db[0]))).toBeNull()
  })

  it('trusts a common name only when an import path bound it', () => {
    const { nodes, api } = chain()
    const make = fn('new', 'src/db/s.ts')
    const h = createEdgeHygiene([...nodes, make])
    expect(h.trusted([edge(api[0], make, sure), edge(api[1], make, sure)])).toEqual([])
    const imported = { confidence: 0.9, resolvedBy: 'import' }
    expect(h.trusted([edge(api[0], make, imported, 'imports'), edge(api[1], make, imported, 'imports')])).toHaveLength(
      2
    )
  })

  it('drops name-only matches onto enum variants, and keeps qualified ones', () => {
    const { nodes, api } = chain()
    const variant = { ...fn('Tool', 'src/db/q.ts'), id: 'em:Tool', kind: 'enum_member' as const }
    const h = createEdgeHygiene([...nodes, variant])
    expect(h.reject(edge(api[0], variant, { confidence: 0.9, resolvedBy: 'exact-match' }))).toBe('enum-member')
    expect(h.reject(edge(api[0], variant, { confidence: 0.9, resolvedBy: 'fuzzy' }))).toBe('enum-member')
    expect(h.reject(edge(api[0], variant, sure))).toBeNull()
    // the same name on a plain function stays trusted
    const plain = fn('Tool', 'src/db/s.ts')
    expect(createEdgeHygiene([...nodes, plain]).reject(edge(api[0], plain, byName))).toBeNull()
  })

  it('treats macro, codec, builder, trait and callback names as common', () => {
    const { nodes, api } = chain()
    for (const name of ['json', 'encode', 'decode', 'finish', 'Drop', 'fn']) {
      const target = fn(name, 'src/db/q.ts')
      const h = createEdgeHygiene([...nodes, target])
      expect(h.reject(edge(api[0], target, byName)), name).toBe('common-name')
      expect(h.reject(edge(api[0], target, { confidence: 0.9, resolvedBy: 'import' })), name).toBeNull()
    }
  })

  it('treats test-runner globals and std collection methods as common names', () => {
    const { nodes, api } = chain()
    for (const name of [
      'expect',
      'join',
      'delete',
      'describe',
      'it',
      'test',
      'beforeEach',
      'vi',
      'jest',
      'replace',
      'drain',
      'flatten'
    ]) {
      const target = fn(name, 'src/db/q.ts')
      expect(createEdgeHygiene([...nodes, target]).reject(edge(api[0], target, byName)), name).toBe('common-name')
    }
  })

  it('names the reason hygiene drops an edge, and checks a planned edge for kind and test code only', () => {
    const { nodes, db, api } = chain()
    const variant = { ...fn('Json', 'src/db/q.ts'), kind: 'enum_member' as const, id: 'enum_member:Json' }
    const get = fn('get', 'src/db/q.ts')
    const spec = fn('spec', 'src/api/h.test.ts')
    const packages = new Map([
      ['src/api/h.ts', { name: 'client', deps: [] }],
      ['src/db/q.ts', { name: 'server', deps: [] }]
    ])
    const h = createEdgeHygiene([...nodes, variant, get, spec], {
      packages,
      testRanges: new Map([['src/api/r.ts', [[20, 30]]]])
    })
    expect(h.reject(edge(api[0], db[0], byName, 'contains'))).toBe('edge-kind')
    expect(h.reject(edge(api[0], db[0], { confidence: 0.4, resolvedBy: 'exact-match' }))).toBe('low-confidence')
    expect(h.reject({ source: api[0].id, target: db[0].id, kind: 'calls' })).toBe('low-confidence')
    expect(h.reject(edge(api[0], variant, byName))).toBe('enum-member')
    expect(h.reject(edge(api[0], get, byName))).toBe('common-name')
    expect(h.reject(edge(spec, db[0], sure))).toBe('test-code')
    expect(h.reject({ ...edge(api[1], db[1], sure), line: 25 })).toBe('test-code')
    expect(h.reject(edge(api[0], db[0], sure))).toBe('undeclared-package')
    expect(h.reject(edge(api[1], db[1], sure))).toBeNull()
    // a planned edge names both ends exactly: no resolver checks, but test code and kind still apply
    const planned = (s: GraphNode, t: GraphNode, kind: GraphEdge['kind'] = 'calls'): GraphEdge => ({
      source: s.id,
      target: t.id,
      kind
    })
    expect(h.reject(planned(api[0], get), { planned: true })).toBeNull()
    expect(h.reject(planned(api[0], db[0]), { planned: true })).toBeNull()
    expect(h.reject(planned(spec, db[0]), { planned: true })).toBe('test-code')
    expect(h.reject(planned(api[0], db[0], 'contains'), { planned: true })).toBe('edge-kind')
    // an end the graph does not hold: nothing to judge, and `trusted` leaves it out
    expect(h.reject({ source: 'ghost', target: db[0].id, kind: 'calls' })).toBeNull()
    expect(h.trusted([{ source: 'ghost', target: db[0].id, kind: 'imports' }])).toEqual([])
  })

  it('drops a name-only match when the source file imports that name from another package', () => {
    const { nodes, api } = chain()
    const appInfo = { ...fn('AppInfo', 'src/db/q.ts'), kind: 'struct' as const, id: 'struct:AppInfo' }
    const packages = new Map<string, PackageInfo>([
      ['src/api/h.ts', { name: 'client', deps: ['server'] }],
      ['src/db/q.ts', { name: 'server', deps: [] }]
    ])
    const importNode = (source: string, signature: string): GraphNode => ({
      ...file('src/api/h.ts'),
      id: `import:${signature}`,
      kind: 'import',
      name: source,
      qualifiedName: source,
      signature
    })
    const trusted = (imports: GraphNode[], resolvedBy = 'exact-match', withPackages = true) =>
      createEdgeHygiene([...nodes, appInfo, ...imports], withPackages ? { packages } : {}).trusted([
        edge(api[0], appInfo, { confidence: 0.9, resolvedBy })
      ]).length
    const external = importNode('holochain', 'use holochain::conductor::api::AppInfo;')
    expect(trusted([external])).toBe(0)
    expect(trusted([importNode('ext', 'import { AppInfo } from "@vendor/ext";')])).toBe(0)
    // an import from the target's own package, a crate-local or relative import, or a resolver that followed the
    // import path all leave the binding alone
    expect(trusted([importNode('server', 'use server::AppInfo;')])).toBe(1)
    expect(trusted([importNode('crate', 'use crate::db::AppInfo;')])).toBe(1)
    expect(trusted([importNode('./q', 'import { AppInfo } from "./q";')])).toBe(1)
    expect(trusted([importNode('@/db', 'import { AppInfo } from "@/db";')])).toBe(1)
    expect(trusted([external], 'qualified-name')).toBe(1)
    // other names imported from that package do not matter, and without manifests the source package is unknown
    expect(trusted([importNode('holochain', 'use holochain::prelude::Signal;')])).toBe(1)
    expect(trusted([external], 'exact-match', false)).toBe(1)
    // the import nodes can come separately (a diff check passes the unmerged ones)
    expect(
      createEdgeHygiene([...nodes, appInfo], { packages, importNodes: [external] }).trusted([
        edge(api[0], appInfo, byName)
      ])
    ).toEqual([])
  })

  it('drops edges from test files and inline test code, unless the source is kept', () => {
    const { nodes, db, api } = chain()
    const testFile = fn('fixture', 'src/api/routes.test.ts')
    const ranges = new Map<string, Array<[number, number]>>([['src/db/q.ts', [[4, 9]]]])
    const h = createEdgeHygiene([...nodes, testFile], { testRanges: ranges })
    expect(h.reject(edge(testFile, db[0]))).toBe('test-code')
    expect(h.reject({ ...edge(db[0], api[0]), line: 5 })).toBe('test-code')
    expect(h.reject({ ...edge(db[0], api[0]), line: 12 })).toBeNull()
    // no line on the edge: the source symbol's own start line decides
    expect(
      createEdgeHygiene([...nodes, { ...fn('t', 'src/db/q.ts'), startLine: 6 }], { testRanges: ranges }).reject(
        edge({ ...fn('t', 'src/db/q.ts'), startLine: 6 }, api[0])
      )
    ).toBe('test-code')
    // a module made only of tests depends on what it tests
    const kept = createEdgeHygiene([...nodes, testFile], { keepTestSource: (s) => s.filePath.endsWith('.test.ts') })
    expect(kept.reject(edge(testFile, db[0]))).toBeNull()
  })

  it('drops edges into a package the source manifest does not declare', () => {
    const { nodes, db, api } = chain()
    const client = { name: 'client', deps: [] }
    const server = { name: 'server', deps: ['client'] }
    const packages = new Map([
      ['src/api/h.ts', client],
      ['src/api/r.ts', client],
      ['src/db/q.ts', server],
      ['src/db/s.ts', server]
    ])
    const h = createEdgeHygiene(nodes, { packages })
    expect(h.trusted([edge(api[0], db[0]), edge(api[1], db[1])])).toEqual([])
    expect(h.trusted([edge(db[0], api[0]), edge(db[1], api[1])])).toHaveLength(2)
    // a relative import binds by path, whatever the manifests say
    expect(
      h.reject(edge(api[0], db[0], { confidence: 0.9, resolvedBy: 'import', refName: '../db/q' }, 'imports'))
    ).toBeNull()
  })

  it('drops a cross-package import whose path names another package, and trusts one the manifest declares', () => {
    const { nodes, db, api } = chain()
    const client = { name: 'ad4m-client', deps: [] }
    const server = { name: 'executor', deps: ['ad4m-client', 'log'] }
    const packages = new Map([
      ['src/db/q.ts', client],
      ['src/db/s.ts', client],
      ['src/api/h.ts', server],
      ['src/api/r.ts', server]
    ])
    const imp = (ref: string) => ({ confidence: 0.7, resolvedBy: 'instance-method', refName: ref })
    const h = createEdgeHygiene(nodes, { packages })
    // the path names `log`, not the package it resolved into: no vouching, so the resolver checks apply first
    expect(h.reject(edge(api[0], db[0], imp('log::info'), 'imports'))).toBe('low-confidence')
    expect(h.reject(edge(api[0], db[0], { ...imp('log::info'), confidence: 0.95 }, 'imports'))).toBe(
      'undeclared-package'
    )
    // below the confidence floor, yet the manifest vouches for the import
    expect(h.reject(edge(api[0], db[0], imp('ad4m_client::literal'), 'imports'))).toBeNull()
    expect(h.reject(edge(api[1], db[1], imp('ad4m_client::runtime'), 'imports'))).toBeNull()
  })
})

describe('isTestPath', () => {
  it('knows test directories and test file names across languages', () => {
    for (const p of [
      'tests/a.rs',
      'src/__tests__/x.ts',
      'a/test-support/b.ts',
      'src/foo.test.ts',
      'x.spec.mjs',
      'src/lib_test.rs',
      'crate/src/tests.rs',
      'pkg/core_e2e/x.ts'
    ])
      expect(isTestPath(p), p).toBe(true)
    for (const p of ['src/testing.ts', 'src/latest/a.ts', 'src/contest.rs', 'src/test-helpers-ish.ts'])
      expect(isTestPath(p), p).toBe(false)
  })
})

describe('importedNames', () => {
  it('lists the identifiers a use or import statement binds', () => {
    expect(importedNames('use holochain::prelude::{\n    ExternIO, HoloHash,\n};')).toEqual(['ExternIO', 'HoloHash'])
    expect(importedNames('pub(crate) use a::{b::{self, C}, d as E, f::*};')).toEqual(['C', 'E'])
    expect(importedNames('use serde_json::json;')).toEqual(['json'])
    expect(importedNames('import { a, b as c, type D } from "m";')).toEqual(['a', 'c', 'D'])
    expect(importedNames("import React, { useState } from 'react'")).toEqual(['useState', 'React'])
    expect(importedNames('import type Foo from "m"')).toEqual(['Foo'])
    expect(importedNames('import * as ns from "m"')).toEqual([])
    expect(importedNames('import "./side-effect"')).toEqual([])
  })
})
