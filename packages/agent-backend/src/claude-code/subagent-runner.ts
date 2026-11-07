// Context and tool set for Sovereign's own subagents (`agents_spawn`).
//
// A child runs as an independent Claude Code session. Its system prompt is
// `<configDir>/SUBAGENT.md`, then the repo's AGENTS.md (or CLAUDE.md), then a
// short environment block — nothing else: no CLI preset, no global
// CLAUDE.md, no membrane, no auto-memory.

import fs from 'node:fs'
import path from 'node:path'

/** Built-in tools a child may call. No Agent: children never spawn children.
 *  WebFetch and WebSearch serve research children (deep-research researchers). */
export const SUBAGENT_BUILTIN_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch']

/** Built-in tools top-level sessions may not call: delegation goes through `agents_spawn`. */
export const MAIN_DISALLOWED_TOOLS = ['Agent', 'Task']

/** Tokens at which a subagent's SDK compacts mid-turn. A subagent works in
 *  one long turn, so the between-turn auto-recycle never runs for it; without
 *  this it grows towards the model's 1M window and re-reads it on every call.
 *  It must stay well above the subagent's starting prompt, or the SDK
 *  compacts again at once and aborts ("Autocompact is thrashing"): see
 *  REPO_CONTEXT_MAX_CHARS. */
export const SUBAGENT_AUTO_COMPACT_WINDOW = 200_000

/** MCP servers a child connects to, when configured. `sovereign` is the
 *  narrow subagent endpoint (browser + embeddings). */
export const SUBAGENT_MCP_SERVERS = ['codegraph', 'semble', 'code', 'sovereign']

/** Children running at once per parent session. */
export const MAX_SUBAGENTS_PER_PARENT = 4

/** Wall-clock limit for one child. */
export const SUBAGENT_TIMEOUT_MS = 240 * 60_000

/**
 * The nearest `AGENTS.md` (else `CLAUDE.md`) at or above `cwd`, stopping at
 * `stopAt`. The runner loads it itself because child sessions drop the CLI's
 * setting sources, and with them the CLI's own walk-up.
 */
export function findRepoContext(cwd: string, stopAt: string): { file: string; text: string } | null {
  let dir = path.resolve(cwd)
  const stop = path.resolve(stopAt)
  for (;;) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(dir, name)
      try {
        return { file, text: fs.readFileSync(file, 'utf8').trim() }
      } catch {
        /* try the next name, then the parent directory */
      }
    }
    const parent = path.dirname(dir)
    if (dir === stop || parent === dir) return null
    dir = parent
  }
}

/** Repo context goes into every call's prompt, so a large file costs on
 *  every call. Claude Code warns past the same size for a CLAUDE.md. WE's
 *  generated AGENTS.md runs to ~570k characters (~200k tokens): a subagent
 *  in WE started above its auto-compact window and thrashed. */
export const REPO_CONTEXT_MAX_CHARS = 40_000

/** The repo context, or its head plus where each left-out section starts. */
function fitRepoContext(file: string, text: string): string {
  if (text.length <= REPO_CONTEXT_MAX_CHARS) return text
  const cut = text.lastIndexOf('\n', REPO_CONTEXT_MAX_CHARS - 4_000)
  const head = text.slice(0, cut)
  const firstLine = head.split('\n').length + 1
  const index = text
    .slice(cut + 1)
    .split('\n')
    .map((line, i) => (/^#{1,2} /.test(line) ? `- line ${firstLine + i}: ${line}` : ''))
    .filter(Boolean)
  const n = (x: number) => x.toLocaleString('en-US')
  return [
    head,
    '',
    `[This repo context holds only its first ${n(head.length)} of ${n(text.length)} characters. ` +
      `Read the rest of ${file} by section when the task needs it. Sections left out:]`,
    ...index
  ].join('\n')
}

/** The child's system prompt: SUBAGENT.md, repo context, environment. */
export function buildSubagentSystemPrompt(opts: { configDir?: string; cwd: string; home: string; now?: Date }): string {
  const parts: string[] = []
  if (opts.configDir) {
    try {
      parts.push(fs.readFileSync(path.join(opts.configDir, 'SUBAGENT.md'), 'utf8').trim())
    } catch {
      /* no SUBAGENT.md: repo context and environment only */
    }
  }
  // ~/.sovereign holds the global personality sources, not repo context.
  const repo =
    opts.configDir && path.resolve(opts.cwd) === path.resolve(opts.configDir)
      ? null
      : findRepoContext(opts.cwd, opts.home)
  if (repo) parts.push(`# Repo context (${repo.file})\n\n${fitRepoContext(repo.file, repo.text)}`)
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10)
  parts.push(`# Environment\n\n- Working directory: ${opts.cwd}\n- Platform: ${process.platform}\n- Date: ${date}`)
  return parts.filter(Boolean).join('\n\n')
}

/**
 * MCP servers for a child: the configured servers plus the user-scope ones
 * from `~/.claude.json` (the child's `settingSources` no longer loads them),
 * filtered to {@link SUBAGENT_MCP_SERVERS}.
 */
export function selectSubagentMcpServers(configured: Record<string, any>, claudeJsonPath: string): Record<string, any> {
  let userScope: Record<string, any> = {}
  try {
    userScope = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')).mcpServers ?? {}
  } catch {
    /* no user-scope servers */
  }
  const all = { ...userScope, ...configured }
  const out: Record<string, any> = {}
  for (const name of SUBAGENT_MCP_SERVERS) if (all[name]) out[name] = all[name]
  return out
}
