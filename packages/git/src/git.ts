import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitStatus, FileChange, CommitInfo } from './types.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 })
  return stdout
}

function parseStatusLines(lines: string[]): { staged: FileChange[]; modified: FileChange[]; untracked: string[] } {
  const staged: FileChange[] = []
  const modified: FileChange[] = []
  const untracked: string[] = []

  for (const line of lines) {
    if (!line) continue

    if (line.startsWith('# ')) continue

    if (line.startsWith('? ')) {
      untracked.push(line.slice(2))
      continue
    }

    if (line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1]
      // Format: 2 XY sub mH mI mW hH hI Xscore path\torigPath
      // Fields 0-8 are space-separated, field 9+ is "newpath\toldpath"
      // Rejoin from index 9 to handle paths with spaces
      const pathPart = parts.slice(9).join(' ')
      const tabIdx = pathPart.indexOf('\t')
      const newPath = pathPart.substring(0, tabIdx)
      const oldPath = pathPart.substring(tabIdx + 1)

      if (xy[0] === 'R') {
        staged.push({ path: newPath, status: 'renamed', oldPath })
      } else if (xy[0] !== '.') {
        staged.push({ path: newPath, status: statusChar(xy[0]) })
      }
      if (xy[1] !== '.') {
        modified.push({ path: newPath, status: statusChar(xy[1]) })
      }
      continue
    }

    if (line.startsWith('1 ')) {
      const parts = line.split(' ')
      const xy = parts[1]
      const filePath = parts.slice(8).join(' ')

      if (xy[0] !== '.') {
        staged.push({ path: filePath, status: statusChar(xy[0]) })
      }
      if (xy[1] !== '.') {
        modified.push({ path: filePath, status: statusChar(xy[1]) })
      }
      continue
    }
  }

  return { staged, modified, untracked }
}

function statusChar(c: string): 'added' | 'modified' | 'deleted' | 'renamed' {
  switch (c) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    default:
      return 'modified'
  }
}

export interface GitCli {
  status(cwd: string): Promise<GitStatus>
  stage(cwd: string, paths: string[]): Promise<void>
  unstage(cwd: string, paths: string[]): Promise<void>
  commit(cwd: string, message: string): Promise<CommitInfo>
  push(cwd: string): Promise<void>
  pull(cwd: string): Promise<void>
  branches(cwd: string): Promise<string[]>
  checkout(cwd: string, branch: string, create?: boolean): Promise<void>
  log(cwd: string, limit?: number): Promise<CommitInfo[]>
  diff(cwd: string, path: string): Promise<string>
  /** Repo root for a path. Returns null when not inside a git repo. */
  repoRoot(cwd: string): Promise<string | null>
  /** Detect the default branch (main/master/dev). Checks remote HEAD first, falls back to common names. */
  defaultBranch(cwd: string): Promise<string>
  /** Merge-base (fork point) between HEAD and the given base branch. */
  mergeBase(cwd: string, baseBranch: string): Promise<string | null>
  /** Branch diff stat — files changed with addition/deletion counts relative to baseBranch.
   *  When baseBranch omitted, diffs working tree + staged against HEAD. */
  branchDiffStat(cwd: string, baseBranch?: string): Promise<FileChange[]>
  /** Unified diff for the full branch or a single file relative to baseBranch.
   *  When baseBranch omitted, returns working tree diff. */
  branchDiff(cwd: string, baseBranch?: string, filePath?: string): Promise<string>
  /** Remote URL for origin. Returns null when no remote exists. */
  remoteUrl(cwd: string): Promise<string | null>
  /** Number of commits HEAD sits ahead of baseBranch. */
  aheadCount(cwd: string, baseBranch: string): Promise<number>
  /** Unified diff for a single commit (commit vs its parent). */
  commitDiff(cwd: string, commitHash: string, filePath?: string): Promise<string>
  /** Commits on the current branch since mergeBase, newest first. */
  branchCommits(cwd: string, mergeBase: string, limit?: number): Promise<CommitInfo[]>
  /** Unified diff of all uncommitted changes (staged + unstaged) against HEAD. */
  uncommittedDiff(cwd: string, filePath?: string): Promise<string>
}

export function createGitCli(): GitCli {
  return {
    async status(cwd: string): Promise<GitStatus> {
      const output = await git(cwd, ['status', '--porcelain=v2', '--branch'])
      const lines = output.split('\n')

      let branch = ''
      let ahead = 0
      let behind = 0

      for (const line of lines) {
        if (line.startsWith('# branch.head ')) {
          branch = line.slice('# branch.head '.length)
        }
        if (line.startsWith('# branch.ab ')) {
          const match = line.match(/\+(\d+) -(\d+)/)
          if (match) {
            ahead = parseInt(match[1], 10)
            behind = parseInt(match[2], 10)
          }
        }
      }

      const { staged, modified, untracked } = parseStatusLines(lines)

      return { branch, ahead, behind, staged, modified, untracked }
    },

    async stage(cwd: string, paths: string[]): Promise<void> {
      await git(cwd, ['add', ...paths])
    },

    async unstage(cwd: string, paths: string[]): Promise<void> {
      await git(cwd, ['reset', 'HEAD', '--', ...paths])
    },

    async commit(cwd: string, message: string): Promise<CommitInfo> {
      await git(cwd, ['commit', '-m', message])
      const logOutput = await git(cwd, ['log', '-1', '--format=%H%n%h%n%s%n%an%n%aI'])
      const [hash, shortHash, msg, author, date] = logOutput.trim().split('\n')
      return { hash, shortHash, message: msg, author, date }
    },

    async push(cwd: string): Promise<void> {
      await execFileAsync('git', ['push'], { cwd })
    },

    async pull(cwd: string): Promise<void> {
      await execFileAsync('git', ['pull'], { cwd })
    },

    async branches(cwd: string): Promise<string[]> {
      const output = await git(cwd, ['branch', '--format=%(refname:short)'])
      return output.trim().split('\n').filter(Boolean)
    },

    async checkout(cwd: string, branch: string, create?: boolean): Promise<void> {
      const args = create ? ['checkout', '-b', branch] : ['checkout', branch]
      await git(cwd, args)
    },

    async log(cwd: string, limit = 20): Promise<CommitInfo[]> {
      const output = await git(cwd, ['log', `--max-count=${limit}`, '--format=%H%n%h%n%s%n%an%n%aI%n---'])
      const commits: CommitInfo[] = []
      const blocks = output.trim().split('\n---\n')
      for (const block of blocks) {
        const lines = block.trim().split('\n')
        if (lines.length >= 5) {
          commits.push({
            hash: lines[0],
            shortHash: lines[1],
            message: lines[2],
            author: lines[3],
            date: lines[4]
          })
        }
      }
      return commits
    },

    async diff(cwd: string, filePath: string): Promise<string> {
      const output = await git(cwd, ['diff', '--', filePath])
      return output
    },

    async repoRoot(cwd: string): Promise<string | null> {
      try {
        const output = await git(cwd, ['rev-parse', '--show-toplevel'])
        return output.trim()
      } catch {
        return null
      }
    },

    async defaultBranch(cwd: string): Promise<string> {
      // Try remote HEAD first
      try {
        const output = await git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
        const branch = output.split('/').pop()?.trim()
        if (branch) return branch
      } catch {
        // No remote HEAD configured — fall back
      }
      // Probe common branch names
      for (const branch of ['main', 'master', 'dev']) {
        try {
          await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
          return branch
        } catch {
          continue
        }
      }
      return 'main'
    },

    async mergeBase(cwd: string, baseBranch: string): Promise<string | null> {
      try {
        const output = await git(cwd, ['merge-base', 'HEAD', baseBranch])
        return output.trim() || null
      } catch {
        return null
      }
    },

    async branchDiffStat(cwd: string, baseBranch?: string): Promise<FileChange[]> {
      // Two git calls: --numstat for line counts, --name-status for status codes
      const range = baseBranch ? [`${baseBranch}...HEAD`] : []
      const [numstatOut, nameStatusOut] = await Promise.all([
        git(cwd, ['diff', '--numstat', '-M', ...range]),
        git(cwd, ['diff', '--name-status', '-M', ...range])
      ])

      // Parse --name-status into a map: path → status
      const statusMap = new Map<string, 'added' | 'modified' | 'deleted' | 'renamed'>()
      const renameMap = new Map<string, string>() // newPath → oldPath
      for (const line of nameStatusOut.trim().split('\n')) {
        if (!line) continue
        const parts = line.split('\t')
        const code = parts[0].charAt(0)
        if (code === 'R') {
          // Renamed: R100\toldPath\tnewPath
          const oldPath = parts[1]
          const newPath = parts[2]
          statusMap.set(newPath, 'renamed')
          renameMap.set(newPath, oldPath)
        } else {
          const filePath = parts[1]
          statusMap.set(filePath, statusChar(code))
        }
      }

      // Parse --numstat for line counts
      const files: FileChange[] = []
      for (const line of numstatOut.trim().split('\n')) {
        if (!line) continue
        const parts = line.split('\t')
        if (parts.length < 3) continue
        const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10)
        const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10)
        // For renames, numstat shows {oldPath => newPath} or just the new path
        let filePath = parts.slice(2).join('\t')
        // Handle rename notation: {old => new}/rest or old => new
        const renameMatch = filePath.match(/^(.*)?\{(.*?) => (.*?)\}(.*)$/)
        if (renameMatch) {
          filePath = (renameMatch[1] ?? '') + renameMatch[3] + (renameMatch[4] ?? '')
        }

        const status = statusMap.get(filePath) ?? 'modified'
        const entry: FileChange = { path: filePath, status, additions, deletions }
        const oldPath = renameMap.get(filePath)
        if (oldPath) entry.oldPath = oldPath
        files.push(entry)
      }

      return files
    },

    async branchDiff(cwd: string, baseBranch?: string, filePath?: string): Promise<string> {
      const args = ['diff', '-M']
      if (baseBranch) args.push(`${baseBranch}...HEAD`)
      if (filePath) args.push('--', filePath)
      return git(cwd, args)
    },

    async remoteUrl(cwd: string): Promise<string | null> {
      try {
        const output = await git(cwd, ['remote', 'get-url', 'origin'])
        return output.trim() || null
      } catch {
        return null
      }
    },

    async aheadCount(cwd: string, baseBranch: string): Promise<number> {
      try {
        const output = await git(cwd, ['rev-list', '--count', `${baseBranch}..HEAD`])
        return parseInt(output.trim(), 10) || 0
      } catch {
        return 0
      }
    },

    async commitDiff(cwd: string, commitHash: string, filePath?: string): Promise<string> {
      const args = ['diff', '-M', `${commitHash}~1`, commitHash]
      if (filePath) args.push('--', filePath)
      try {
        return await git(cwd, args)
      } catch {
        // First commit has no parent — diff against empty tree
        const args2 = ['diff', '-M', '--root', commitHash]
        if (filePath) args2.push('--', filePath)
        return git(cwd, args2)
      }
    },

    async branchCommits(cwd: string, mergeBase: string, limit?: number): Promise<CommitInfo[]> {
      const args = ['log', '--format=%H%n%h%n%s%n%an%n%ai%n%D', `${mergeBase}..HEAD`]
      if (limit) args.push(`-n`, `${limit}`)
      const output = await git(cwd, args)
      const lines = output.trim().split('\n')
      const commits: CommitInfo[] = []
      for (let i = 0; i + 5 < lines.length; i += 6) {
        const refs = lines[i + 5].trim()
        commits.push({
          hash: lines[i],
          shortHash: lines[i + 1],
          message: lines[i + 2],
          author: lines[i + 3],
          date: lines[i + 4],
          ...(refs ? { refs: refs.split(',').map((r) => r.trim()) } : {})
        })
      }
      return commits
    },

    async uncommittedDiff(cwd: string, filePath?: string): Promise<string> {
      const args = ['diff', '-M', 'HEAD']
      if (filePath) args.push('--', filePath)
      return git(cwd, args)
    }
  }
}
