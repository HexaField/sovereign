import { type Component, createResource } from 'solid-js'
import type { FileExplorerProps, FileNode } from './types.js'
import FileTree from './FileTree.js'

const FileExplorer: Component<FileExplorerProps> = (props) => {
  const fetchTree = async (): Promise<FileNode[]> => {
    const params = new URLSearchParams()
    if (props.projectId) params.set('project', props.projectId)
    if (props.orgId) params.set('org', props.orgId)
    try {
      const res = await fetch(`/api/files/tree?${params}`)
      if (!res.ok) return []
      return res.json()
    } catch {
      return []
    }
  }

  const [tree] = createResource(fetchTree)

  const loadChildren = async (path: string): Promise<FileNode[]> => {
    const params = new URLSearchParams({ path })
    if (props.projectId) params.set('project', props.projectId)
    try {
      const res = await fetch(`/api/files/tree?${params}`)
      if (!res.ok) return []
      return res.json()
    } catch {
      return []
    }
  }

  return (
    <div class="overflow-y-auto">
      <FileTree nodes={tree() ?? []} onFileSelect={props.onFileSelect} onLoadChildren={loadChildren} />
    </div>
  )
}

export default FileExplorer
