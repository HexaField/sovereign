import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

export interface GitWorktreeEntry {
  worktree: string
  head: string
  branch?: string
  bare?: boolean
  detached?: boolean
}

export async function worktreeAdd(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch?: string
): Promise<void> {
  const args = ['worktree', 'add', '-b', branch, worktreePath]
  if (baseBranch) args.push(baseBranch)
  await git(repoPath, args)
}

export async function worktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', worktreePath, '--force'])
}

export async function worktreeList(repoPath: string): Promise<GitWorktreeEntry[]> {
  const output = await git(repoPath, ['worktree', 'list', '--porcelain'])
  if (!output) return []
  const entries: GitWorktreeEntry[] = []
  let current: Partial<GitWorktreeEntry> = {}
  for (const line of output.split('\n')) {
    if (line === '') {
      if (current.worktree) entries.push(current as GitWorktreeEntry)
      current = {}
    } else if (line.startsWith('worktree ')) {
      current.worktree = line.slice('worktree '.length)
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length)
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'detached') {
      current.detached = true
    }
  }
  if (current.worktree) entries.push(current as GitWorktreeEntry)
  return entries
}

export async function isBranchMerged(repoPath: string, branch: string, target: string): Promise<boolean> {
  const output = await git(repoPath, ['branch', '--merged', target])
  const branches = output.split('\n').map((b) => b.replace(/^[*+]?\s*/, ''))
  return branches.includes(branch)
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await git(repoPath, ['branch', '-d', branch])
}

export async function getLastCommitDate(worktreePath: string): Promise<string | undefined> {
  try {
    const output = await git(worktreePath, ['log', '-1', '--format=%aI'])
    return output || undefined
  } catch {
    return undefined
  }
}
