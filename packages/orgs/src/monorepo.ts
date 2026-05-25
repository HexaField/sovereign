import fs from 'node:fs'
import path from 'node:path'

export interface MonorepoInfo {
  tool: 'pnpm' | 'npm' | 'nx' | 'turborepo'
  packages: string[]
}

function globDirs(base: string, patterns: string[]): string[] {
  const results: string[] = []
  for (const pattern of patterns) {
    // Simple glob: only handle "dir/*" patterns
    const clean = pattern.replace(/\/\*$/, '')
    const dir = path.join(base, clean)
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'package.json'))) {
          results.push(path.join(clean, entry))
        }
      }
    }
  }
  return results
}

export function detectMonorepo(repoPath: string): MonorepoInfo | null {
  // pnpm-workspace.yaml
  const pnpmWs = path.join(repoPath, 'pnpm-workspace.yaml')
  if (fs.existsSync(pnpmWs)) {
    const content = fs.readFileSync(pnpmWs, 'utf-8')
    const patterns: string[] = []
    // Simple yaml parse for packages array
    const lines = content.split('\n')
    let inPackages = false
    for (const line of lines) {
      if (line.startsWith('packages:')) {
        inPackages = true
        continue
      }
      if (inPackages && /^\s+-\s+/.test(line)) {
        const val = line.replace(/^\s+-\s+/, '').replace(/['"\s]/g, '')
        if (val) patterns.push(val)
      } else if (inPackages && /^\S/.test(line)) {
        break
      }
    }
    return { tool: 'pnpm', packages: globDirs(repoPath, patterns) }
  }

  // package.json workspaces
  const pkgJson = path.join(repoPath, 'package.json')
  if (fs.existsSync(pkgJson)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'))
    if (pkg.workspaces) {
      const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || []
      return { tool: 'npm', packages: globDirs(repoPath, patterns) }
    }
  }

  // nx.json
  if (fs.existsSync(path.join(repoPath, 'nx.json'))) {
    // Scan packages/ and apps/ by convention
    const patterns = ['packages/*', 'apps/*']
    return { tool: 'nx', packages: globDirs(repoPath, patterns) }
  }

  // turbo.json
  if (fs.existsSync(path.join(repoPath, 'turbo.json'))) {
    const patterns = ['packages/*', 'apps/*']
    return { tool: 'turborepo', packages: globDirs(repoPath, patterns) }
  }

  return null
}
