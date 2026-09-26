// Seed templates for Sovereign-managed Claude Code files. These functions
// are init-only: they write a starter file when one is missing and never
// touch existing content.
//
// The personality itself (the global `~/.claude/CLAUDE.md`) is owned by the
// personality compiler — see `personality-compiler.ts`. The functions here
// only seed the workspace-local layered-context file and the default
// subagent definition, and check the user's agent definitions.

import fs from 'node:fs'
import path from 'node:path'

const WORKSPACE_LAYERED_BODY = `# Sovereign workspace context

Workspace-local Claude Code context. Read via cwd walk-up alongside the
global \`~/.claude/CLAUDE.md\` (assembled by Sovereign's personality
compiler). Edit freely — this file is seeded once and never rewritten.
`

const SUBAGENT_TEMPLATE = `---
name: sovereign-default-subagent
description: General-purpose helper subagent. Spawned when the main agent delegates focused work (research, code edits, multi-step investigations). Inherits the parent's tools by default.
---

You are a Sovereign subagent. Complete the task the parent agent gave you.

- Be terse — one to three short paragraphs unless the task explicitly asks for more.
- Return the work product directly. No "I'll start by…" preamble.
- If the task is ambiguous, do the most plausible interpretation and note any
  assumptions at the end.
- When you need to mutate Sovereign state (issues, planning, etc.), use the
  \`sovereign.*\` MCP tools.
`

/**
 * Write `${cwd}/.claude/CLAUDE.md` as a one-time seed. Existing user files
 * are left strictly alone — Sovereign does not own or rewrite the workspace's
 * layered-context file.
 */
export function ensureLayeredContextFile(cwd: string): void {
  const dir = path.join(cwd, '.claude')
  const filePath = path.join(dir, 'CLAUDE.md')
  if (fs.existsSync(filePath)) return
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, WORKSPACE_LAYERED_BODY)
}

/**
 * Write `${cwd}/.claude/agents/sovereign-default-subagent.md` if missing.
 */
export function ensureDefaultSubagentFile(cwd: string): void {
  const dir = path.join(cwd, '.claude', 'agents')
  const filePath = path.join(dir, 'sovereign-default-subagent.md')
  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(filePath)) return
  fs.writeFileSync(filePath, SUBAGENT_TEMPLATE)
}

/** An agent definition whose `model:` a Claude session cannot reach. */
export interface UnreachableAgentModel {
  file: string
  name: string
  model: string
}

// `model:` values the CLI resolves to a Claude model, in any case: the aliases,
// `inherit`, or a `claude-` id, optionally with a `[1m]`-style suffix.
const CLAUDE_AGENT_MODEL =
  /^(?:anthropic\/)?(?:claude-[\w.-]+|opus|sonnet|haiku|fable|best|opusplan|default|inherit)(?:\[[^\]]*\])?$/i

/**
 * User-level agent definitions (`<agentDir>/agents/**\/*.md`) whose `model:` a
 * Claude session cannot reach. In-process subagents use the parent's API
 * endpoint, and a Claude parent calls Anthropic directly — so a local model
 * named here fails every call with HTTP 404. Like the CLI, skips files that
 * lack `name` or `description`.
 */
export function findUnreachableAgentModels(agentDir: string): UnreachableAgentModel[] {
  const dir = path.join(agentDir, 'agents')
  let files: string[]
  try {
    files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const found: UnreachableAgentModel[] = []
  for (const f of files) {
    const file = path.join(dir, f)
    let head: string | undefined
    try {
      head = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(fs.readFileSync(file, 'utf8'))?.[1]
    } catch {
      continue // a directory named *.md, or unreadable
    }
    if (!head) continue
    const fm = head
    const field = (key: string) =>
      new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*(?:#.*)?$`, 'm').exec(fm)?.[1].replace(/^(['"])(.*)\1$/, '$2')
    const name = field('name')
    const model = field('model')
    if (!name || !field('description') || !model || CLAUDE_AGENT_MODEL.test(model)) continue
    found.push({ file, name, model })
  }
  return found
}

/**
 * Ensure AD4M skill is available to Claude Code via symlink.
 *
 * If `<configDir>/skills/ad4m` exists and `<agentDir>/skills/ad4m` does not,
 * creates a symlink so Claude Code discovers the skill automatically. Called
 * only when AD4M integration is configured.
 */
export function ensureAd4mSkill(configDir: string, agentDir: string): void {
  if (!configDir || !agentDir) return
  const source = path.join(configDir, 'skills', 'ad4m')
  const target = path.join(agentDir, 'skills', 'ad4m')
  if (!fs.existsSync(source)) return
  if (fs.existsSync(target)) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.symlinkSync(source, target)
}
