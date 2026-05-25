export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: FileTreeNode[]
}

export interface FileContent {
  path: string
  content: string
  encoding: 'utf-8' | 'base64'
  size: number
  language?: string
}
