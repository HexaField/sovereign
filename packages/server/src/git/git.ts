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
    }
  }
}
