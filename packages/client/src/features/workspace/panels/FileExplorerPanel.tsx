import { Show, For, createSignal, createResource, type Component } from 'solid-js'
import { activeWorkspace } from '../store.js'
import WorkspacePicker from '../WorkspacePicker.js'

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  size?: number
  gitStatus?: string
}

export function buildTreeUrl(projectId: string): string {
  return `/api/files/tree?project=${encodeURIComponent(projectId)}`
}

export function getFileExtension(filename: string): string {
  const idx = filename.lastIndexOf('.')
  return idx >= 0 ? filename.slice(idx + 1) : ''
}

const fetchTree = async (projectPath: string | null): Promise<FileNode[]> => {
  if (!projectPath) return []
  const res = await fetch(`/api/files/tree?project=${encodeURIComponent(projectPath)}`)
  if (!res.ok) return []
  return res.json()
}

const FileIcon: Component<{ node: FileNode }> = (props) => {
  const icon = () => (props.node.type === 'directory' ? '📁' : '📄')
  return <span class="mr-1">{icon()}</span>
}

const TreeNode: Component<{ node: FileNode; depth: number }> = (props) => {
  const [expanded, setExpanded] = createSignal(false)
  const [children, setChildren] = createSignal<FileNode[]>([])
  const [loading, setLoading] = createSignal(false)

  const ws = () => activeWorkspace()

  const toggle = async () => {
    if (props.node.type !== 'directory') return
    if (!expanded()) {
      setLoading(true)
      try {
        // Fetch children for this subdirectory
        const projectPath = ws()?.activeProjectId
        if (!projectPath) return
        // We need the repo path, not just project id. Use the node's path for subdir.
        const res = await fetch(
          `/api/files/tree?project=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(props.node.path)}`
        )
        if (res.ok) {
          const nodes: FileNode[] = await res.json()
          // Prefix child paths with parent path
          setChildren(nodes.map((n) => ({ ...n, path: `${props.node.path}/${n.path}` })))
        }
      } finally {
        setLoading(false)
      }
    }
    setExpanded(!expanded())
  }

  return (
    <div>
      <button
        class="flex w-full items-center rounded px-1 py-0.5 text-left text-xs transition-colors hover:opacity-80"
        style={{
          'padding-left': `${props.depth * 12 + 4}px`,
          color: 'var(--c-text)',
          background: 'transparent'
        }}
        onClick={toggle}
      >
        <Show when={props.node.type === 'directory'}>
          <span class="mr-0.5 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            {expanded() ? '▾' : '▸'}
          </span>
        </Show>
        <FileIcon node={props.node} />
        <span class="truncate">{props.node.name}</span>
      </button>
      <Show when={expanded()}>
        <Show when={loading()}>
          <div
            class="text-xs"
            style={{ 'padding-left': `${(props.depth + 1) * 12 + 4}px`, color: 'var(--c-text-muted)' }}
          >
            Loading...
          </div>
        </Show>
        <For each={children()}>{(child) => <TreeNode node={child} depth={props.depth + 1} />}</For>
      </Show>
    </div>
  )
}

const FileExplorerPanel: Component = () => {
  const ws = () => activeWorkspace()
  // We pass repoPath of the active project, but the files API uses the project path
  // The tree API takes `project` param which is the filesystem path
  // We need to get the actual repoPath from the project data
  const [projectPath, setProjectPath] = createSignal<string | null>(null)

  // Fetch project details to get repoPath when projectId changes
  const fetchProjectPath = async () => {
    const orgId = ws()?.orgId
    const projectId = ws()?.activeProjectId
    if (!orgId || !projectId) {
      setProjectPath(null)
      return null
    }
    const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`)
    if (!res.ok) {
      setProjectPath(null)
      return null
    }
    const project = await res.json()
    setProjectPath(project.repoPath)
    return project.repoPath as string
  }

  const projectKey = () => `${ws()?.orgId}:${ws()?.activeProjectId}`
  const [tree] = createResource(projectKey, fetchProjectPath)

  const [rootTree] = createResource(projectPath, fetchTree)

  return (
    <div class="flex h-full flex-col">
      {/* Workspace picker */}
      <div class="border-b px-2 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <WorkspacePicker />
      </div>

      {/* File tree */}
      <div class="flex-1 overflow-auto p-1">
        <Show
          when={ws()?.activeProjectId}
          fallback={
            <p class="px-2 py-4 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
              Select a project above to browse files
            </p>
          }
        >
          <Show
            when={!rootTree.loading}
            fallback={
              <p class="px-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                Loading...
              </p>
            }
          >
            <For each={rootTree() ?? []}>{(node) => <TreeNode node={node} depth={0} />}</For>
            <Show when={(rootTree() ?? []).length === 0}>
              <p class="px-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                Empty directory
              </p>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export default FileExplorerPanel
