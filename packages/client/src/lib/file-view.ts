// How chips and the file viewer show a file: HTML as a page, images as
// images, markdown rendered, anything else as text. HTML and images load from
// /api/files/view/<absolute path>, so a page's relative links resolve to the
// files beside it and the server's CSP sandbox applies.

export type FileRenderKind = 'html' | 'image' | 'markdown' | 'text'

const IMAGE_EXTENSIONS = new Set(['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

export function fileExtension(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function fileRenderKind(path: string): FileRenderKind {
  const ext = fileExtension(path)
  if (ext === 'html' || ext === 'htm') return 'html'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  return 'text'
}

/** URL that serves the file itself; each path segment is encoded, the slashes stay. */
export function fileViewUrl(absPath: string, version?: number | string): string {
  const encoded = absPath
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
  const base = `/api/files/view${absPath.startsWith('/') ? '' : '/'}${encoded}`
  return version === undefined ? base : `${base}?v=${encodeURIComponent(String(version))}`
}

/**
 * Sandbox for a rendered HTML file: scripts run (interactive pages work), but in
 * an opaque origin — no Sovereign cookies, storage or same-origin API access.
 */
export const HTML_SANDBOX = 'allow-scripts allow-popups allow-forms allow-modals'
