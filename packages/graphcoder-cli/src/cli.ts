// The `graphcoder` command line. It opens a checkout's `.codegraph` index
// directly, with no Sovereign and no server, so it runs in CI and in a plain
// terminal. Exit codes: 0 done, 2 error or bad usage (1 stays free for checks
// that find problems).

import fs from 'node:fs'
import path from 'node:path'
import { hasCodegraphIndex, openCodegraphIndex } from '@sovereign/graphcoder-server/codegraph'

export interface CliIo {
  out(text: string): void
  err(text: string): void
  cwd: string
}

export const EXIT_OK = 0
export const EXIT_ERROR = 2

const USAGE = [
  'Usage: graphcoder <command> [options]',
  '',
  'Commands:',
  '  stats [path] [--json]   Node, edge and file counts of the checkout holding path (default: .)',
  '  help                    Show this help'
].join('\n')

/** The nearest directory at or above `start` that holds a CodeGraph index */
export function findIndexedRoot(start: string): string | null {
  let dir = path.resolve(start)
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir)
  for (;;) {
    if (hasCodegraphIndex(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function stats(args: string[], io: CliIo): number {
  const json = args.includes('--json')
  const unknown = args.filter((a) => a.startsWith('-') && a !== '--json')
  const positional = args.filter((a) => !a.startsWith('-'))
  if (unknown.length > 0 || positional.length > 1) {
    io.err(`graphcoder stats: unexpected ${[...unknown, ...positional.slice(1)].join(' ')}\n\n${USAGE}`)
    return EXIT_ERROR
  }
  const target = path.resolve(io.cwd, positional[0] ?? '.')
  const root = findIndexedRoot(target)
  if (!root) {
    io.err(`graphcoder stats: no CodeGraph index at or above ${target} (run \`codegraph init\` in the checkout)`)
    return EXIT_ERROR
  }
  const handle = openCodegraphIndex(root)
  try {
    const s = handle.stats()
    if (json) {
      io.out(JSON.stringify({ path: root, ...s }, null, 2))
    } else {
      const kinds = Object.entries(s.nodesByKind)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([kind, n]) => `${kind} ${n}`)
        .join(', ')
      io.out(
        [
          root,
          `  nodes  ${s.nodeCount}`,
          `  edges  ${s.edgeCount}`,
          `  files  ${s.fileCount}`,
          `  kinds  ${kinds}`
        ].join('\n')
      )
    }
  } finally {
    handle.close()
  }
  return EXIT_OK
}

/** Runs one command; resolves to the exit code */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...args] = argv
  try {
    switch (command) {
      case 'stats':
        return stats(args, io)
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(USAGE)
        return command === undefined ? EXIT_ERROR : EXIT_OK
      default:
        io.err(`graphcoder: unknown command ${command}\n\n${USAGE}`)
        return EXIT_ERROR
    }
  } catch (err) {
    io.err(`graphcoder ${command}: ${(err as Error).message}`)
    return EXIT_ERROR
  }
}
