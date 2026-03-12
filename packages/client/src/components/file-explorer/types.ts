export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: FileNode[]
}

export interface FileExplorerProps {
  orgId?: string
  projectId?: string
  worktreeId?: string
  onFileSelect?: (path: string) => void
}

export interface ContextMenuAction {
  label: string
  action: () => void
  icon?: string
}
