import { describe, expect, it } from 'vitest'
import type { PackageInfo } from '../hygiene.js'
import { directoryModules } from './modules.js'

const exec: PackageInfo = { name: 'rust-executor', deps: [], dir: 'rust-executor' }
const core: PackageInfo = { name: '@coasys/ad4m', deps: [], dir: 'core' }
const root: PackageInfo = { name: 'root', deps: [], dir: '' }

describe('directoryModules', () => {
  const packages = new Map([
    ['rust-executor/src/perspectives/mod.rs', exec],
    ['rust-executor/src/perspectives/auto/claim.rs', exec],
    ['rust-executor/src/main.rs', exec],
    ['rust-executor/build.rs', exec],
    ['core/src/model/Ad4mModel.ts', core],
    ['core/scripts/gen/x.ts', core],
    ['tools/run.ts', root]
  ])
  const moduleOf = directoryModules(packages)

  it('names a module by package, then the first directory below the source root', () => {
    expect(moduleOf('rust-executor/src/perspectives/mod.rs').module).toBe('rust-executor/src/perspectives')
    expect(moduleOf('rust-executor/src/perspectives/auto/claim.rs').module).toBe('rust-executor/src/perspectives')
    expect(moduleOf('core/src/model/Ad4mModel.ts')).toEqual({ module: 'core/src/model', label: 'core/src/model' })
  })

  it('stops at the deepest directory a file has', () => {
    expect(moduleOf('rust-executor/src/main.rs').module).toBe('rust-executor/src')
    expect(moduleOf('rust-executor/build.rs').module).toBe('rust-executor')
  })

  it('counts a directory that is not a source root towards the depth', () => {
    expect(moduleOf('core/scripts/gen/x.ts').module).toBe('core/scripts')
  })

  it('uses the repo root for files under no manifest, and "." for a top-level file', () => {
    expect(moduleOf('tools/run.ts').module).toBe('tools')
    expect(moduleOf('docs/guide/a.ts').module).toBe('docs')
    expect(moduleOf('README.ts').module).toBe('.')
  })

  it('goes deeper with a larger depth', () => {
    expect(directoryModules(packages, 2)('rust-executor/src/perspectives/auto/claim.rs').module).toBe(
      'rust-executor/src/perspectives/auto'
    )
  })
})
