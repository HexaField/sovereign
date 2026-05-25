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
}

export interface CommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  refs?: string[]
}
