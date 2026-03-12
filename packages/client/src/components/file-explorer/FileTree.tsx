import { type Component, For } from 'solid-js'
import type { FileNode } from './types.js'
import FileTreeNode from './FileTreeNode.js'

interface FileTreeProps {
  nodes: FileNode[]
  depth?: number
  onFileSelect?: (path: string) => void
  onLoadChildren?: (path: string) => Promise<FileNode[]>
}

const FileTree: Component<FileTreeProps> = (props) => {
  const sorted = () => {
    const nodes = [...props.nodes]
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return nodes
  }

  return (
    <div>
      <For each={sorted()}>
        {(node) => (
          <FileTreeNode
            node={node}
            depth={props.depth ?? 0}
            onFileSelect={props.onFileSelect}
            onLoadChildren={props.onLoadChildren}
          />
        )}
      </For>
    </div>
  )
}

export default FileTree
