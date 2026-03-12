import { Router, type RequestHandler } from 'express'
import type { FileService } from './files.js'
import { PathTraversalError } from './files.js'
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

  return router
}
