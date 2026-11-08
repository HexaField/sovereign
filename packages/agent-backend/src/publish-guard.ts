// Blocks shell commands that give a repo a new destination or publish it:
// adding or changing a git remote, pushing to a URL or path instead of an
// existing remote, creating or forking a hosted repo, and Radicle identity,
// init, publish, seed, push or node start. Local repos stay local and private
// data stays private until the user does these steps themselves. Pushing a
// branch to a remote the repo already has stays allowed.
//
// The command is tokenised (shell-quote), so quoted text such as a commit
// message that mentions `git remote add` is never read as syntax.

import path from 'node:path'
import { parse, type ParseEntry } from 'shell-quote'

const WRAPPERS = new Set(['sudo', 'env', 'command', 'nice', 'nohup', 'time', 'xargs', 'exec'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
/** git options that take a value before the subcommand. */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const RAD_BLOCKED = new Set(['auth', 'init', 'publish', 'seed', 'push'])
/** A push target that is a URL or a path, not a remote name. */
const URL_OR_PATH = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/\s]+@[^:\s]+:|\/|\.\.?\/|~\/|file:)/i

/** Why `command` publishes a repo or changes where it goes, or undefined. */
export function publishReason(command: string): string | undefined {
  let tokens: ParseEntry[]
  try {
    tokens = parse(command.replace(/\n/g, ' ; '), (name) => `$${name}`)
  } catch {
    return undefined
  }
  for (const words of simpleCommands(tokens)) {
    const reason = commandReason(unwrap(words))
    if (reason) return reason
  }
  return undefined
}

/** The deny message returned to the model. */
export function publishDenial(reason: string): string {
  return (
    `Sovereign blocks this command (${reason}). Repos get no new remote and nothing is published from an agent: ` +
    `local repos stay local and private data stays private. Pushing a branch to a remote the repo already has is ` +
    `allowed. If this step is needed, stop and ask the user to do it.`
  )
}

function commandReason(words: string[]): string | undefined {
  if (words.length === 0) return undefined
  const name = path.posix.basename(words[0])
  const args = words.slice(1)

  if (SHELLS.has(name)) {
    const at = args.indexOf('-c')
    return at !== -1 && args[at + 1] !== undefined ? publishReason(args[at + 1]) : undefined
  }

  if (name === 'git') {
    let i = 0
    while (i < args.length && args[i].startsWith('-')) i += GIT_VALUE_OPTS.has(args[i]) ? 2 : 1
    const sub = args[i]
    const rest = args.slice(i + 1)
    if (sub === 'remote') {
      const action = rest.find((w) => !w.startsWith('-'))
      if (action && ['add', 'set-url', 'rename'].includes(action)) return `git remote ${action}`
    }
    if (sub === 'config') {
      // A write names the key and a value: `git config [--global] <key> <value>`.
      const [key, value] = rest.filter((w) => !w.startsWith('-'))
      const reading = rest.some((w) => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--unset'].includes(w))
      if (
        key &&
        value !== undefined &&
        !reading &&
        /^(?:remote\.[^.]+\.(?:url|pushurl)|url\..+\.(?:insteadof|pushinsteadof))$/i.test(key)
      )
        return `git config ${key}`
    }
    if (sub === 'push') {
      const target = rest.find((w) => !w.startsWith('-'))
      if (target && URL_OR_PATH.test(target)) return `git push to ${target}, not an existing remote`
    }
    if (sub === 'subtree' && rest[0] === 'push') return 'git subtree push'
    return undefined
  }

  if (name === 'gh' && args[0] === 'repo' && ['create', 'fork'].includes(args[1] ?? '')) return `gh repo ${args[1]}`

  if (name === 'rad') {
    if (RAD_BLOCKED.has(args[0] ?? '')) return `rad ${args[0]}`
    if (args[0] === 'node' && args[1] === 'start') return 'rad node start'
    if (args[0] === 'remote' && args[1] === 'add') return 'rad remote add'
  }
  return undefined
}

/** Drops leading VAR=value words and wrappers such as sudo, with their options. */
function unwrap(words: string[]): string[] {
  let i = 0
  for (;;) {
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++
    if (i < words.length && WRAPPERS.has(path.posix.basename(words[i]))) {
      i++
      while (i < words.length && words[i].startsWith('-')) i++
      continue
    }
    return words.slice(i)
  }
}

/** The words of each simple command; redirect targets are skipped. */
function simpleCommands(tokens: ParseEntry[]): string[][] {
  const out: string[][] = []
  let cur: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (typeof t === 'string') cur.push(t)
    else if ('pattern' in t) cur.push(String(t.pattern))
    else if ('op' in t) {
      if (['>', '>>', '<', '>&', '<(', '>('].includes(String(t.op))) i++
      else {
        if (cur.length) out.push(cur)
        cur = []
      }
    }
  }
  if (cur.length) out.push(cur)
  return out
}
