// REST API routes for the holonic task graph.
//
// GET  /api/tasks          — list tasks with optional filters
// GET  /api/tasks/summary  — operational snapshot
// GET  /api/tasks/:id      — full task with relationships
//
// Query params for /api/tasks:
//   state     — filter by task state (pending, in_progress, completed, cancelled)
//   threadId  — filter by assigned thread (use "null" for unassigned)
//   parentId  — only direct children of this task
//   rootsOnly — "true" to show only tasks with no parents

import { Router } from 'express'
import type { Request, Response } from 'express'
import type { TaskService } from './service.js'
import type { ListTaskFilter, TaskState } from './types.js'
import { TASK_STATES } from './types.js'

export interface TaskRouteDeps {
  taskService: TaskService
  resolveLabel?: (threadId: string) => string | undefined
}

export function createTaskRoutes(deps: TaskRouteDeps): Router {
  const router = Router()

  // GET /api/tasks — list with optional filters
  router.get('/api/tasks', async (req: Request, res: Response) => {
    try {
      const filter: ListTaskFilter = {}

      if (req.query.state && typeof req.query.state === 'string') {
        if (TASK_STATES.includes(req.query.state as TaskState)) {
          filter.state = req.query.state as TaskState
        } else {
          res.status(400).json({ error: `Invalid state. Valid: ${TASK_STATES.join(', ')}` })
          return
        }
      }

      if (req.query.threadId !== undefined) {
        const raw = String(req.query.threadId)
        filter.threadId = raw === 'null' ? null : raw
      }

      if (req.query.parentId && typeof req.query.parentId === 'string') {
        filter.parentId = req.query.parentId
      }

      if (req.query.rootsOnly === 'true') {
        filter.rootsOnly = true
      }

      const tasks = await deps.taskService.list(filter)
      res.json({ tasks })
    } catch (err) {
      console.error('[tasks] list failed:', (err as Error)?.message)
      res.status(500).json({ error: 'Failed to list tasks' })
    }
  })

  // GET /api/tasks/summary — operational snapshot
  router.get('/api/tasks/summary', async (_req: Request, res: Response) => {
    try {
      const summary = await deps.taskService.summary(deps.resolveLabel)
      res.json(summary)
    } catch (err) {
      console.error('[tasks] summary failed:', (err as Error)?.message)
      res.status(500).json({ error: 'Failed to get task summary' })
    }
  })

  // GET /api/tasks/graph — all tasks with full relationships for DAG rendering
  router.get('/api/tasks/graph', async (_req: Request, res: Response) => {
    try {
      const items = await deps.taskService.list()
      // Resolve full task records (with parent/child refs) for the graph
      const tasks = await Promise.all(
        items.map(async (item) => {
          const full = await deps.taskService.get(item.id)
          return full
        })
      )
      const resolveLabel = deps.resolveLabel ?? (() => undefined)
      const nodes = tasks.filter(Boolean).map((t) => ({
        ...t!,
        threadLabel: t!.threadId ? (resolveLabel(t!.threadId) ?? t!.threadId) : null
      }))
      res.json({ nodes })
    } catch (err) {
      console.error('[tasks] graph failed:', (err as Error)?.message)
      res.status(500).json({ error: 'Failed to build task graph' })
    }
  })

  // GET /api/tasks/:id — full task with relationships
  router.get('/api/tasks/:id', async (req: Request, res: Response) => {
    try {
      // Task IDs use task:// namespace — the URL param arrives URL-encoded
      const taskId = req.params.id.startsWith('task://') ? req.params.id : `task://${req.params.id}`
      const task = await deps.taskService.get(taskId)
      if (!task) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      res.json(task)
    } catch (err) {
      console.error('[tasks] get failed:', (err as Error)?.message)
      res.status(500).json({ error: 'Failed to get task' })
    }
  })

  return router
}
