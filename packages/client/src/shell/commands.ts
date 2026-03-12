import type { Command } from './types.js'

const commands: Map<string, Command> = new Map()

export function registerCommand(cmd: Command): void {
  commands.set(cmd.id, cmd)
}

export function getCommands(): Command[] {
  return Array.from(commands.values())
}

export function executeCommand(id: string): boolean {
  const cmd = commands.get(id)
  if (!cmd) return false
  cmd.action()
  return true
}

/** Simple fuzzy match: all query chars must appear in order in the target */
function fuzzyMatch(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  let score = 0
  let lastMatchIdx = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Consecutive matches score higher
      score += lastMatchIdx === ti - 1 ? 2 : 1
      lastMatchIdx = ti
      qi++
    }
  }
  return qi === q.length ? score : -1
}

export function searchCommands(query: string): Command[] {
  if (!query) return getCommands()
  const results: Array<{ cmd: Command; score: number }> = []
  for (const cmd of commands.values()) {
    const labelScore = fuzzyMatch(query, cmd.label)
    const catScore = cmd.category ? fuzzyMatch(query, cmd.category) : -1
    const best = Math.max(labelScore, catScore)
    if (best > 0) {
      results.push({ cmd, score: best })
    }
  }
  results.sort((a, b) => b.score - a.score)
  return results.map((r) => r.cmd)
}

export function clearCommands(): void {
  commands.clear()
}
