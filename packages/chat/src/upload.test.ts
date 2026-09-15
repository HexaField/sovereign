import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readUploadedFile } from './routes.js'

// ── Test helpers ───────────────────────────────────────────────────────

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'))

  // Create test files with UUID-prefix naming (matches multer storage)
  fs.writeFileSync(path.join(tmpDir, 'a1b2c3d4-data.csv'), 'col1,col2\nval1,val2')
  fs.writeFileSync(path.join(tmpDir, 'b2c3d4e5-config.json'), '{"key":"value"}')
  fs.writeFileSync(path.join(tmpDir, 'c3d4e5f6-notes.md'), '# Notes\nSome content here.')
  fs.writeFileSync(path.join(tmpDir, 'd4e5f6g7-server.log'), 'ERROR something broke\n'.repeat(1000))
  fs.writeFileSync(path.join(tmpDir, 'e5f6g7h8-app.ts'), 'export function main() { return 42 }')
  fs.writeFileSync(path.join(tmpDir, 'f6g7h8i9-photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(tmpDir, 'g7h8i9j0-doc.pdf'), Buffer.from('%PDF-1.4'))
  fs.writeFileSync(path.join(tmpDir, 'h8i9j0k1-image.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── readUploadedFile ───────────────────────────────────────────────────

describe('readUploadedFile — text files get path only, no data', () => {
  it('CSV: returns path, no data buffer', () => {
    const att = readUploadedFile(path.join(tmpDir, 'a1b2c3d4-data.csv'), tmpDir)
    expect(att).not.toBeNull()
    expect(att!.name).toBe('data.csv')
    expect(att!.mediaType).toBe('text/csv')
    expect(att!.path).toBe(path.resolve(tmpDir, 'a1b2c3d4-data.csv'))
    expect(att!.data).toBeUndefined()
  })

  it('JSON: returns path, no data buffer', () => {
    const att = readUploadedFile(path.join(tmpDir, 'b2c3d4e5-config.json'), tmpDir)
    expect(att).not.toBeNull()
    expect(att!.name).toBe('config.json')
    expect(att!.mediaType).toBe('application/json')
    expect(att!.path).toBeDefined()
    expect(att!.data).toBeUndefined()
  })

  it('Markdown: returns path, no data buffer', () => {
    const att = readUploadedFile(path.join(tmpDir, 'c3d4e5f6-notes.md'), tmpDir)
    expect(att).not.toBeNull()
    expect(att!.name).toBe('notes.md')
    expect(att!.mediaType).toBe('text/markdown')
    expect(att!.data).toBeUndefined()
  })

  it('Log file: returns path, no data buffer — large files stay on disk', () => {
    const att = readUploadedFile(path.join(tmpDir, 'd4e5f6g7-server.log'), tmpDir)
    expect(att).not.toBeNull()
    expect(att!.name).toBe('server.log')
    expect(att!.mediaType).toBe('text/plain')
    expect(att!.path).toBeDefined()
    expect(att!.data).toBeUndefined()
  })

  it('TypeScript: returns path, no data buffer', () => {
    const att = readUploadedFile(path.join(tmpDir, 'e5f6g7h8-app.ts'), tmpDir)
    expect(att).not.toBeNull()
    expect(att!.name).toBe('app.ts')
    expect(att!.mediaType).toBe('text/plain')
    expect(att!.data).toBeUndefined()
  })
})

describe('readUploadedFile — binary files get data loaded', () => {
  it('PNG: loads data buffer for inline base64', () => {
    const att = readUploadedFile(path.join(tmpDir, 'f6g7h8i9-photo.png'), tmpDir)
    expect(att).not.toBeNull()
    expect(att!.name).toBe('photo.png')
    expect(att!.mediaType).toBe('image/png')
    expect(att!.data).toBeInstanceOf(Buffer)
    expect(att!.data!.length).toBeGreaterThan(0)
    expect(att!.path).toBeDefined()
  })

  it('PDF: loads data buffer for inline base64', () => {
    const att = readUploadedFile(path.join(tmpDir, 'g7h8i9j0-doc.pdf'), tmpDir)
    expect(att).not.toBeNull()
    expect(att!.name).toBe('doc.pdf')
    expect(att!.mediaType).toBe('application/pdf')
    expect(att!.data).toBeInstanceOf(Buffer)
    expect(att!.path).toBeDefined()
  })

  it('JPEG: loads data buffer for inline base64', () => {
    const att = readUploadedFile(path.join(tmpDir, 'h8i9j0k1-image.jpg'), tmpDir)
    expect(att).not.toBeNull()
    expect(att!.name).toBe('image.jpg')
    expect(att!.mediaType).toBe('image/jpeg')
    expect(att!.data).toBeInstanceOf(Buffer)
  })
})

describe('readUploadedFile — security', () => {
  it('rejects path traversal attempts', () => {
    const att = readUploadedFile(path.join(tmpDir, '..', 'etc', 'passwd'), tmpDir)
    expect(att).toBeNull()
  })

  it('rejects absolute paths outside allowed directory', () => {
    const att = readUploadedFile('/etc/passwd', tmpDir)
    expect(att).toBeNull()
  })
})

describe('readUploadedFile — name stripping', () => {
  it('strips UUID prefix from filename', () => {
    const att = readUploadedFile(path.join(tmpDir, 'a1b2c3d4-data.csv'), tmpDir)
    expect(att!.name).toBe('data.csv')
  })
})
