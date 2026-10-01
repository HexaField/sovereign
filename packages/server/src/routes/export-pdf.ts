import { Router } from 'express'
import { Marked } from 'marked'
import { BrowserUnavailableError } from '@sovereign/browser'

/** Largest markdown body accepted for one export. */
export const MAX_EXPORT_MARKDOWN = 5 * 1024 * 1024

const marked = new Marked({ gfm: true, breaks: true })

const STYLE = `
  body { font: 11pt/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1c1917; }
  h1 { font-size: 18pt; margin: 0 0 6pt; }
  h2, h3 { margin: 14pt 0 4pt; }
  hr { border: 0; border-top: 1px solid #d6d3d1; margin: 14pt 0; }
  pre { background: #f5f5f4; padding: 8pt; border-radius: 4pt; white-space: pre-wrap; word-break: break-word; }
  code { font: 9.5pt ui-monospace, SFMono-Regular, Menlo, monospace; }
  table { border-collapse: collapse; } td, th { border: 1px solid #d6d3d1; padding: 3pt 6pt; }
  blockquote { margin: 0; padding-left: 10pt; border-left: 3px solid #d6d3d1; color: #57534e; }
  img { max-width: 100%; }
`

/** Render chat markdown as a standalone, printable HTML document. */
export function markdownToPrintableHtml(markdown: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${marked.parse(markdown)}</body></html>`
}

/**
 * `POST /api/export/pdf` — `{ markdown }` → `application/pdf`. The chat's
 * thread and message export menus call it.
 */
export function createExportRoutes(browser: { printPdf(html: string): Promise<Buffer> }): Router {
  const router = Router()

  router.post('/api/export/pdf', async (req, res) => {
    const markdown = req.body?.markdown
    if (typeof markdown !== 'string' || markdown.trim() === '') {
      return res.status(400).json({ error: 'markdown (non-empty string) required' })
    }
    if (markdown.length > MAX_EXPORT_MARKDOWN) {
      return res.status(413).json({ error: `markdown exceeds ${MAX_EXPORT_MARKDOWN} characters` })
    }
    try {
      const pdf = await browser.printPdf(markdownToPrintableHtml(markdown))
      res.type('application/pdf').send(pdf)
    } catch (err) {
      const status = err instanceof BrowserUnavailableError ? 503 : 500
      res.status(status).json({ error: 'PDF export failed', detail: (err as Error).message })
    }
  })

  return router
}
