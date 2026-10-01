import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import { BrowserUnavailableError, createBrowserService } from '@sovereign/browser'
import { createExportRoutes, MAX_EXPORT_MARKDOWN } from './export-pdf.js'

function appWith(printPdf: (html: string) => Promise<Buffer>) {
  const app = express()
  app.use(express.json({ limit: '50mb' }))
  app.use(createExportRoutes({ printPdf }))
  return app
}

describe('POST /api/export/pdf', () => {
  it('prints the markdown as HTML and answers with the PDF bytes', async () => {
    const printPdf = vi.fn(async (_html: string) => Buffer.from('%PDF-fake'))
    const res = await request(appWith(printPdf))
      .post('/api/export/pdf')
      .send({ markdown: '# Chat Export\n\n**You** — hello' })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(Buffer.from(res.body).toString()).toBe('%PDF-fake')
    const html = printPdf.mock.calls[0][0]
    expect(html).toContain('<h1>Chat Export</h1>')
    expect(html).toContain('<strong>You</strong>')
  })

  it('rejects a missing or empty markdown body, and an oversized one', async () => {
    const printPdf = vi.fn(async () => Buffer.from(''))
    const app = appWith(printPdf)
    expect((await request(app).post('/api/export/pdf').send({})).status).toBe(400)
    expect((await request(app).post('/api/export/pdf').send({ markdown: '  ' })).status).toBe(400)
    const big = 'x'.repeat(MAX_EXPORT_MARKDOWN + 1)
    expect((await request(app).post('/api/export/pdf').send({ markdown: big })).status).toBe(413)
    expect(printPdf).not.toHaveBeenCalled()
  })

  it('answers 503 when no browser is installed and 500 when printing fails', async () => {
    const missing = appWith(async () => {
      throw new BrowserUnavailableError('no chrome')
    })
    expect((await request(missing).post('/api/export/pdf').send({ markdown: 'x' })).status).toBe(503)
    const broken = appWith(async () => {
      throw new Error('crashed')
    })
    expect((await request(broken).post('/api/export/pdf').send({ markdown: 'x' })).status).toBe(500)
  })
})

const chrome = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]
  .concat(process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [])
  .some((p) => existsSync(p))

describe.skipIf(!chrome)('POST /api/export/pdf with a real browser', () => {
  it('returns a real PDF, and never loads remote content from the markdown', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sov-export-pdf-'))
    const browser = createBrowserService(dataDir)
    try {
      const started = Date.now()
      const res = await request(appWith((html) => browser.printPdf(html)))
        .post('/api/export/pdf')
        .send({ markdown: '# Export\n\n![remote](http://10.255.255.1/x.png)\n\n```ts\nconst a = 1\n```' })
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = []
          r.on('data', (c: Buffer) => chunks.push(c))
          r.on('end', () => cb(null, Buffer.concat(chunks)))
        })
      expect(res.status).toBe(200)
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-')
      // An unroutable image would stall the load; blocked, it returns at once.
      expect(Date.now() - started).toBeLessThan(15_000)
    } finally {
      await browser.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})
