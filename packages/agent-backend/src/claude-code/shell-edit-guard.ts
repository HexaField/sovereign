// NOT WIRED IN. Josh disabled the deny hook (2026-10-05): shell edits are
// sometimes warranted, and a hard block is too blunt. The parser stays as the
// candidate first layer of a future decision gate (rules, then possibly a
// Jev-like decision model). Until then the bash-first steer is off and the
// batch edit tools exist; tool-usage metrics show whether that is enough.
//
// Spots Bash commands that edit files: sed/perl/ruby/awk in place,
// cat/echo/printf/tee writing content to a path, and Python/Node/Deno/Bun/
// Ruby code that writes files. Such edits fail silently (a replace that
// matches nothing still exits 0) and skip the diff review the edit tools
// give. Scratch files under /tmp stay allowed, as do output redirects of
// other commands and everything that only reads, searches or runs.
//
// The command is tokenised (shell-quote), so quoted text — a commit message
// that mentions `sed -i`, an `echo "a -> b"` — is never read as syntax.
// Limits: a script written to /tmp and then run, or a file built in /tmp and
// copied over with cp/mv, is not inspected.

import path from 'node:path'
import { parse, type ParseEntry } from 'shell-quote'

/** Content-writing commands whose redirect target is the file being authored. */
const AUTHORING = new Set(['cat', 'echo', 'printf'])
/** Words that run the command after them. */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nice', 'nohup', 'time', 'xargs', 'exec'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
const INTERPRETER = /^(?:python[\d.]*|node|deno|bun|ruby)$/

interface Redirect {
  op: string
  target: string
}

interface SimpleCommand {
  words: string[]
  redirects: Redirect[]
  /** Heredoc bodies and here-strings fed to the command's stdin. */
  stdin: string[]
  /** The command whose output this one reads through a pipe. */
  pipedFrom?: string
}

/** What the guard knows while walking one command line. */
interface Context {
  /** The directory a `cd` moved to, when it is known. */
  cwd?: string
  scratchVars: Set<string>
}

/**
 * Why `command` edits files through the shell, or undefined when it does not.
 * The reason names the idiom; the caller adds what to use instead.
 */
export function shellEditReason(command: string): string | undefined {
  const { text, heredocs } = preprocess(command)
  let tokens: ParseEntry[]
  try {
    tokens = parse(text, (name) => `$${name}`)
  } catch {
    return undefined
  }
  // Variables holding a mktemp path count as scratch: T=$(mktemp -d).
  const scratchVars = new Set([...command.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=\$\(\s*mktemp\b/g)].map((m) => m[1]))
  const ctx: Context = { scratchVars }
  for (const cmd of simpleCommands(tokens, heredocs)) {
    const reason = commandReason(cmd, ctx)
    if (reason) return reason
  }
  return undefined
}

/** The deny message the PreToolUse hook returns to the model. */
export function shellEditDenial(reason: string): string {
  return (
    `Sovereign blocks file edits through the shell (${reason}): they fail silently and skip the diff review. ` +
    `Use mcp__code__edit, or mcp__code__edit_files for several files at once; for repeated changes use its ` +
    `replace_all op with the expected count. Edit and Write also work. Shell writes stay allowed for scratch ` +
    `files under /tmp (scripts must name the /tmp path as a literal), and reading, searching and running commands ` +
    `are unaffected.`
  )
}

function commandReason(cmd: SimpleCommand, ctx: Context): string | undefined {
  const words = unwrap(cmd.words)
  if (words.length === 0) return undefined
  const name = path.posix.basename(words[0])
  const args = words.slice(1)
  const scratchy = (target: string) => scratch(target, ctx)

  if (name === 'cd') {
    const dir = args.find((w) => !w.startsWith('-'))
    ctx.cwd = dir === undefined ? undefined : dir.startsWith('/') ? dir : ctx.cwd && path.posix.join(ctx.cwd, dir)
    return undefined
  }

  // In-place editors pass only when every file they edit is scratch.
  const inPlace = (programOptions: string[], reason: string, words = args) => {
    const edited = editedFiles(words, programOptions)
    return edited.length > 0 && edited.every(scratchy) ? undefined : reason
  }
  if ((name === 'sed' || name === 'gsed') && args.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place')))
    return inPlace(['-e', '--expression', '-f', '--file'], 'sed -i edits a file in place')
  if (name === 'perl' && args.some((w) => /^-(?![MmIx])\w*i/.test(w)))
    return inPlace(['-e', '-E'], 'perl -i edits a file in place')
  if (name === 'ruby' && args.some((w) => /^-(?![rIC])\w*i/.test(w)))
    return inPlace(['-e'], 'ruby -i edits a file in place')
  if (
    (name === 'awk' || name === 'gawk') &&
    args.some((w, i) => w === '-iinplace' || w === '--include=inplace' || (w === '-i' && args[i + 1] === 'inplace'))
  )
    return inPlace(
      ['-f'],
      'awk -i inplace edits a file in place',
      args.filter(
        (w, i) =>
          !['-iinplace', '--include=inplace'].includes(w) &&
          !(w === '-i' && args[i + 1] === 'inplace') &&
          !(w === 'inplace' && args[i - 1] === '-i')
      )
    )

  if (SHELLS.has(name)) {
    const at = args.indexOf('-c')
    if (at !== -1 && args[at + 1] !== undefined) return shellEditReason(args[at + 1])
  }

  if (AUTHORING.has(name)) {
    const target = cmd.redirects.find((r) => !scratchy(r.target))?.target
    if (target !== undefined) return `${name} writes content to ${target}`
  }

  if (name === 'tee' && (cmd.stdin.length > 0 || (cmd.pipedFrom !== undefined && AUTHORING.has(cmd.pipedFrom)))) {
    const target = args.find((w) => !w.startsWith('-') && !scratchy(w))
    if (target !== undefined) return `tee writes content to ${target}`
  }

  if (INTERPRETER.test(name)) {
    for (const source of [...interpreterCode(name, args), ...cmd.stdin]) {
      const target = scriptWriteTargets(source).find((t) => t === null || !scratchy(t))
      if (target !== undefined) return `a ${name} script writes ${target ?? 'a file named by a variable'}`
    }
  }
  return undefined
}

/**
 * The files an in-place editor edits: its operands, minus the values of the
 * options that give the program, and minus the first operand (the program
 * itself) when no such option was used.
 */
function editedFiles(args: string[], programOptions: string[]): string[] {
  const operands: string[] = []
  let given = false
  for (let i = 0; i < args.length; i++) {
    if (programOptions.includes(args[i])) {
      given = true
      i++
    } else if (programOptions.some((o) => o.startsWith('--') && args[i].startsWith(`${o}=`))) given = true
    else if (!args[i].startsWith('-') || args[i] === '-') operands.push(args[i])
  }
  return given ? operands : operands.slice(1)
}

/** Drops leading VAR=value words and wrappers such as sudo or xargs, with their options. */
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

/** The inline code an interpreter runs: python -c, node/bun/ruby -e, deno eval. */
function interpreterCode(name: string, args: string[]): string[] {
  const flags = name.startsWith('python') ? ['-c'] : ['-e', '--eval', '-p', '--print']
  const code: string[] = []
  args.forEach((w, i) => {
    if (flags.includes(w) && args[i + 1] !== undefined) code.push(args[i + 1])
  })
  if (name === 'deno' && args[0] === 'eval' && args[1] !== undefined) code.push(args[1])
  return code
}

/** Every file a script writes: the literal path, or null when an expression names it. */
function scriptWriteTargets(code: string): Array<string | null> {
  const targets: Array<string | null> = []
  const collect = (pattern: RegExp) => {
    for (const m of code.matchAll(pattern)) targets.push(m[2] ?? null)
  }
  // Python open(path, 'w' | 'a' | 'x' | 'r+' …)
  collect(/\bopen\(\s*(?:(['"])([^'"]*)\1|[^,)]+)\s*,\s*(?:mode\s*=\s*)?(['"])[rbt]*[wax+][rbt+]*\3\s*[,)]/g)
  // Python pathlib: Path('/x').write_text(…), or p.write_text(…)
  collect(/(?:Path\(\s*(['"])([^'"]*)\1\s*\)|[\w\])]+)\.write_(?:text|bytes)\(/g)
  // Node fs, Deno and Bun writes.
  collect(
    /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|writeTextFileSync|writeTextFile|Bun\.write)\(\s*(?:(['"`])([^'"`]*)\1|[^,)]+)/g
  )
  // Ruby File.write
  collect(/\bFile\.write\(\s*(?:(['"])([^'"]*)\1|[^,)]+)/g)
  return targets
}

/** Paths a shell may write freely: /tmp, /dev, /proc, $TMPDIR, mktemp results, and anything below them. */
function scratch(target: string, ctx: Context): boolean {
  const variable = /^\$\{?([A-Za-z_]\w*)/.exec(target)
  if (variable) return variable[1] === 'TMPDIR' || ctx.scratchVars.has(variable[1])
  const absolute = target.startsWith('/') ? target : ctx.cwd ? path.posix.join(ctx.cwd, target) : undefined
  if (absolute === undefined) return false
  const p = path.posix.normalize(absolute)
  return p === '/dev/null' || /^\/(?:tmp|dev|proc)\//.test(p)
}

/**
 * Prepares a command for the tokeniser, outside quotes only: newlines become
 * `;` (shell-quote reads them as spaces), heredoc bodies are lifted out in
 * order, `$(( … ))` arithmetic is dropped, and `>|` becomes `>`.
 */
function preprocess(command: string): { text: string; heredocs: string[] } {
  let out = ''
  const heredocs: string[] = []
  const pending: Array<{ delimiter: string; tabs: boolean }> = []
  let quote: "'" | '"' | undefined
  let i = 0
  while (i < command.length) {
    const c = command[i]
    if (quote) {
      out += c
      if (quote === '"' && c === '\\' && i + 1 < command.length) out += command[++i]
      else if (c === quote) quote = undefined
      i++
    } else if (c === "'" || c === '"') {
      quote = c
      out += c
      i++
    } else if (c === '\\' && i + 1 < command.length) {
      out += c + command[i + 1]
      i += 2
    } else if (command.startsWith('$((', i)) {
      const end = command.indexOf('))', i + 3)
      i = end === -1 ? command.length : end + 2
      out += '0'
    } else if (command.startsWith('>|', i)) {
      out += '>'
      i += 2
    } else if (command.startsWith('<<<', i)) {
      out += '<<<'
      i += 3
    } else if (command.startsWith('<<', i)) {
      const m = /^<<(-?)\s*(?:\\|(['"]))?([A-Za-z_][\w-]*)\2?/.exec(command.slice(i))
      if (m) {
        pending.push({ delimiter: m[3], tabs: m[1] === '-' })
        out += `<< ${m[3]}`
        i += m[0].length
      } else {
        out += '<<'
        i += 2
      }
    } else if (c === '\n') {
      i++
      for (const doc of pending.splice(0)) {
        const body: string[] = []
        while (i < command.length) {
          const eol = command.indexOf('\n', i)
          const line = command.slice(i, eol === -1 ? command.length : eol)
          i = eol === -1 ? command.length : eol + 1
          if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
          body.push(line)
        }
        heredocs.push(body.join('\n'))
      }
      out += ' ; '
    } else {
      out += c
      i++
    }
  }
  return { text: out, heredocs }
}

/** Splits tokens into simple commands with their redirects and stdin. */
function simpleCommands(tokens: ParseEntry[], heredocs: string[]): SimpleCommand[] {
  const commands: SimpleCommand[] = []
  let cur: SimpleCommand = { words: [], redirects: [], stdin: [] }
  let heredocIndex = 0
  const flush = (pipe: boolean) => {
    if (cur.words.length || cur.redirects.length) commands.push(cur)
    const pipedFrom = pipe && cur.words.length ? path.posix.basename(unwrap(cur.words)[0] ?? '') : undefined
    cur = { words: [], redirects: [], stdin: [], pipedFrom }
  }
  const word = (t: ParseEntry | undefined): string | undefined =>
    typeof t === 'string' ? t : t && typeof t === 'object' && 'pattern' in t ? String(t.pattern) : undefined
  const opOf = (t: ParseEntry | undefined): string | undefined =>
    t && typeof t === 'object' && 'op' in t ? String(t.op) : undefined

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const w = word(t)
    if (w !== undefined) {
      cur.words.push(w)
      continue
    }
    const op = opOf(t)
    if (op === undefined) continue // a comment
    const nextOp = opOf(tokens[i + 1])
    if (op === '&' && (nextOp === '>' || nextOp === '>>')) {
      // &> and &>>: stdout and stderr to a file.
      const target = word(tokens[i + 2])
      if (target !== undefined) cur.redirects.push({ op: nextOp, target })
      i += 2
    } else if (op === '>' || op === '>>') {
      // `2>file` arrives as the word "2" then `>`; stderr is not content.
      if (cur.words[cur.words.length - 1] === '2') cur.words.pop()
      else {
        const target = word(tokens[i + 1])
        if (target !== undefined) cur.redirects.push({ op, target })
      }
      i++
    } else if (op === '>&') {
      if (cur.words[cur.words.length - 1] === '2') cur.words.pop()
      i++
    } else if (op === '<' && nextOp === '<') {
      // A heredoc, `<< DELIM` after preprocess; its body was lifted out in order.
      cur.stdin.push(heredocs[heredocIndex++] ?? '')
      i += 2
    } else if (op === '<<<') {
      const content = word(tokens[i + 1])
      if (content !== undefined) cur.stdin.push(content)
      i++
    } else if (op === '<' || op === '<(' || op === '>(') {
      i++
    } else {
      flush(op === '|' || op === '|&')
    }
  }
  flush(false)
  return commands
}
