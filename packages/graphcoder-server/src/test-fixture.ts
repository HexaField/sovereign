// Test support: a copy of the tiny-ts fixture project, committed to git and
// indexed by the real `codegraph` CLI, in a fresh temporary directory.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const hasCodegraphCli = spawnSync('codegraph', ['--version']).status === 0

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-fixtures/tiny-ts')

export function indexedFixture(): { root: string; repo: string; cleanup(): void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphcoder-fixture-')))
  const repo = path.join(root, 'tiny-ts')
  fs.cpSync(FIXTURE, repo, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore'
    })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-qm', 'fixture')
  execFileSync('codegraph', ['init', repo], { stdio: 'ignore' })
  return { root, repo, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** `codegraph status -j`: the CLI's own counts, to check the reader against */
export function cliStatus(repo: string): {
  nodeCount: number
  edgeCount: number
  fileCount: number
  nodesByKind: Record<string, number>
} {
  return JSON.parse(execFileSync('codegraph', ['status', '-j', repo], { encoding: 'utf-8' }))
}
