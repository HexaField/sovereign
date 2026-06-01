// Seed templates for Sovereign-managed Claude Code files. These functions
// are init-only: they write a starter file when one is missing and never
// touch existing content.
//
// The personality itself (the global `~/.claude/CLAUDE.md`) is owned by the
// personality compiler — see `personality-compiler.ts`. The functions here
// only seed the workspace-local layered-context file and the default
// subagent definition.

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
