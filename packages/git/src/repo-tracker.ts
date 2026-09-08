// Tracks which git repos a thread's agent has touched via tool call paths.
// Listens to work items (tool calls), extracts file paths from inputs,
// resolves each to a repo root, and maintains a per-thread set of repo roots.
//
// This replaces workspace-based resolution — the diff viewer shows repos
// the agent actually worked in, not every repo in an org.

import path from 'node:path'
import type { GitCli } from './git.js'

/** Extract absolute file paths from a tool call's input JSON. */
export function extractPaths(toolName: string | undefined, input: string | undefined): string[] {
  if (!toolName || !input) return []

  const paths: string[] = []

  try {
    const parsed = JSON.parse(input)

    // Read, Edit, Write — file_path field
    if (['Read', 'read_file', 'Edit', 'edit_file', 'Write', 'write_file'].includes(toolName)) {
      if (typeof parsed.file_path === 'string' && path.isAbsolute(parsed.file_path)) {
        paths.push(parsed.file_path)
      }
    }

    // Grep, Glob — path field
    if (['Grep', 'Glob', 'grep', 'glob'].includes(toolName)) {
      if (typeof parsed.path === 'string' && path.isAbsolute(parsed.path)) {
        paths.push(parsed.path)
      }
    }

    // Bash — extract paths from the command string
    if (['Bash', 'bash'].includes(toolName)) {
      const cmd = typeof parsed.command === 'string' ? parsed.command : ''
      // Look for `cd /absolute/path` patterns
      const cdMatches = cmd.matchAll(/\bcd\s+(\/[^\s;&|]+)/g)
      for (const m of cdMatches) paths.push(m[1])
      // Look for absolute paths as arguments (common in git, npm, etc.)
      const argMatches = cmd.matchAll(/(?:^|\s)(\/(?:home|tmp|var|opt|usr|etc|workspaces)[^\s;&|"']*)/g)
      for (const m of argMatches) paths.push(m[1])
    }

    // codegraph_explore — projectPath
    if (toolName.includes('codegraph')) {
      if (typeof parsed.projectPath === 'string' && path.isAbsolute(parsed.projectPath)) {
        paths.push(parsed.projectPath)
      }
    }

    // semble search / find_related — repo field
    if (toolName.includes('semble')) {
      if (typeof parsed.repo === 'string' && path.isAbsolute(parsed.repo)) {
        paths.push(parsed.repo)
      }
    }
  } catch {
    // Input not valid JSON — skip
  }

  return paths
}

export interface RepoTracker {
  /** Get the set of repo roots the thread has touched. */
  getRepos(threadId: string): string[]
  /** Process a work item from the bus and track any repo roots found. */
  trackWorkItem(threadId: string, toolName: string | undefined, input: string | undefined): Promise<void>
  /**
   * Seed repos from history log messages. Call once per thread on first access
   * to populate the tracker from prior tool calls (survives server restarts).
   * Messages should be raw history log entries (ChatMessage-shaped objects).
   */
  seedFromHistory(threadId: string, messages: unknown[]): Promise<void>
  /** Check whether a thread has already been seeded (to avoid re-scanning). */
  hasSeeded(threadId: string): boolean
}

export function createRepoTracker(gitCli: GitCli): RepoTracker {
  // threadId → Set of resolved repo roots
  const tracked = new Map<string, Set<string>>()
  // path → resolved repo root (or null if not in a repo). Cache avoids repeat git calls.
  const repoRootCache = new Map<string, string | null>()

  async function resolveRepoRoot(filePath: string): Promise<string | null> {
    // Resolve to directory — if it looks like a file, use its parent
    const dir = filePath.includes('.') ? path.dirname(filePath) : filePath
    if (repoRootCache.has(dir)) return repoRootCache.get(dir)!

    const root = await gitCli.repoRoot(dir)
    repoRootCache.set(dir, root)
    // Also cache the root itself for faster future lookups
    if (root) repoRootCache.set(root, root)
    return root
  }

  const seeded = new Set<string>()

  async function trackPaths(threadId: string, paths: string[]): Promise<void> {
    if (!paths.length) return

    let threadRepos = tracked.get(threadId)
    if (!threadRepos) {
      threadRepos = new Set()
      tracked.set(threadId, threadRepos)
    }

    for (const p of paths) {
      try {
        const root = await resolveRepoRoot(p)
        if (root) threadRepos.add(root)
      } catch {
        // Can't resolve — skip silently
      }
    }
  }

  return {
    getRepos(threadId: string): string[] {
      const repos = tracked.get(threadId)
      return repos ? [...repos] : []
    },

    async trackWorkItem(threadId: string, toolName: string | undefined, input: string | undefined): Promise<void> {
      const paths = extractPaths(toolName, input)
      await trackPaths(threadId, paths)
    },

    async seedFromHistory(threadId: string, messages: unknown[]): Promise<void> {
      if (seeded.has(threadId)) return
      seeded.add(threadId)

      // Extract tool calls from history messages. History log entries follow
      // the ChatMessage shape — role: 'assistant' messages contain content
      // blocks with type: 'tool_use', and work items have name + input.
      for (const msg of messages) {
        const m = msg as Record<string, unknown>

        // SDK-style: content blocks with tool_use entries
        if (Array.isArray(m.content)) {
          for (const block of m.content) {
            const b = block as Record<string, unknown>
            if (b.type === 'tool_use' && typeof b.name === 'string') {
              const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? '')
              const paths = extractPaths(b.name, input)
              await trackPaths(threadId, paths)
            }
          }
        }

        // Work-item style: direct name + input fields
        if (typeof m.name === 'string' && m.input !== undefined) {
          const input = typeof m.input === 'string' ? m.input : JSON.stringify(m.input)
          const paths = extractPaths(m.name, input)
          await trackPaths(threadId, paths)
        }
      }
    },

    hasSeeded(threadId: string): boolean {
      return seeded.has(threadId)
    }
  }
}
