import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createFileService, PathTraversalError, detectLanguage } from './files.js'
import { createEventBus } from '@template/core'
import type { BusEvent } from '@template/core'

let tmpDir: string
let bus: ReturnType<typeof createEventBus>
let service: ReturnType<typeof createFileService>

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovereign-files-'))
  const busDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovereign-bus-'))
  bus = createEventBus(busDir)
  service = createFileService(bus)
  // Create sample files
  await fs.writeFile(path.join(tmpDir, 'hello.ts'), 'export const x = 1', 'utf-8')
  await fs.writeFile(path.join(tmpDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('File Service', () => {
  it('reads a file from a project repo', async () => {
    const result = await service.readFile(tmpDir, 'hello.ts')
    expect(result.content).toBe('export const x = 1')
    expect(result.encoding).toBe('utf-8')
    expect(result.path).toBe('hello.ts')
    expect(result.size).toBeGreaterThan(0)
  })

  it('reads a binary file as base64', async () => {
    const result = await service.readFile(tmpDir, 'image.png')
    expect(result.encoding).toBe('base64')
    expect(result.content).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))
  })

  it('writes a file to a project repo', async () => {
    await service.writeFile(tmpDir, 'newfile.txt', 'hello world')
    const content = await fs.readFile(path.join(tmpDir, 'newfile.txt'), 'utf-8')
    expect(content).toBe('hello world')
  })

  it('detects language from file extension', () => {
    expect(detectLanguage('foo.ts')).toBe('typescript')
    expect(detectLanguage('foo.js')).toBe('javascript')
    expect(detectLanguage('foo.py')).toBe('python')
    expect(detectLanguage('foo.json')).toBe('json')
    expect(detectLanguage('foo.md')).toBe('markdown')
    expect(detectLanguage('foo.unknown')).toBeUndefined()
  })

  it('rejects path traversal attempts with error', async () => {
    await expect(service.readFile(tmpDir, '../../../etc/passwd')).rejects.toThrow(PathTraversalError)
  })

  it('rejects paths outside project repo', async () => {
    await expect(service.readFile(tmpDir, '/etc/passwd')).rejects.toThrow(PathTraversalError)
  })

  it('emits file.created on the bus when creating a new file', async () => {
    const events: BusEvent[] = []
    bus.on('file.created', (e) => {
      events.push(e)
    })
    await service.writeFile(tmpDir, 'brand-new.txt', 'content')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('file.created')
    expect((events[0].payload as any).path).toBe('brand-new.txt')
  })

  it('emits file.deleted on the bus when deleting a file', async () => {
    const events: BusEvent[] = []
    bus.on('file.deleted', (e) => {
      events.push(e)
    })
    await service.deleteFile(tmpDir, 'hello.ts')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('file.deleted')
  })
})

describe('File Tree', () => {
  it('lists directory contents as FileTreeNode array', async () => {
    const { buildTree } = await import('./tree.js')
    const nodes = await buildTree(tmpDir)
    expect(nodes.length).toBeGreaterThanOrEqual(2)
  })

  it('returns type file or directory correctly', async () => {
    const { buildTree } = await import('./tree.js')
    await fs.mkdir(path.join(tmpDir, 'subdir'))
    const nodes = await buildTree(tmpDir)
    const dir = nodes.find((n) => n.name === 'subdir')
    const file = nodes.find((n) => n.name === 'hello.ts')
    expect(dir?.type).toBe('directory')
    expect(file?.type).toBe('file')
  })

  it('includes file size', async () => {
    const { buildTree } = await import('./tree.js')
    const nodes = await buildTree(tmpDir)
    const file = nodes.find((n) => n.name === 'hello.ts')
    expect(file?.size).toBeGreaterThan(0)
  })

  it('does not recurse into children (lazy loading)', async () => {
    const { buildTree } = await import('./tree.js')
    await fs.mkdir(path.join(tmpDir, 'subdir'))
    await fs.writeFile(path.join(tmpDir, 'subdir', 'nested.ts'), 'x')
    const nodes = await buildTree(tmpDir)
    const dir = nodes.find((n) => n.name === 'subdir')
    expect(dir?.children).toBeUndefined()
  })

  it('excludes .git directory', async () => {
    const { buildTree } = await import('./tree.js')
    await fs.mkdir(path.join(tmpDir, '.git'))
    const nodes = await buildTree(tmpDir)
    expect(nodes.find((n) => n.name === '.git')).toBeUndefined()
  })

  it('handles empty directories', async () => {
    const { buildTree } = await import('./tree.js')
    const emptyDir = path.join(tmpDir, 'empty')
    await fs.mkdir(emptyDir)
    const nodes = await buildTree(emptyDir)
    expect(nodes).toEqual([])
  })
})

describe('File Tree (detailed)', () => {
  it('sorts directories before files', async () => {
    const { buildTree } = await import('./tree.js')
    await fs.mkdir(path.join(tmpDir, 'zdir'))
    await fs.writeFile(path.join(tmpDir, 'afile.txt'), 'x')
    const nodes = await buildTree(tmpDir)
    const firstDir = nodes.findIndex((n) => n.type === 'directory')
    const firstFile = nodes.findIndex((n) => n.type === 'file')
    if (firstDir !== -1 && firstFile !== -1) {
      expect(firstDir).toBeLessThan(firstFile)
    }
  })

  it('sorts entries alphabetically within groups', async () => {
    const { buildTree } = await import('./tree.js')
    await fs.writeFile(path.join(tmpDir, 'zebra.ts'), 'x')
    await fs.writeFile(path.join(tmpDir, 'alpha.ts'), 'x')
    const nodes = await buildTree(tmpDir)
    const files = nodes.filter((n) => n.type === 'file')
    const names = files.map((n) => n.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    expect(names).toEqual(sorted)
  })
})

describe('File Routes', () => {
  it('GET /api/files?path=...&project=... returns file content', async () => {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const { createFileRouter } = await import('./routes.js')
    const app = express()
    app.use('/api/files', createFileRouter(service))
    const res = await request(app).get(`/api/files?path=hello.ts&project=${tmpDir}`)
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('export const x = 1')
  })

  it('PUT /api/files writes file content', async () => {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const { createFileRouter } = await import('./routes.js')
    const app = express()
    app.use(express.json())
    app.use('/api/files', createFileRouter(service))
    const res = await request(app).put('/api/files').send({ path: 'written.txt', project: tmpDir, content: 'hello' })
    expect(res.status).toBe(200)
    const content = await fs.readFile(path.join(tmpDir, 'written.txt'), 'utf-8')
    expect(content).toBe('hello')
  })

  it('GET /api/files/tree?path=...&project=... returns directory listing', async () => {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const { createFileRouter } = await import('./routes.js')
    const app = express()
    app.use('/api/files', createFileRouter(service))
    const res = await request(app).get(`/api/files/tree?project=${tmpDir}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  it('rejects path traversal with 403', async () => {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const { createFileRouter } = await import('./routes.js')
    const app = express()
    app.use('/api/files', createFileRouter(service))
    const res = await request(app).get(`/api/files?path=../../../etc/passwd&project=${tmpDir}`)
    expect(res.status).toBe(403)
  })

  it('rejects missing project parameter with 400', async () => {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const { createFileRouter } = await import('./routes.js')
    const app = express()
    app.use('/api/files', createFileRouter(service))
    const res = await request(app).get('/api/files?path=hello.ts')
    expect(res.status).toBe(400)
  })

  it('all routes reject unauthenticated requests with 401', async () => {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const { createFileRouter } = await import('./routes.js')
    const authMiddleware: any = (_req: any, res: any) => {
      res.status(401).json({ error: 'unauthorized' })
    }
    const app = express()
    app.use(express.json())
    app.use('/api/files', createFileRouter(service, authMiddleware))
    const r1 = await request(app).get(`/api/files?path=hello.ts&project=${tmpDir}`)
    const r2 = await request(app).put('/api/files').send({ path: 'x', project: tmpDir, content: '' })
    const r3 = await request(app).get(`/api/files/tree?project=${tmpDir}`)
    expect(r1.status).toBe(401)
    expect(r2.status).toBe(401)
    expect(r3.status).toBe(401)
  })
})
