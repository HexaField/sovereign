// Builds the CodeGraph index of a temporary checkout (the two sides of a
// change), with the codegraph CLI of the version the reader is pinned to.
//
// Always a full index, never `codegraph sync`: measured on ad4m (22k nodes),
// a sync after checking out a PR head held 373 fewer edges than a fresh index
// of the same tree (108,982 vs 109,355), and a diff between a synced and a
// fresh index would report those as changes. A full index costs 4-6 s there.

import { spawn } from 'node:child_process'
import { codegraphCommand, hasCodegraphIndex } from './codegraph.js'

export interface Indexer {
  /** Indexes `dir` from scratch: `init` the first time, `index` (a full rebuild) after a checkout moved */
  index(dir: string): Promise<void>
}

export interface CodegraphIndexerOptions {
  /** Runs the CLI under `nice -n 19` where `nice` exists (not Windows). Default true */
  lowPriority?: boolean
  /** Default: this package's pinned codegraph (`codegraphCommand`) */
  command?: { command: string; args: string[] }
}

export function createCodegraphIndexer(opts: CodegraphIndexerOptions = {}): Indexer {
  const nice = (opts.lowPriority ?? true) && process.platform !== 'win32'
  return {
    index: (dir) => {
      const cli = opts.command ?? codegraphCommand()
      const verb = hasCodegraphIndex(dir) ? 'index' : 'init'
      const args = [...cli.args, ...(verb === 'index' ? ['index', '-q', dir] : ['init', dir])]
      const [command, argv] = nice ? ['nice', ['-n', '19', cli.command, ...args]] : [cli.command, args]
      return new Promise<void>((resolve, reject) => {
        const child = spawn(command, argv, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (d: Buffer) => {
          stderr = (stderr + d.toString()).slice(-2000)
        })
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0 && hasCodegraphIndex(dir)) resolve()
          else reject(new Error(`codegraph ${verb} ${dir} exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}`))
        })
      })
    }
  }
}
