import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { Router, type RequestHandler } from 'express'
import type { FileService } from './files.js'
import { PathTraversalError, validatePath } from './files.js'
import { buildTree } from './tree.js'

export function createFileRouter(fileService: FileService, authMiddleware?: RequestHandler): Router {
  const router = Router()

  if (authMiddleware) {
    router.use(authMiddleware)
  }

  // GET /api/files/tree?path=...&project=...
  router.get('/tree', (async (req, res) => {
    const dirPath = req.query.path as string | undefined
    const project = req.query.project as string | undefined
    if (!project) {
      res.status(400).json({ error: 'project parameter is required' })
      return
    }
    try {
      const targetPath = dirPath ? `${project}/${dirPath}` : project
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
      const content = await fileService.readFile(project, filePath)
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
