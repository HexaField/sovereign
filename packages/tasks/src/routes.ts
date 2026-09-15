// Tasks Module — REST API Routes
//
// Exposes the task graph to the client UI. The MCP tools handle agent
// interactions; these routes serve the sidebar panel and task detail views.

import { Router } from 'express'
import type { Request, Response } from 'express'
import type { TaskService } from './service.js'
import type { PrPollService } from './pr-poll.js'

export interface TaskRouteDeps {
  taskService: TaskService
  prPollService: PrPollService
  /** Send a prompt to a thread. */
  sendToThread: (threadId: string, text: string) => Promise<void>
  /** Resolve a thread label from its id. */
  resolveLabel?: (threadId: string) => string | undefined
}

export function createTaskRoutes(deps: TaskRouteDeps): Router {
  const { taskService, prPollService, sendToThread, resolveLabel } = deps
  const router = Router()

  // GET /api/tasks — list tasks with optional filters
  router.get('/api/tasks', async (req: Request, res: Response) => {
    try {
      const filter: Record<string, unknown> = {}
      if (req.query.state) filter.state = req.query.state
      if (req.query.threadId) filter.threadId = req.query.threadId
      if (req.query.parentId) filter.parentId = req.query.parentId
      if (req.query.rootsOnly === 'true') filter.rootsOnly = true
      if (req.query.threadId === 'null') filter.threadId = null

      const list = await taskService.list(filter as any)
      res.json({ tasks: list })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/tasks/summary — operational overview
  router.get('/api/tasks/summary', async (_req: Request, res: Response) => {
    try {
      const summary = await taskService.summary(resolveLabel)
      res.json(summary)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/tasks/:id — single task with full graph
  router.get('/api/tasks/:id', async (req: Request, res: Response) => {
    try {
      const taskId = `task://${req.params.id}`
      const task = await taskService.get(taskId)
      if (!task) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      res.json(task)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/tasks/:id/send-prompt — send a message to the task's thread
  router.post('/api/tasks/:id/send-prompt', async (req: Request, res: Response) => {
    try {
      const taskId = `task://${req.params.id}`
      const { prompt } = req.body as { prompt?: string }
      if (!prompt) {
        res.status(400).json({ error: 'prompt required' })
        return
      }

      const task = await taskService.get(taskId)
      if (!task) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      if (!task.threadId) {
        res.status(400).json({ error: 'Task has no assigned thread' })
        return
      }

      await sendToThread(task.threadId, prompt)
      res.json({ ok: true, threadId: task.threadId })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/tasks/import-pr — import a GitHub PR as a task
  router.post('/api/tasks/import-pr', async (req: Request, res: Response) => {
    try {
      const { repo, pr, threadId, parentTaskIds, tags, prompt, pollIntervalMinutes } = req.body as {
        repo: string
        pr: number
        threadId?: string
        parentTaskIds?: string[]
        tags?: string[]
        prompt?: string
        pollIntervalMinutes?: number
      }

      if (!repo || !pr) {
        res.status(400).json({ error: 'repo and pr required' })
        return
      }

      const task = await prPollService.importPr({
        repo,
        pr,
        threadId,
        parentTaskIds,
        tags,
        prompt,
        pollIntervalMinutes,
        sourceThreadId: 'api'
      })

      res.json(task)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/tasks/:id/poll — force a single poll tick
  router.post('/api/tasks/:id/poll', async (req: Request, res: Response) => {
    try {
      const taskId = `task://${req.params.id}`
      await prPollService.pollOnce(taskId)
      const task = await taskService.get(taskId)
      res.json(task)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
