import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { Router, type RequestHandler } from 'express'
import type { FileService } from './files.js'
import { PathTraversalError, validatePath } from './files.js'
import { buildTree } from './tree.js'

type ProjectResolver = (project: string) => string

export function createFileRouter(
  fileService: FileService,
  authMiddleware?: RequestHandler,
  resolveProject?: ProjectResolver
): Router {
  const router = Router()

  if (authMiddleware) {
    router.use(authMiddleware)
  }

  // Resolve project param: if it looks like a UUID, try to resolve to path; otherwise use as-is
  const resolveProjectPath = (project: string): string => {
    if (resolveProject && /^[0-9a-f]{8}-/.test(project)) {
      return resolveProject(project)
    }
    return project
  }

  // GET /api/files/workspace — list OpenClaw workspace files for file chip resolution
  const openclawWorkspace = process.env.OPENCLAW_WORKSPACE || ''
  router.get('/workspace', (async (_req, res) => {
    if (!openclawWorkspace) {
      res.json({ entries: [] })
      return
    }
    try {
      const depth = 4
      const skip = new Set([
        'node_modules',
        '.git',
        'dist',
        'build',
        '.next',
        '.turbo',
        '__pycache__',
        '.state',
        'temp_outputs'
      ])
      interface Entry {
        name: string
        path: string
        isDirectory: boolean
      }
      const entries: Entry[] = []

      async function scan(dir: string, rel: string, d: number): Promise<void> {
        if (d <= 0) return
        let items: string[]
        try {
          items = await fs.readdir(dir)
        } catch {
          return
        }
        for (const name of items) {
          if (skip.has(name) || name.startsWith('.')) continue
          const full = nodePath.join(dir, name)
          const relPath = rel ? `${rel}/${name}` : name
          try {
            const stat = await fs.stat(full)
            if (stat.isDirectory()) {
              entries.push({ name: relPath, path: full, isDirectory: true })
              await scan(full, relPath, d - 1)
            } else {
              entries.push({ name: relPath, path: full, isDirectory: false })
            }
          } catch {
            /* skip */
          }
        }
      }

      await scan(openclawWorkspace, '', depth)
      res.json({ entries, basePath: openclawWorkspace })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  }) as RequestHandler)

  // GET /api/files/tree?path=...&project=...
  router.get('/tree', (async (req, res) => {
    const dirPath = req.query.path as string | undefined
    const project = req.query.project as string | undefined
    if (!project) {
      res.status(400).json({ error: 'project parameter is required' })
      return
    }
    try {
      const resolved = resolveProjectPath(project)
      const targetPath = dirPath ? `${resolved}/${dirPath}` : resolved
      const nodes = await buildTree(targetPath)
      res.json(nodes)
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  }) as RequestHandler)

  // GET /api/files?path=...&project=...
  router.get('/', (async (req, res) => {
    const filePath = req.query.path as string | undefined
    const project = req.query.project as string | undefined
    if (!project) {
      res.status(400).json({ error: 'project parameter is required' })
      return
    }
    if (!filePath) {
      res.status(400).json({ error: 'path parameter is required' })
      return
    }
    try {
      const resolved = resolveProjectPath(project)
      const content = await fileService.readFile(resolved, filePath)
      res.json(content)
    } catch (err: any) {
      if (err instanceof PathTraversalError) {
        res.status(403).json({ error: err.message })
        return
      }
      res.status(500).json({ error: err.message })
    }
  }) as RequestHandler)

  // PUT /api/files
  router.put('/', (async (req, res) => {
    const { path: filePath, project, content } = req.body ?? {}
    if (!project) {
      res.status(400).json({ error: 'project parameter is required' })
      return
    }
    if (!filePath) {
      res.status(400).json({ error: 'path parameter is required' })
      return
    }
    try {
      await fileService.writeFile(project, filePath, content ?? '')
      res.json({ ok: true })
    } catch (err: any) {
      if (err instanceof PathTraversalError) {
        res.status(403).json({ error: err.message })
        return
      }
      res.status(500).json({ error: err.message })
    }
  }) as RequestHandler)

  // POST /api/files/create — create a new file or directory
  router.post('/create', (async (req, res) => {
    const { project, path: filePath, type } = req.body ?? {}
    if (!project || !filePath) {
      res.status(400).json({ error: 'project and path required' })
      return
    }
    try {
      const resolved = validatePath(project, filePath)
      if (type === 'directory') {
        await fs.mkdir(resolved, { recursive: true })
      } else {
        await fs.mkdir(nodePath.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, '', 'utf-8')
      }
      res.json({ ok: true })
    } catch (err: any) {
      if (err instanceof PathTraversalError) {
        res.status(403).json({ error: err.message })
        return
      }
      res.status(500).json({ error: err.message })
    }
  }) as RequestHandler)

  // POST /api/files/rename — rename a file or directory
  router.post('/rename', (async (req, res) => {
    const { project, oldPath, newName } = req.body ?? {}
    if (!project || !oldPath || !newName) {
      res.status(400).json({ error: 'project, oldPath, and newName required' })
      return
    }
    try {
      const resolvedOld = validatePath(project, oldPath)
      const newPath = nodePath.join(nodePath.dirname(oldPath), newName)
      const resolvedNew = validatePath(project, newPath)
      await fs.rename(resolvedOld, resolvedNew)
      res.json({ ok: true, newPath })
    } catch (err: any) {
      if (err instanceof PathTraversalError) {
        res.status(403).json({ error: err.message })
        return
      }
      res.status(500).json({ error: err.message })
    }
  }) as RequestHandler)

  // POST /api/files/delete — delete a file or directory
  router.post('/delete', (async (req, res) => {
    const { project, path: filePath } = req.body ?? {}
    if (!project || !filePath) {
      res.status(400).json({ error: 'project and path required' })
      return
    }
    try {
      const resolved = validatePath(project, filePath)
      const stat = await fs.stat(resolved)
      if (stat.isDirectory()) {
        await fs.rm(resolved, { recursive: true })
      } else {
        await fs.unlink(resolved)
      }
      res.json({ ok: true })
    } catch (err: any) {
      if (err instanceof PathTraversalError) {
        res.status(403).json({ error: err.message })
        return
      }
      res.status(500).json({ error: err.message })
    }
  }) as RequestHandler)

  return router
}
