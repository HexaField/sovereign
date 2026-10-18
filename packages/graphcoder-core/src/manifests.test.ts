import { describe, expect, it } from 'vitest'
import { parseCargoManifest, parsePackageJson, readPackages } from './manifests.js'
import { createMemoryFiles } from './memory-files.js'

describe('parseCargoManifest', () => {
  it('reads the package name and every kind of dependency, through renames', () => {
    const toml = [
      '[package]',
      'name = "executor"',
      'version = "0.1.0"',
      '',
      '[dependencies]',
      'serde = "1"',
      'client = { package = "ad4m-client", path = "../client" }',
      '',
      "[target.'cfg(unix)'.dependencies]",
      'nix = "0.27"',
      '',
      '[dev-dependencies]',
      'tempfile = "3"',
      '',
      '[build-dependencies]',
      'cc = "1"',
      '',
      '[features]',
      'default = []'
    ].join('\n')
    expect(parseCargoManifest(toml)).toEqual({
      name: 'executor',
      deps: ['serde', 'ad4m-client', 'nix', 'tempfile', 'cc']
    })
  })

  it('owns no code without a [package]', () => {
    expect(parseCargoManifest('[workspace]\nmembers = ["a", "b"]\n')).toBeNull()
  })
})

describe('parsePackageJson', () => {
  it('reads name and dependencies of every kind, falling back to the directory name', () => {
    expect(
      parsePackageJson(
        JSON.stringify({
          name: '@acme/web',
          dependencies: { a: '1' },
          devDependencies: { b: '1' },
          peerDependencies: { c: '1' }
        }),
        'web'
      )
    ).toEqual({ name: '@acme/web', deps: ['a', 'b', 'c'] })
    expect(parsePackageJson('{}', 'tools')).toEqual({ name: 'tools', deps: [] })
    expect(parsePackageJson('{', 'x')).toBeNull()
  })
})

describe('readPackages', () => {
  it('maps each file to its nearest manifest, Cargo.toml first, skipping workspace-only manifests', async () => {
    const files = createMemoryFiles({
      'package.json': JSON.stringify({ name: 'root' }),
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'crates/exec/Cargo.toml': '[package]\nname = "exec"\n[dependencies]\nlog = "1"\n',
      'crates/exec/package.json': JSON.stringify({ name: 'not-this-one' }),
      'web/package.json': JSON.stringify({ name: 'web', dependencies: { root: '*' } }),
      'broken/package.json': '{'
    })
    const packages = await readPackages(files, [
      'crates/exec/src/main.rs',
      'crates/exec/src/deep/mod.rs',
      'web/src/app.ts',
      'broken/x.ts',
      'scripts/run.ts',
      'top.ts'
    ])
    expect(packages.get('crates/exec/src/main.rs')).toEqual({ name: 'exec', deps: ['log'], dir: 'crates/exec' })
    // files of one package share one PackageInfo, which hygiene compares by identity
    expect(packages.get('crates/exec/src/deep/mod.rs')).toBe(packages.get('crates/exec/src/main.rs'))
    expect(packages.get('web/src/app.ts')).toEqual({ name: 'web', deps: ['root'], dir: 'web' })
    // a root with a workspace-only Cargo.toml has no package of its own there
    expect(packages.get('broken/x.ts')).toBeUndefined()
    expect(packages.get('scripts/run.ts')).toBeUndefined()
    expect(packages.get('top.ts')).toBeUndefined()
  })

  it('reads each manifest once', async () => {
    const files = createMemoryFiles({ 'a/package.json': JSON.stringify({ name: 'a' }) })
    const reads: string[] = []
    const counting = { ...files, read: (p: string) => (reads.push(p), files.read(p)) }
    await readPackages(counting, ['a/x.ts', 'a/y.ts', 'a/b/z.ts'])
    expect(reads.filter((p) => p === 'a/package.json')).toHaveLength(1)
  })
})
