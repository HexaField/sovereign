// Thin wrapper over the `codegraph` CLI. Each call is a short process on
// codegraph's own bundled runtime (~0.1 s for a sync with nothing to do), so
// the index always matches the installed codegraph version and a crash stays
// inside that one process.

import { execFile, spawn } from 'node:child_process'

const RUN_TIMEOUT_MS = 5 * 60_000
const STDERR_TAIL = 2_000

export interface CodegraphCli {
  /** The installed version, or null when the binary is missing or broken. */
  version(): Promise<string | null>
  /** Runs `codegraph <args>`. Rejects with the stderr tail on a non-zero exit. */
  run(args: string[]): Promise<void>
}

export function createCodegraphCli(bin = 'codegraph'): CodegraphCli {
  return {
    version: () =>
      new Promise((resolve) => {
        execFile(bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
          resolve(err ? null : stdout.trim().split('\n')[0] || null)
        })
      }),

    run: (args) =>
      new Promise((resolve, reject) => {
        // stdin closed: a prompt must never wait on input that cannot arrive.
        const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (d: Buffer) => {
          stderr = (stderr + d.toString()).slice(-STDERR_TAIL)
        })
        const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS)
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on('close', (code, signal) => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(stderr.trim() || `codegraph ${args[0]} exited with ${signal ?? code}`))
        })
      })
  }
}
