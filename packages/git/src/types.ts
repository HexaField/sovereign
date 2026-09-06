export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  staged: FileChange[]
  modified: FileChange[]
  untracked: string[]
}

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  oldPath?: string
  additions?: number
  deletions?: number
}

/** Git context for a single repo root detected from a thread's working directory. */
export interface ThreadGitContext {
  repoRoot: string
  repoName: string
  branch: string
  baseBranch: string
  aheadBy: number
  files: FileChange[]
  commits?: CommitInfo[]
  remote?: { url: string; owner: string; repo: string }
  pr?: { number: number; url: string; state: string; title: string }
}

export interface CommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  refs?: string[]
}
