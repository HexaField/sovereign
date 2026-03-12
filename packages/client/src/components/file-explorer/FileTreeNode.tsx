import { type Component, createSignal, Show } from 'solid-js'
import type { FileNode, ContextMenuAction } from './types.js'
import { getFileIcon, getDirectoryIcon } from './file-icons.js'
import ContextMenu from './ContextMenu.js'

interface FileTreeNodeProps {
  node: FileNode
  depth: number
  onFileSelect?: (path: string) => void
  onLoadChildren?: (path: string) => Promise<FileNode[]>
}

const FileTreeNode: Component<FileTreeNodeProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false)
  const [children, setChildren] = createSignal<FileNode[]>(props.node.children ?? [])
  const [loading, setLoading] = createSignal(false)
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number } | null>(null)

  const isDir = () => props.node.type === 'directory'

  const handleClick = async () => {
    if (isDir()) {
      if (!expanded() && children().length === 0 && props.onLoadChildren) {
        setLoading(true)
        const loaded = await props.onLoadChildren(props.node.path)
        setChildren(loaded)
        setLoading(false)
      }
      setExpanded((e) => !e)
    } else {
      props.onFileSelect?.(props.node.path)
    }
  }

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const contextActions = (): ContextMenuAction[] => [
    {
      label: 'New File',
      icon: '📄',
      action: () => {
        /* TODO: emit event */
      }
    },
    {
      label: 'New Folder',
      icon: '📁',
      action: () => {
        /* TODO: emit event */
      }
    },
    {
      label: 'Rename',
      icon: '✏️',
      action: () => {
        /* TODO: emit event */
      }
    },
    {
      label: 'Delete',
      icon: '🗑️',
      action: () => {
        /* TODO: emit event */
      }
    },
    { label: 'Copy Path', icon: '📋', action: () => navigator.clipboard.writeText(props.node.path) }
  ]

  return (
    <div>
      <div
        class="flex cursor-pointer items-center gap-1 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
        style={{ 'padding-left': `${props.depth * 16 + 8}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <Show when={isDir()}>
          <span class="w-3 text-zinc-500">{expanded() ? '▾' : '▸'}</span>
        </Show>
        <Show when={!isDir()}>
          <span class="w-3" />
        </Show>
        <span>{isDir() ? getDirectoryIcon(props.node.name) : getFileIcon(props.node.name)}</span>
        <span class="truncate">{props.node.name}</span>
        <Show when={loading()}>
          <span class="ml-1 animate-pulse text-zinc-500">…</span>
        </Show>
      </div>

      <Show when={expanded() && isDir()}>
        <FileTree
          nodes={children()}
          depth={props.depth + 1}
          onFileSelect={props.onFileSelect}
          onLoadChildren={props.onLoadChildren}
        />
      </Show>

      <Show when={contextMenu()}>
        {(menu) => (
          <ContextMenu x={menu().x} y={menu().y} actions={contextActions()} onClose={() => setContextMenu(null)} />
        )}
      </Show>
    </div>
  )
}

// Forward declare — used by FileTreeNode recursively
import FileTree from './FileTree.js'

export default FileTreeNode
