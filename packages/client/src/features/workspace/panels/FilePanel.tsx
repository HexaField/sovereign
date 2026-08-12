/**
 * FilePanel — Unified file viewer with universal file tree, multi-file tab bar,
 * edit/view toggle, markdown rendering, image preview, and Monaco editor.
 *
 * The file tree shows ALL registered workspace roots (orgs), not just the
 * active workspace. Open files persist per-tab via sessionStorage.
 *
 * Desktop: file tree slides out as overlay drawer from left edge.
 * Mobile: file tree fills the view; tapping a file switches to viewer in-place.
 */
import { Component, Show, For, createSignal, createEffect, onCleanup, onMount, batch } from 'solid-js'
import { marked } from 'marked'
import {
  lastOpenFilePath,
  setLastOpenFilePath,
  mobileFileShowTree,
  setMobileFileShowTree,
  persistedExpandedDirs,
  setPersistedExpandedDirs,
  openFileTabs,
  activeFileTabId,
  setActiveFileTabId,
  openFileTab,
  closeFileTab
} from '../store.js'
import { wsStore } from '../../../ws/index.js'

// ── Types ────────────────────────────────────────────────────────────

type FileMode = 'view' | 'edit'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  size?: number
  gitStatus?: string
}

interface FileData {
  path: string
  content: string
  encoding: 'utf-8' | 'base64'
  size: number
  language?: string
}

interface FileRoot {
  id: string
  name: string
  path: string
}

// ── Helpers ──────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set(['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

function getExt(p: string): string {
  const idx = p.lastIndexOf('.')
  return idx >= 0 ? p.slice(idx + 1).toLowerCase() : ''
}

function isImage(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext)
}

function isMobile(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < 768
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sh: 'shell',
    bash: 'shell',
    py: 'python',
    rs: 'rust',
    go: 'go',
    rb: 'ruby',
    sql: 'sql',
    graphql: 'graphql',
    txt: 'plaintext',
    log: 'plaintext',
    env: 'plaintext'
  }
  return map[ext] || 'plaintext'
}

function fileName(p: string): string {
  return p.split('/').pop() ?? p
}

// ── API ──────────────────────────────────────────────────────────────

async function fetchRoots(): Promise<FileRoot[]> {
  try {
    const res = await fetch('/api/files/roots')
    if (!res.ok) return []
    const data = await res.json()
    return data.roots ?? []
  } catch {
    return []
  }
}

async function fetchTree(projectPath: string): Promise<FileNode[]> {
  const res = await fetch(`/api/files/tree?project=${encodeURIComponent(projectPath)}`)
  if (!res.ok) return []
  return res.json()
}

async function fetchSubtree(projectPath: string, dirPath: string): Promise<FileNode[]> {
  const res = await fetch(
    `/api/files/tree?project=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(dirPath)}`
  )
  if (!res.ok) return []
  return res.json()
}

async function fetchFileAbsolute(filePath: string): Promise<FileData> {
  const res = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`)
  if (!res.ok) throw new Error(`Failed to load file: ${res.statusText}`)
  return res.json()
}

async function saveFileAbsolute(filePath: string, content: string): Promise<void> {
  // Write via the absolute-path route: project = dirname, path = relative filename
  const dir = filePath.substring(0, filePath.lastIndexOf('/'))
  const rel = filePath.substring(filePath.lastIndexOf('/') + 1)
  const res = await fetch('/api/files', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: rel, project: dir, content })
  })
  if (!res.ok) throw new Error(`Failed to save: ${res.statusText}`)
}

// ── Context Menu ─────────────────────────────────────────────────────

const ContextMenu: Component<{
  x: number
  y: number
  node: FileNode | null
  rootPath: string
  onClose: () => void
  onRefresh: () => void
}> = (props) => {
  const handleCreate = async (type: 'file' | 'directory') => {
    const label = type === 'file' ? 'file' : 'folder'
    const name = prompt(`New ${label} name:`)
    if (!name) return props.onClose()
    const parentDir = props.node?.type === 'directory' ? props.node.path : ''
    await fetch('/api/files/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: props.rootPath, path: `${parentDir}/${name}`, type })
    })
    props.onRefresh()
    props.onClose()
  }

  const handleRename = async () => {
    if (!props.node) return props.onClose()
    const newName = prompt('Rename to:', props.node.name)
    if (!newName || newName === props.node.name) return props.onClose()
    await fetch('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: props.rootPath, oldPath: props.node.path, newName })
    })
    props.onRefresh()
    props.onClose()
  }

  const handleDelete = async () => {
    if (!props.node) return props.onClose()
    if (!confirm(`Delete "${props.node.name}"?`)) return props.onClose()
    await fetch('/api/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: props.rootPath, path: props.node.path })
    })
    props.onRefresh()
    props.onClose()
  }

  return (
    <div
      class="fixed z-[999] min-w-[140px] overflow-hidden rounded-lg py-1 shadow-xl"
      style={{
        left: `${props.x}px`,
        top: `${props.y}px`,
        background: 'var(--c-menu-bg, var(--c-bg-raised))',
        border: '1px solid var(--c-border-strong, var(--c-border))'
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        class="flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors hover:brightness-125"
        style={{ color: 'var(--c-text)', background: 'transparent' }}
        onClick={() => handleCreate('file')}
      >
        New File
      </button>
      <button
        class="flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors hover:brightness-125"
        style={{ color: 'var(--c-text)', background: 'transparent' }}
        onClick={() => handleCreate('directory')}
      >
        New Folder
      </button>
      <Show when={props.node}>
        <div style={{ height: '1px', background: 'var(--c-border)', margin: '2px 0' }} />
        <button
          class="flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors hover:brightness-125"
          style={{ color: 'var(--c-text)', background: 'transparent' }}
          onClick={handleRename}
        >
          Rename
        </button>
        <button
          class="flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors hover:brightness-125"
          style={{ color: 'var(--c-danger, #ef4444)', background: 'transparent' }}
          onClick={handleDelete}
        >
          Delete
        </button>
      </Show>
    </div>
  )
}

// ── Tree Node ────────────────────────────────────────────────────────

const TreeNodeItem: Component<{
  node: FileNode
  depth: number
  rootPath: string
  activeFilePath: string | null
  expandedDirs: Set<string>
  onToggleDir: (dirPath: string, rootPath: string) => void
  onSelectFile: (absolutePath: string) => void
  onContextMenu: (e: MouseEvent, node: FileNode) => void
}> = (props) => {
  const isDir = () => props.node.type === 'directory'
  const isExpanded = () => props.expandedDirs.has(`${props.rootPath}:${props.node.path}`)
  const fullPath = () => `${props.rootPath}/${props.node.path}`
  const isActive = () => props.activeFilePath === fullPath()
  const indent = () => props.depth * 14 + 6

  return (
    <>
      <button
        class="flex w-full items-center gap-1 rounded px-1 py-[3px] text-left text-[11px] transition-colors"
        style={{
          'padding-left': `${indent()}px`,
          color: isActive() ? 'var(--c-accent)' : 'var(--c-text)',
          background: isActive() ? 'var(--c-hover-bg, rgba(255,255,255,0.06))' : 'transparent'
        }}
        onClick={() => {
          if (isDir()) props.onToggleDir(props.node.path, props.rootPath)
          else props.onSelectFile(fullPath())
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          props.onContextMenu(e, props.node)
        }}
      >
        <Show when={isDir()}>
          <span class="w-3 shrink-0 text-center text-[9px]" style={{ color: 'var(--c-text-muted)' }}>
            {isExpanded() ? '▾' : '▸'}
          </span>
        </Show>
        <Show when={!isDir()}>
          <span class="w-3 shrink-0" />
        </Show>
        <span class="shrink-0" style={{ color: 'var(--c-text-muted)' }}>
          {isDir() ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          )}
        </span>
        <span class="truncate">{props.node.name}</span>
        <Show when={!isDir() && props.node.size}>
          <span class="ml-auto shrink-0 text-[8px]" style={{ color: 'var(--c-text-muted)' }}>
            {formatBytes(props.node.size!)}
          </span>
        </Show>
      </button>
      <Show when={isDir() && isExpanded()}>
        <For each={props.node.children ?? []}>
          {(child) => (
            <TreeNodeItem
              node={child}
              depth={props.depth + 1}
              rootPath={props.rootPath}
              activeFilePath={props.activeFilePath}
              expandedDirs={props.expandedDirs}
              onToggleDir={props.onToggleDir}
              onSelectFile={props.onSelectFile}
              onContextMenu={props.onContextMenu}
            />
          )}
        </For>
      </Show>
    </>
  )
}

// ── Tab Bar ──────────────────────────────────────────────────────────

const FileTabBar: Component<{
  onSelectTab: (filePath: string) => void
}> = (props) => {
  const tabs = openFileTabs
  const activeId = activeFileTabId

  return (
    <Show when={tabs().length > 0}>
      <div
        class="scrollbar-none flex shrink-0 items-center gap-0 overflow-x-auto border-b"
        style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg-raised)' }}
      >
        <For each={tabs()}>
          {(tab) => {
            const active = () => activeId() === tab.id
            return (
              <div
                class="group flex shrink-0 items-center"
                style={{
                  background: active() ? 'var(--c-bg)' : 'transparent',
                  'border-right': '1px solid var(--c-border)'
                }}
              >
                <button
                  class="px-3 py-1.5 text-[11px] transition-colors"
                  style={{
                    color: active() ? 'var(--c-text)' : 'var(--c-text-muted)',
                    'font-weight': active() ? '500' : '400'
                  }}
                  onClick={() => {
                    setActiveFileTabId(tab.id)
                    props.onSelectTab(tab.path)
                  }}
                  title={tab.path}
                >
                  {tab.label}
                </button>
                <button
                  class="px-1 py-1 text-[10px] opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ color: 'var(--c-text-muted)' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeFileTab(tab.id)
                  }}
                  title="Close tab"
                >
                  ✕
                </button>
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )
}

// ── Main FilePanel ───────────────────────────────────────────────────

const FilePanel: Component = () => {
  // ── State ──
  const [roots, setRoots] = createSignal<FileRoot[]>([])
  // Tree data keyed by root path
  const [treeMaps, setTreeMaps] = createSignal<Record<string, FileNode[]>>({})
  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(new Set(persistedExpandedDirs()))
  // expandedRoots tracks which root sections show their tree
  const [expandedRoots, setExpandedRoots] = createSignal<Set<string>>(new Set())
  const [activeFilePath, setActiveFilePath] = createSignal<string | null>(lastOpenFilePath())
  const [fileData, setFileData] = createSignal<FileData | null>(null)
  const [mode, setMode] = createSignal<FileMode>('view')
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [renderedHtml, setRenderedHtml] = createSignal('')
  const [editorContent, setEditorContent] = createSignal('')
  const [drawerOpen, setDrawerOpen] = createSignal(false)
  const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number; node: FileNode | null; rootPath: string } | null>(
    null
  )

  let editorContainer: HTMLDivElement | undefined
  let monacoEditor: any = null
  let monacoInstance: any = null

  // ── Load roots on mount ──
  onMount(async () => {
    const r = await fetchRoots()
    setRoots(r)
    // Auto-expand the first root
    if (r.length > 0) {
      toggleRoot(r[0].path)
    }
  })

  // ── Root toggle — load tree on first expand ──
  const toggleRoot = async (rootPath: string) => {
    const s = new Set(expandedRoots())
    if (s.has(rootPath)) {
      s.delete(rootPath)
    } else {
      s.add(rootPath)
      // Load tree if not already loaded
      if (!treeMaps()[rootPath]) {
        const nodes = await fetchTree(rootPath)
        setTreeMaps((prev) => ({ ...prev, [rootPath]: nodes }))
      }
    }
    setExpandedRoots(s)
  }

  // ── Directory toggle — lazy-load children ──
  const toggleDir = async (dirPath: string, rootPath: string) => {
    const key = `${rootPath}:${dirPath}`
    const s = new Set(expandedDirs())
    if (s.has(key)) {
      s.delete(key)
    } else {
      s.add(key)
      const children = await fetchSubtree(rootPath, dirPath)
      setTreeMaps((prev) => {
        const rootNodes = prev[rootPath] ?? []
        return { ...prev, [rootPath]: mergeChildren(rootNodes, dirPath, children) }
      })
    }
    setExpandedDirs(s)
    setPersistedExpandedDirs([...s])
  }

  function mergeChildren(nodes: FileNode[], targetPath: string, children: FileNode[]): FileNode[] {
    return nodes.map((n) => {
      if (n.path === targetPath && n.type === 'directory') {
        const merged = children.map((c) => ({ ...c, path: `${targetPath}/${c.path}` }))
        return { ...n, children: merged }
      }
      if (n.type === 'directory' && n.children && targetPath.startsWith(n.path + '/')) {
        return { ...n, children: mergeChildren(n.children, targetPath, children) }
      }
      return n
    })
  }

  // ── File operations (always absolute paths) ──
  const openFile = async (filePath: string) => {
    setLoading(true)
    setError(null)
    setActiveFilePath(filePath)
    setLastOpenFilePath(filePath)
    setMode('view')
    setDirty(false)

    // Add to tabs
    openFileTab(filePath, '_workspace')

    if (isMobile()) setMobileFileShowTree(false)
    setDrawerOpen(false)

    try {
      const data = await fetchFileAbsolute(filePath)
      setFileData(data)
      setEditorContent(data.content)

      const ext = getExt(filePath)
      if (ext === 'md') {
        setRenderedHtml(marked.parse(data.content, { async: false }) as string)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // Switch to an already-open tab
  const switchToTab = (filePath: string) => {
    if (activeFilePath() === filePath) return
    openFile(filePath)
  }

  const save = async () => {
    const fp = activeFilePath()
    const fd = fileData()
    if (!fp || !fd || !dirty()) return
    setSaving(true)
    try {
      const content = monacoEditor ? monacoEditor.getValue() : editorContent()
      await saveFileAbsolute(fp, content)
      setDirty(false)
      setEditorContent(content)
      if (getExt(fp) === 'md') {
        setRenderedHtml(marked.parse(content, { async: false }) as string)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleModeToggle = (newMode: FileMode) => {
    if (mode() === 'edit' && monacoEditor) {
      const content = monacoEditor.getValue()
      setEditorContent(content)
      if (getExt(activeFilePath() ?? '') === 'md') {
        setRenderedHtml(marked.parse(content, { async: false }) as string)
      }
    }
    setMode(newMode)
  }

  // ── Monaco ──
  async function initMonaco(): Promise<void> {
    if (monacoInstance || !editorContainer) return
    try {
      const monaco = await import('monaco-editor')
      monacoInstance = monaco
      createEditor()
    } catch (e) {
      console.error('Failed to load Monaco:', e)
    }
  }

  function createEditor(): void {
    if (!monacoInstance || !editorContainer) return
    if (monacoEditor) monacoEditor.dispose()

    const ext = getExt(activeFilePath() ?? '')
    monacoEditor = monacoInstance.editor.create(editorContainer, {
      value: editorContent(),
      language: getLanguage(ext),
      theme: 'vs-dark',
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: 'on',
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 8 },
      renderLineHighlight: 'line',
      overviewRulerBorder: false,
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 }
    })

    monacoEditor.onDidChangeModelContent(() => setDirty(true))
    monacoEditor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => save())
  }

  createEffect(() => {
    const fp = activeFilePath()
    const m = mode()
    if (m === 'edit' && fp && monacoEditor) {
      const model = monacoEditor.getModel()
      if (model) {
        monacoInstance.editor.setModelLanguage(model, getLanguage(getExt(fp)))
        if (!dirty()) monacoEditor.setValue(editorContent())
      }
    }
  })

  createEffect(() => {
    if (mode() === 'edit' && fileData()) {
      setTimeout(() => initMonaco(), 50)
    }
  })

  // ── Keyboard ──
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      save()
    }
  }

  // ── Context menu ──
  const handleCtxMenu = (e: MouseEvent, node: FileNode, rootPath: string) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, node, rootPath })
  }

  const closeCtxMenu = () => setCtxMenu(null)

  const refreshRoot = async (rootPath: string) => {
    const nodes = await fetchTree(rootPath)
    setTreeMaps((prev) => ({ ...prev, [rootPath]: nodes }))
  }

  // ── Restore persisted file on mount + subscribe to file changes ──
  onMount(() => {
    document.addEventListener('click', closeCtxMenu)

    // Restore the active tab from sessionStorage
    const tabs = openFileTabs()
    const activeId = activeFileTabId()
    if (activeId && tabs.length > 0) {
      const activeTab = tabs.find((t) => t.id === activeId)
      if (activeTab) {
        openFile(activeTab.path)
      }
    } else {
      const stored = lastOpenFilePath()
      if (stored && !mobileFileShowTree()) {
        openFile(stored)
      }
    }

    wsStore.subscribe(['files'])
    const offChanged = wsStore.on('file.changed', (msg: any) => {
      const changedPath = msg.fullPath || msg.path
      if (!changedPath) return
      const active = activeFilePath()
      if (active && changedPath === active) {
        if (msg.kind === 'deleted') {
          batch(() => {
            setFileData(null)
            setActiveFilePath(null)
            setLastOpenFilePath(null)
          })
        } else if (!dirty()) {
          openFile(active)
        }
      }
      // Refresh the tree for the affected root
      const root = msg.root
      if (root) refreshRoot(root)
    })
    onCleanup(() => {
      offChanged()
      wsStore.unsubscribe(['files'])
    })
  })

  // Load lastOpenFilePath whenever it changes externally (file chip open)
  createEffect(() => {
    const stored = lastOpenFilePath()
    if (!stored || loading()) return
    if (activeFilePath() === stored) return
    openFile(stored)
  })

  // Sync expandedDirs from store
  createEffect(() => {
    setExpandedDirs(new Set(persistedExpandedDirs()))
  })

  onCleanup(() => {
    if (monacoEditor) monacoEditor.dispose()
    document.removeEventListener('click', closeCtxMenu)
  })

  // ── Derived state ──
  const ext = () => getExt(activeFilePath() ?? '')
  const hasFile = () => !!fileData() && !!activeFilePath()

  // ── Tree component — renders all roots ──
  const FileTree: Component<{ class?: string }> = (treeProps) => (
    <div class={`overflow-y-auto ${treeProps.class ?? ''}`}>
      <Show
        when={roots().length > 0}
        fallback={
          <p class="px-3 py-4 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
            No workspaces configured
          </p>
        }
      >
        <For each={roots()}>
          {(root) => {
            const rootExpanded = () => expandedRoots().has(root.path)
            const rootNodes = () => treeMaps()[root.path] ?? []
            return (
              <div>
                {/* Root header */}
                <button
                  class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-semibold transition-colors"
                  style={{
                    color: 'var(--c-text-heading, var(--c-text))',
                    background: 'transparent',
                    'border-bottom': rootExpanded() ? '1px solid var(--c-border)' : 'none'
                  }}
                  onClick={() => toggleRoot(root.path)}
                >
                  <span class="w-3 shrink-0 text-center text-[9px]" style={{ color: 'var(--c-text-muted)' }}>
                    {rootExpanded() ? '▾' : '▸'}
                  </span>
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    style={{ color: 'var(--c-text-muted)' }}
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span class="truncate">{root.name}</span>
                </button>
                {/* Root tree contents */}
                <Show when={rootExpanded()}>
                  <Show
                    when={rootNodes().length > 0}
                    fallback={
                      <p class="px-3 py-2 text-center text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                        Empty directory
                      </p>
                    }
                  >
                    <For each={rootNodes()}>
                      {(node) => (
                        <TreeNodeItem
                          node={node}
                          depth={1}
                          rootPath={root.path}
                          activeFilePath={activeFilePath()}
                          expandedDirs={expandedDirs()}
                          onToggleDir={toggleDir}
                          onSelectFile={openFile}
                          onContextMenu={(e, n) => handleCtxMenu(e, n, root.path)}
                        />
                      )}
                    </For>
                  </Show>
                </Show>
              </div>
            )
          }}
        </For>
      </Show>
    </div>
  )

  // ── Toolbar ──
  const Toolbar: Component = () => (
    <div
      class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
      style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg-raised)' }}
    >
      {/* Tree toggle — desktop only */}
      <Show when={!isMobile()}>
        <button
          class="rounded px-1.5 py-0.5 text-[11px] transition-colors"
          style={{ color: 'var(--c-text-muted)', background: 'transparent' }}
          onClick={() => setDrawerOpen(!drawerOpen())}
          title={drawerOpen() ? 'Hide files' : 'Show files'}
        >
          {drawerOpen() ? '◀' : '▶'}
        </button>
      </Show>

      {/* Mobile back button */}
      <Show when={isMobile() && !mobileFileShowTree()}>
        <button
          class="rounded px-1.5 py-0.5 text-[11px] transition-colors"
          style={{ color: 'var(--c-text-muted)', background: 'transparent' }}
          onClick={() => {
            setMobileFileShowTree(true)
            setActiveFilePath(null)
            setLastOpenFilePath(null)
            setFileData(null)
          }}
          title="Back to files"
        >
          ← Files
        </button>
      </Show>

      <Show when={hasFile()}>
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="truncate text-[12px] font-medium" style={{ color: 'var(--c-text)' }}>
            {fileName(activeFilePath()!)}
          </span>
          <Show when={dirty()}>
            <span class="text-[10px]" style={{ color: '#f59e0b' }}>
              ●
            </span>
          </Show>
        </div>

        <div class="ml-auto flex items-center gap-1.5">
          {/* Download button */}
          <button
            class="cursor-pointer rounded px-2 py-1 text-[10px] transition-colors hover:brightness-125"
            style={{
              color: 'var(--c-text-muted)',
              border: '1px solid var(--c-border)',
              background: 'transparent'
            }}
            onClick={() => {
              const fp = activeFilePath()
              if (!fp) return
              const name = fileName(fp)
              const fd = fileData()
              if (fd) {
                const mime = fd.encoding === 'base64' ? 'application/octet-stream' : 'text/plain'
                const content =
                  fd.encoding === 'base64' ? Uint8Array.from(atob(fd.content), (c) => c.charCodeAt(0)) : fd.content
                const blob = new Blob([content], { type: mime })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = name
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                URL.revokeObjectURL(url)
              }
            }}
            title="Download file"
          >
            ⬇
          </button>

          {/* View / Edit toggle */}
          <div class="flex overflow-hidden rounded" style={{ border: '1px solid var(--c-border)' }}>
            <button
              class="cursor-pointer px-2.5 py-1 text-[10px] transition-colors"
              style={{
                background: mode() === 'view' ? 'var(--c-accent)' : 'transparent',
                color: mode() === 'view' ? '#fff' : 'var(--c-text-muted)'
              }}
              onClick={() => handleModeToggle('view')}
            >
              View
            </button>
            <button
              class="cursor-pointer px-2.5 py-1 text-[10px] transition-colors"
              style={{
                background: mode() === 'edit' ? 'var(--c-accent)' : 'transparent',
                color: mode() === 'edit' ? '#fff' : 'var(--c-text-muted)'
              }}
              onClick={() => handleModeToggle('edit')}
            >
              Edit
            </button>
          </div>

          {/* Save button in edit mode */}
          <Show when={mode() === 'edit'}>
            <button
              class="cursor-pointer rounded px-2.5 py-1 text-[10px] transition-colors"
              style={{
                background: dirty() ? 'var(--c-accent)' : 'var(--c-bg-secondary, var(--c-bg-raised))',
                color: dirty() ? '#fff' : 'var(--c-text-muted)'
              }}
              onClick={save}
              disabled={!dirty() || saving()}
            >
              {saving() ? 'Saving…' : '⌘S Save'}
            </button>
          </Show>

          {/* File size (desktop only) */}
          <Show when={fileData() && !isMobile()}>
            <span class="text-[9px]" style={{ color: 'var(--c-text-muted)' }}>
              {formatBytes(fileData()!.size)}
            </span>
          </Show>
        </div>
      </Show>
    </div>
  )

  // ── View content ──
  const ViewContent: Component = () => {
    const fd = () => fileData()
    const e = () => ext()

    return (
      <Show when={fd()}>
        {/* Image preview */}
        <Show when={isImage(e())}>
          <div
            class="flex h-full items-center justify-center overflow-auto p-6"
            style={{ background: 'var(--c-bg-raised, var(--c-bg))' }}
          >
            <div class="flex flex-col items-center gap-3">
              <Show
                when={fd()!.encoding === 'base64'}
                fallback={
                  <div
                    class="max-h-[70vh] max-w-full overflow-auto rounded shadow-lg"
                    style={{
                      background: 'repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 16px 16px'
                    }}
                    innerHTML={fd()!.content}
                  />
                }
              >
                <img
                  src={`data:image/${e()};base64,${fd()!.content}`}
                  alt={fileName(activeFilePath()!)}
                  class="max-h-[70vh] max-w-full rounded object-contain shadow-lg"
                  style={{ background: 'repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 16px 16px' }}
                />
              </Show>
              <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                {fileName(activeFilePath()!)} — {formatBytes(fd()!.size)}
              </span>
            </div>
          </div>
        </Show>

        {/* Markdown rendered */}
        <Show when={!isImage(e()) && e() === 'md'}>
          <div
            class="prose prose-invert prose-sm h-full max-w-none overflow-y-auto p-6 [&_a]:text-[var(--c-accent)] [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--c-accent)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--c-text-muted)] [&_blockquote]:italic [&_code]:rounded [&_code]:bg-[var(--c-bg-raised)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_code]:text-[var(--c-accent)] [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:text-[var(--c-text)] [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-[var(--c-text)] [&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-[var(--c-text)] [&_hr]:my-4 [&_hr]:border-[var(--c-border)] [&_li]:mb-1 [&_ol]:mb-3 [&_ol]:pl-5 [&_ol]:text-sm [&_ol]:text-[var(--c-text-muted)] [&_p]:mb-3 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-[var(--c-text-muted)] [&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[var(--c-bg-raised)] [&_pre]:p-3 [&_pre]:text-xs [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_strong]:text-[var(--c-text)] [&_table]:mb-3 [&_table]:w-full [&_table]:text-sm [&_td]:border-b [&_td]:border-[var(--c-border)] [&_td]:px-2 [&_td]:py-1 [&_td]:text-[var(--c-text-muted)] [&_th]:border-b [&_th]:border-[var(--c-border)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-[var(--c-text)] [&_ul]:mb-3 [&_ul]:pl-5 [&_ul]:text-sm [&_ul]:text-[var(--c-text-muted)]"
            innerHTML={renderedHtml()}
          />
        </Show>

        {/* Plain text / code */}
        <Show when={!isImage(e()) && e() !== 'md'}>
          <pre
            class="h-full overflow-auto p-4 text-xs leading-relaxed"
            style={{ 'font-family': 'var(--font-mono, monospace)', color: 'var(--c-text)' }}
          >
            {fd()!.content}
          </pre>
        </Show>
      </Show>
    )
  }

  // ── Desktop Layout ──
  const DesktopLayout: Component = () => (
    <div class="relative flex h-full flex-col overflow-hidden" onKeyDown={handleKeyDown}>
      <FileTabBar onSelectTab={switchToTab} />
      <Toolbar />
      <div class="relative flex-1 overflow-hidden">
        {/* Drawer backdrop */}
        <Show when={drawerOpen()}>
          <div
            class="absolute inset-0 z-20"
            style={{ background: 'rgba(0,0,0,0.35)', 'backdrop-filter': 'blur(1px)' }}
            onClick={() => setDrawerOpen(false)}
          />
        </Show>

        {/* Drawer panel */}
        <div
          class="absolute top-0 bottom-0 left-0 z-30 flex flex-col overflow-hidden transition-transform duration-200"
          style={{
            width: '260px',
            background: 'var(--c-bg-raised)',
            'border-right': '1px solid var(--c-border)',
            transform: drawerOpen() ? 'translateX(0)' : 'translateX(-100%)'
          }}
        >
          <div
            class="flex items-center justify-between border-b px-3 py-1.5"
            style={{ 'border-color': 'var(--c-border)' }}
          >
            <span class="text-[10px] tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
              Explorer
            </span>
            <button
              class="cursor-pointer rounded p-1 text-[14px] transition-colors"
              style={{ color: 'var(--c-text-muted)', background: 'transparent' }}
              onClick={() => setDrawerOpen(false)}
            >
              ✕
            </button>
          </div>
          <FileTree class="flex-1" />
        </div>

        {/* Content area */}
        <div class="h-full overflow-hidden">
          <Show when={error()}>
            <div class="p-4 text-sm" style={{ color: 'var(--c-danger, #ef4444)' }}>
              {error()}
            </div>
          </Show>

          <Show when={loading()}>
            <div class="p-4 text-sm" style={{ color: 'var(--c-text-muted)' }}>
              Loading…
            </div>
          </Show>

          <Show when={!hasFile() && !loading() && !error()}>
            <div class="flex h-full items-center justify-center">
              <button
                class="cursor-pointer rounded px-4 py-2 text-sm transition-colors"
                style={{ background: 'var(--c-accent)', color: '#fff' }}
                onClick={() => setDrawerOpen(true)}
              >
                Browse files
              </button>
            </div>
          </Show>

          <Show when={hasFile() && !loading()}>
            <Show when={mode() === 'view'}>
              <ViewContent />
            </Show>
            <Show when={mode() === 'edit'}>
              <div ref={editorContainer} class="h-full w-full" />
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )

  // ── Mobile Layout ──
  const MobileLayout: Component = () => (
    <div class="flex h-full flex-col overflow-hidden" onKeyDown={handleKeyDown}>
      <Show when={!mobileFileShowTree()}>
        <FileTabBar onSelectTab={switchToTab} />
        <Toolbar />
      </Show>

      <Show
        when={mobileFileShowTree()}
        fallback={
          <div class="flex-1 overflow-hidden">
            <Show when={error()}>
              <div class="p-4 text-sm" style={{ color: 'var(--c-danger, #ef4444)' }}>
                {error()}
              </div>
            </Show>
            <Show when={loading()}>
              <div class="p-4 text-sm" style={{ color: 'var(--c-text-muted)' }}>
                Loading…
              </div>
            </Show>
            <Show when={hasFile() && !loading()}>
              <Show when={mode() === 'view'}>
                <ViewContent />
              </Show>
              <Show when={mode() === 'edit'}>
                <div ref={editorContainer} class="h-full w-full" />
              </Show>
            </Show>
          </div>
        }
      >
        {/* Mobile file tree */}
        <div class="border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
          <span class="text-[10px] tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
            Files
          </span>
        </div>
        <FileTree class="flex-1" />
      </Show>
    </div>
  )

  // ── Render ──
  return (
    <>
      <div class="hidden h-full md:flex md:flex-col">
        <DesktopLayout />
      </div>
      <div class="flex h-full flex-col md:hidden">
        <MobileLayout />
      </div>

      {/* Context menu (shared) */}
      <Show when={ctxMenu()}>
        {(menu) => (
          <ContextMenu
            x={menu().x}
            y={menu().y}
            node={menu().node}
            rootPath={menu().rootPath}
            onClose={closeCtxMenu}
            onRefresh={() => refreshRoot(menu().rootPath)}
          />
        )}
      </Show>
    </>
  )
}

export default FilePanel
