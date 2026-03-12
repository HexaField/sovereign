// Diff Engine — Types

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

export interface FileDiff {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  binary: boolean
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

export interface SemanticChange {
  path: string
  type: 'added' | 'removed' | 'changed'
  oldValue?: unknown
  newValue?: unknown
}

export interface SemanticDiff {
  format: 'json' | 'yaml' | 'toml'
  changes: SemanticChange[]
  fallbackTextDiff?: FileDiff
}

export interface ChangeSet {
  id: string
  title: string
  description: string
  orgId: string
  projectId: string
  worktreeId?: string
  baseBranch: string
  headBranch: string
  files: { path: string; status: string; additions: number; deletions: number }[]
  status: 'open' | 'reviewing' | 'approved' | 'merged' | 'closed'
  createdAt: string
  updatedAt: string
}

export interface DiffEngine {
  diffText(oldText: string, newText: string): DiffHunk[]
  diffFile(projectPath: string, filePath: string, base: string, head: string): Promise<FileDiff>
  diffWorking(projectPath: string, opts?: { staged?: boolean }): Promise<FileDiff[]>
  diffSemantic(oldText: string, newText: string, format: string): SemanticDiff
  createChangeSet(data: {
    orgId: string
    projectId: string
    worktreeId?: string
    baseBranch: string
    headBranch: string
    title: string
    description?: string
  }): Promise<ChangeSet>
  getChangeSet(id: string): ChangeSet | undefined
  listChangeSets(filter?: { orgId?: string; status?: string }): ChangeSet[]
  updateChangeSet(id: string, patch: Partial<ChangeSet>): ChangeSet
  deleteChangeSet(id: string): void
  getChangeSetFileDiff(changeSetId: string, filePath: string): Promise<FileDiff>
}
