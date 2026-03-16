import { Show, For, createSignal, createResource, createEffect, type Component } from 'solid-js'
import { activeWorkspace, openFileTab } from '../store.js'

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

// ── File operations ─────────────────────────────────────────────────

export async function createFileOrFolder(
  projectPath: string,
  parentDir: string,
  name: string,
  type: 'file' | 'directory'
): Promise<boolean> {
  const res = await fetch('/api/files/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectPath, path: `${parentDir}/${name}`, type })
  })
  return res.ok
}

export async function renameFileOrFolder(projectPath: string, oldPath: string, newName: string): Promise<boolean> {
  const res = await fetch('/api/files/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectPath, oldPath, newName })
  })
  return res.ok
}

export async function deleteFileOrFolder(projectPath: string, path: string): Promise<boolean> {
  const res = await fetch('/api/files/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectPath, path })
  })
  return res.ok
}

// ── Context Menu ────────────────────────────────────────────────────

interface ContextMenuProps {
  x: number
  y: number
  node: FileNode | null
  projectPath: string
  onClose: () => void
  onRefresh: () => void
}

const ContextMenu: Component<ContextMenuProps> = (props) => {
  const handleCreate = async (type: 'file' | 'directory') => {
    const label = type === 'file' ? 'file' : 'folder'
    const name = prompt(`New ${label} name:`)
    if (!name) return props.onClose()
    const parentDir = props.node?.type === 'directory' ? props.node.path : ''
    await createFileOrFolder(props.projectPath, parentDir, name, type)
    props.onRefresh()
    props.onClose()
  }

  const handleRename = async () => {
    if (!props.node) return props.onClose()
    const newName = prompt('Rename to:', props.node.name)
    if (!newName || newName === props.node.name) return props.onClose()
    await renameFileOrFolder(props.projectPath, props.node.path, newName)
    props.onRefresh()
    props.onClose()
  }

  const handleDelete = async () => {
    if (!props.node) return props.onClose()
    if (!confirm(`Delete "${props.node.name}"?`)) return props.onClose()
    await deleteFileOrFolder(props.projectPath, props.node.path)
    props.onRefresh()
    props.onClose()
  }

  return (
    <div
      class="fixed z-[999] min-w-[140px] overflow-hidden rounded-lg py-1 shadow-xl"
      style={{
        left: `${props.x}px`,
        top: `${props.y}px`,
        background: 'var(--c-menu-bg)',
        border: '1px solid var(--c-border-strong)'
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        class="flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors"
        style={{ color: 'var(--c-text)' }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--c-hover-bg-strong)')}
        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = '')}
        onClick={() => handleCreate('file')}
      >
        New File
      </button>
      <button
        class="flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors"
        style={{ color: 'var(--c-text)' }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--c-hover-bg-strong)')}
        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = '')}
        onClick={() => handleCreate('directory')}
      >
        New Folder
      </button>
      <Show when={props.node}>
        <div style={{ height: '1px', background: 'var(--c-border-strong)', margin: '2px 0' }} />
        <button
          class="flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors"
          style={{ color: 'var(--c-text)' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--c-hover-bg-strong)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = '')}
          onClick={handleRename}
        >
          Rename
        </button>
        <button
          class="flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors"
          style={{ color: 'var(--c-danger)' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--c-hover-bg-strong)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = '')}
          onClick={handleDelete}
        >
          Delete
        </button>
      </Show>
    </div>
  )
}

// ── Icons ───────────────────────────────────────────────────────────

const FileIconSvg: Component<{ node: FileNode }> = (props) => {
  return (
    <span class="mr-1 inline-flex" style={{ color: 'var(--c-text-muted)' }}>
      {props.node.type === 'directory' ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      )}
    </span>
  )
}

// ── Tree Node ───────────────────────────────────────────────────────

const TreeNode: Component<{
  node: FileNode
  depth: number
  rootPath: string
  onContextMenu: (e: MouseEvent, node: FileNode) => void
}> = (props) => {
  const [expanded, setExpanded] = createSignal(false)
  const [children, setChildren] = createSignal<FileNode[]>([])
  const [loading, setLoading] = createSignal(false)

  const toggle = async () => {
    if (props.node.type !== 'directory') {
      // Open file in viewer
      if (props.rootPath) {
        openFileTab(props.node.path, props.rootPath)
      }
      return
    }
    if (!expanded()) {
      setLoading(true)
      try {
        const projectPath = props.rootPath
        if (!projectPath) return
        const res = await fetch(
          `/api/files/tree?project=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(props.node.path)}`
        )
        if (res.ok) {
          const nodes: FileNode[] = await res.json()
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
        onContextMenu={(e) => {
          e.preventDefault()
          props.onContextMenu(e, props.node)
        }}
      >
        <Show when={props.node.type === 'directory'}>
          <span class="mr-0.5 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            {expanded() ? '▾' : '▸'}
          </span>
        </Show>
        <FileIconSvg node={props.node} />
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
        <For each={children()}>
          {(child) => (
            <TreeNode
              node={child}
              depth={props.depth + 1}
              rootPath={props.rootPath}
              onContextMenu={props.onContextMenu}
            />
          )}
        </For>
      </Show>
    </div>
  )
}

// ── Main Panel ──────────────────────────────────────────────────────

const FileExplorerPanel: Component = () => {
  const ws = () => activeWorkspace()
  const [orgPath, setOrgPath] = createSignal<string | null>(null)
  const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number; node: FileNode | null } | null>(null)
  const [refreshKey, setRefreshKey] = createSignal(0)

  // Fetch org path when org changes
  createEffect(async () => {
    const orgId = ws()?.orgId
    if (!orgId) {
      setOrgPath(null)
      return
    }
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}`)
      if (res.ok) {
        const org = await res.json()
        setOrgPath(org.path ?? null)
      } else {
        setOrgPath(null)
      }
    } catch {
      setOrgPath(null)
    }
  })

  const treeKey = () => `${orgPath()}:${refreshKey()}`
  const [rootTree, { refetch }] = createResource(treeKey, () => fetchTree(orgPath()))

  const handleContextMenu = (e: MouseEvent, node: FileNode | null) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, node })
  }

  const handleRefresh = () => {
    setRefreshKey((k) => k + 1)
    refetch()
  }

  // Close context menu on click anywhere
  const handleDocClick = () => setCtxMenu(null)
  document.addEventListener('click', handleDocClick)

  return (
    <div class="flex h-full flex-col">
      <div
        class="flex-1 overflow-auto p-1"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).closest('[data-file-tree]')) return
          handleContextMenu(e, null)
        }}
      >
        <Show
          when={orgPath()}
          fallback={
            <p class="px-2 py-4 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
              No workspace selected
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
            <For each={rootTree() ?? []}>
              {(node) => (
                <TreeNode node={node} depth={0} rootPath={orgPath() ?? ''} onContextMenu={handleContextMenu} />
              )}
            </For>
            <Show when={(rootTree() ?? []).length === 0}>
              <p class="px-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                Empty directory
              </p>
            </Show>
          </Show>
        </Show>
      </div>

      <Show when={ctxMenu()}>
        {(menu) => (
          <ContextMenu
            x={menu().x}
            y={menu().y}
            node={menu().node}
            projectPath={orgPath() ?? ''}
            onClose={() => setCtxMenu(null)}
            onRefresh={handleRefresh}
          />
        )}
      </Show>
    </div>
  )
}

export default FileExplorerPanel
