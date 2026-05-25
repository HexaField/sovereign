// Claude Code encodes a cwd into a directory name under
// `~/.claude/projects/` by mapping the absolute path's filesystem separators
// to dashes. The exact algorithm is undocumented upstream but consistent in
// observed behavior: leading `/` is dropped, remaining `/` → `-`. We mirror
// the same encoding so we can resolve a session file from a cwd.

import path from 'node:path'

export function encodeCwdToProjectDir(cwd: string): string {
  const abs = path.resolve(cwd)
  // Empirical encoding (the algorithm is undocumented upstream): every
  // separator character — `/` AND `.` inside path segments — is replaced
  // with `-`. The leading `/` of an absolute POSIX path becomes the leading
  // `-`. So `/Users/josh/.openclaw/workspace` →
  // `-Users-josh--openclaw-workspace`. Verified against on-disk
  // `~/.claude/projects/` entries created by the CLI.
  return abs.replace(/[/.]/g, '-')
}

export function defaultAgentDir(home: string = process.env.HOME ?? ''): string {
  return path.join(home, '.claude')
}

export function sessionJsonlPath(agentDir: string, cwd: string, sessionId: string): string {
  return path.join(agentDir, 'projects', encodeCwdToProjectDir(cwd), `${sessionId}.jsonl`)
}

export function projectsDirForCwd(agentDir: string, cwd: string): string {
  return path.join(agentDir, 'projects', encodeCwdToProjectDir(cwd))
}
