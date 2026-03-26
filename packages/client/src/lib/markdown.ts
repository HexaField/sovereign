// Markdown rendering with link, image customization, and workspace-aware file chips

import { marked } from 'marked'
import { createSignal } from 'solid-js'
import { activeWorkspace } from '../features/workspace/store.js'

const renderer = new marked.Renderer()

// External links get target="_blank" and rel="noopener noreferrer"
renderer.link = ({ href, text }) => {
  const isExternal = href?.startsWith('http://') || href?.startsWith('https://')
  const attrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : ''
  return `<a href="${href ?? ''}"${attrs}>${text}</a>`
}

// Images get max-width and rounded corners
renderer.image = ({ href, text }) => {
  return `<img src="${href ?? ''}" alt="${text ?? ''}" style="max-width: 100%; border-radius: 0.375rem;" />`
}

marked.setOptions({ renderer, breaks: true, gfm: true })

// ── Workspace file cache (reactive) ─────────────────────────────────────

/** Reactive version counter — increments when workspace files finish loading */
const [wsFilesVersion, setWsFilesVersion] = createSignal(0)

/** Set of known workspace filenames and relative paths */
let workspaceFiles: Set<string> | null = null
let workspaceFilesLoading = false

/** Map filename → full absolute path */
let workspaceFilePaths: Map<string, string> = new Map()

/** Reverse map: full absolute path → relative display name */
let absoluteToRelative: Map<string, string> = new Map()

/** Last workspace path we loaded files for */
let lastWorkspacePath: string | null = null

async function loadWorkspaceFiles(): Promise<void> {
  const ws = activeWorkspace()
  if (!ws) return

  // Check if we need to reload (workspace changed)
  const wsPath = ws.orgId
  if (wsPath === lastWorkspacePath && workspaceFiles) return
  if (workspaceFilesLoading) return

  workspaceFilesLoading = true
  lastWorkspacePath = wsPath

  try {
    workspaceFiles = new Set()
    workspaceFilePaths = new Map()
    absoluteToRelative = new Map()

    // Load files from each project in the workspace
    const projectsRes = await fetch(`/api/orgs/${encodeURIComponent(ws.orgId)}/projects`)
    if (!projectsRes.ok) return
    const projects: Array<{ id: string; name: string; repoPath: string }> = await projectsRes.json()

    for (const project of projects) {
      try {
        const res = await fetch(`/api/files/tree?project=${encodeURIComponent(project.id)}&path=.&depth=4`)
        if (!res.ok) continue
        const tree = await res.json()

        function walkTree(entries: any[], prefix: string) {
          for (const entry of entries) {
            if (entry.type === 'directory' || entry.isDirectory) {
              if (['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '__pycache__'].includes(entry.name))
                continue
              const subPath = prefix ? `${prefix}/${entry.name}` : entry.name
              if (entry.children) walkTree(entry.children, subPath)
            } else {
              const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
              const absPath = entry.path || `${project.repoPath}/${relPath}`

              workspaceFiles!.add(relPath)
              workspaceFilePaths.set(relPath, absPath)
              absoluteToRelative.set(absPath, relPath)

              // Also store bare filename for short references (first wins)
              if (!workspaceFilePaths.has(entry.name)) {
                workspaceFiles!.add(entry.name)
                workspaceFilePaths.set(entry.name, absPath)
              }
            }
          }
        }

        const entries = tree.entries || tree.children || (Array.isArray(tree) ? tree : [])
        walkTree(entries, '')
      } catch {
        /* skip failed projects */
      }
    }

    // Also load OpenClaw workspace files (membranes, memory, etc.)
    try {
      const wsRes = await fetch('/api/files/workspace')
      if (wsRes.ok) {
        const wsData = await wsRes.json()
        const entries: Array<{ name: string; path: string; isDirectory: boolean }> = wsData.entries || []
        for (const e of entries) {
          if (e.isDirectory) continue
          const relPath = e.name
          const absPath = e.path
          workspaceFiles!.add(relPath)
          if (!workspaceFilePaths.has(relPath)) workspaceFilePaths.set(relPath, absPath)
          absoluteToRelative.set(absPath, relPath)
          // Also store bare filename
          const bareName = relPath.split('/').pop() || relPath
          if (!workspaceFilePaths.has(bareName)) {
            workspaceFiles!.add(bareName)
            workspaceFilePaths.set(bareName, absPath)
          }
        }
      }
    } catch {
      /* ignore */
    }

    setWsFilesVersion((v) => v + 1)
  } catch {
    /* ignore — will render without chips */
  } finally {
    workspaceFilesLoading = false
  }
}

// Kick off loading
loadWorkspaceFiles()

/** Refresh the cache (call after workspace change or periodically) */
export function refreshWorkspaceFiles(): void {
  workspaceFiles = null
  workspaceFilesLoading = false
  lastWorkspacePath = null
  loadWorkspaceFiles()
}

// ── File chip injection ──────────────────────────────────────────────────

function makeChip(filePath: string, displayName: string): string {
  return `<span class="file-chip" data-file-path="${filePath}" title="${filePath}">📄 ${displayName}<button class="file-chip-copy" data-copy-path="${filePath}" title="Copy path">⧉</button></span>`
}

/** Build regex matching workspace filenames, longest first */
function buildFilenameRe(): RegExp | null {
  if (!workspaceFiles || workspaceFiles.size === 0) return null
  const names = [...workspaceFiles].sort((a, b) => b.length - a.length)
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp('`?(' + escaped.join('|') + ')`?', 'g')
}

/** Wrap detected file paths and workspace filenames in clickable chips */
function injectFileChips(html: string): string {
  // Phase 1: absolute paths — only chip if file exists in workspace cache
  let result = html.replace(
    /(<(?:a|code|pre)[^>]*>[\s\S]*?<\/(?:a|code|pre)>)|(?<![="'(])(\/([\w.+-]+\/)*[\w.+-]+\.\w{1,10})(?![="')\w])/gi,
    (match, tag, path) => {
      if (tag) return tag
      if (!path) return match
      if (workspaceFiles && absoluteToRelative.size > 0) {
        const relPath = absoluteToRelative.get(path)
        if (!relPath) return match // Not a known workspace file — leave as plain text
        return makeChip(path, relPath)
      }
      return match
    }
  )

  // Phase 2: workspace filenames in <code> tags and plain text
  if (workspaceFiles && workspaceFiles.size > 0) {
    const filenameRe = buildFilenameRe()
    if (filenameRe) {
      // Replace <code>FILENAME</code> with chips
      result = result.replace(/<code>([^<]+)<\/code>/gi, (_match, inner) => {
        const trimmed = inner.trim()
        if (workspaceFiles!.has(trimmed)) {
          const fullPath = workspaceFilePaths.get(trimmed) || trimmed
          return makeChip(fullPath, trimmed)
        }
        return _match
      })

      // Bare filenames in plain text (skip existing tags)
      result = result.replace(/(<(?:a|code|pre|span)[^>]*>[\s\S]*?<\/(?:a|code|pre|span)>)/gi, '\x00$1\x00')
      const parts = result.split('\x00')
      result = parts
        .map((part) => {
          if (part.startsWith('<')) return part
          return part.replace(filenameRe, (_match, name) => {
            if (!workspaceFiles!.has(name)) return _match
            const fullPath = workspaceFilePaths.get(name) || name
            return makeChip(fullPath, name)
          })
        })
        .join('')
    }
  }

  return result
}

/**
 * Convert markdown text to HTML.
 */
export function renderMarkdown(text: string): string {
  // Access reactive signal so callers inside createMemo/JSX re-run when files load
  wsFilesVersion()
  try {
    let html = marked.parse(text, { async: false }) as string
    html = injectFileChips(html)
    return html
  } catch {
    return escapeHtml(text)
  }
}

/**
 * Strip thinking blocks from message content.
 */
export function stripThinkingBlocks(text: string): string {
  if (!text) return text

  const codeSlots: string[] = []
  let protected_ = text.replace(/(`{1,})([\s\S]*?)\1/g, (m) => {
    codeSlots.push(m)
    return `\x00CODE${codeSlots.length - 1}\x00`
  })

  protected_ = protected_.replace(/<(think(?:ing)?|thought|antthinking)[^>]*>[\s\S]*?<\/\1>/gi, '')
  protected_ = protected_.replace(/<details\s+class="thinking">[\s\S]*?<\/details>/gi, '')
  protected_ = protected_.replace(/<(?:think(?:ing)?|thought|antthinking)[^>]*>[\s\S]*$/gi, '')
  protected_ = protected_.replace(/<details\s+class="thinking">[\s\S]*$/gi, '')
  protected_ = protected_.replace(/<\/(?:think(?:ing)?|thought|antthinking)[^>]*>/gi, '')

  return protected_.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeSlots[Number(i)]).trim()
}

export function escapeHtml(text: string): string {
  if (typeof document === 'undefined') {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
