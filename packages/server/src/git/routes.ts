import { Router, type Request, type Response } from 'express'
import type { GitService } from './service.js'

export function createGitRoutes(
  gitService: GitService,
  authMiddleware: (req: Request, res: Response, next: () => void) => void
): Router {
  const router = Router()

  router.use(authMiddleware)

  router.get('/status', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId, worktreeId } = req.query as { orgId: string; projectId: string; worktreeId?: string }
      const status = await gitService.status(orgId, projectId, worktreeId)
      res.json(status)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/stage', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId, paths, worktreeId } = req.body as {
        orgId: string
        projectId: string
        paths: string[]
        worktreeId?: string
      }
      await gitService.stage(orgId, projectId, paths, worktreeId)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/unstage', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId, paths, worktreeId } = req.body as {
        orgId: string
        projectId: string
        paths: string[]
        worktreeId?: string
      }
      await gitService.unstage(orgId, projectId, paths, worktreeId)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/commit', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId, message, worktreeId } = req.body as {
        orgId: string
        projectId: string
        message: string
        worktreeId?: string
      }
      const commit = await gitService.commit(orgId, projectId, message, worktreeId)
      res.json(commit)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/push', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId, worktreeId } = req.body as { orgId: string; projectId: string; worktreeId?: string }
      await gitService.push(orgId, projectId, worktreeId)
      res.json({ ok: true })
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('protected branch')) {
        res.status(403).json({ error: message })
      } else {
        res.status(500).json({ error: message })
      }
    }
  })

  router.post('/pull', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId, worktreeId } = req.body as { orgId: string; projectId: string; worktreeId?: string }
      await gitService.pull(orgId, projectId, worktreeId)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/diff', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId, path, worktreeId } = req.query as {
        orgId: string
        projectId: string
        path: string
        worktreeId?: string
      }
      const diff = await gitService.diff(orgId, projectId, path, worktreeId)
      res.json({ diff })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/branches', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId } = req.query as { orgId: string; projectId: string }
      const branches = await gitService.branches(orgId, projectId)
      res.json(branches)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/checkout', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId, branch, create } = req.body as {
        orgId: string
        projectId: string
        branch: string
        create?: boolean
      }
      await gitService.checkout(orgId, projectId, branch, create)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/log', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId, worktreeId, limit } = req.query as {
        orgId: string
        projectId: string
        worktreeId?: string
        limit?: string
      }
      const commits = await gitService.log(orgId, projectId, limit ? parseInt(limit, 10) : undefined, worktreeId)
      res.json(commits)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
