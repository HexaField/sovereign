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
  if (repo) parts.push(`# Repo context (${repo.file})\n\n${repo.text}`)
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
