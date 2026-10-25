// Tasks Module — REST API Routes
//
// Exposes the task graph to the client UI. The MCP tools handle agent
// interactions. Forge views and suggested edges are served by the work graph
// (/api/forge/*, packages/work-graph routes), which reaches them via TaskPort.

import { Router } from 'express'
import type { Request, Response } from 'express'
import type { TaskService } from './service.js'
import type { TaskImporter } from './import.js'
import type { ForgeMetaStore } from './meta.js'
import type { ListTaskFilter, TaskState } from './types.js'
import { PROVIDER_KINDS, TASK_STATES } from './types.js'

export interface TaskRouteDeps {
  taskService: TaskService
  importer?: TaskImporter
  /** Persistence health of the Forge meta store, shown beside the task store's. */
  meta?: Pick<ForgeMetaStore, 'status'>
  /** Re-read a task's forge item now (the work graph's poll); absent = 503. */
  pollTask?: (taskId: string) => Promise<void>
  /** Send a prompt to a thread. */
  sendToThread: (threadId: string, text: string) => Promise<void>
  /** Resolve a thread label from its id. */
  resolveLabel?: (threadId: string) => string | undefined
  /** A thread's membrane, the default for tasks created on its behalf. */
  membraneOf?: (threadId: string) => string | undefined
}

/** Route ids are the uuid part of "task://<uuid>"; a full encoded id works too. */
function taskIdOf(param: string): string {
  const decoded = decodeURIComponent(param)
  return decoded.startsWith('task://') ? decoded : `task://${decoded}`
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** An import or poll the membrane's forge.trustedAuthors refuses. */
const UNTRUSTED = /author not in forge\.trustedAuthors/

function fail(res: Response, err: unknown): void {
  const msg = (err as Error).message ?? String(err)
  const status = UNTRUSTED.test(msg)
    ? 403
    : /not found/i.test(msg)
      ? 404
      : /already exists|cycle|needs|invalid|unrecognised|not a /i.test(msg)
        ? 400
        : 500
  res.status(status).json({ error: msg })
}

export function parseListFilter(q: Record<string, unknown>): ListTaskFilter {
  const filter: ListTaskFilter = {}
  const state = str(q.state)
  if (state && TASK_STATES.includes(state as TaskState)) filter.state = state as TaskState
  if (q.threadId === 'null') filter.threadId = null
  else if (str(q.threadId)) filter.threadId = str(q.threadId)
  if (str(q.parentId)) filter.parentId = str(q.parentId)
  if (q.rootsOnly === 'true') filter.rootsOnly = true
  if (str(q.membrane)) filter.membrane = str(q.membrane)
  if (str(q.repo)) filter.repo = str(q.repo)
  if (str(q.workstream)) filter.workstream = str(q.workstream)
  const kind = str(q.providerKind)
  if (kind && (kind === 'none' || PROVIDER_KINDS.includes(kind as never))) filter.providerKind = kind as never
  if (q.isStream === 'true') filter.isStream = true
  else if (q.isStream === 'false') filter.isStream = false
  return filter
}

export function createTaskRoutes(deps: TaskRouteDeps): Router {
  const { taskService, pollTask, sendToThread, resolveLabel, importer, meta, membraneOf } = deps
  const router = Router()

  // GET /api/tasks — list tasks with optional filters
  router.get('/api/tasks', async (req: Request, res: Response) => {
    try {
      const list = await taskService.list(parseListFilter(req.query as Record<string, unknown>))
      res.json({ tasks: list })
    } catch (err) {
      fail(res, err)
    }
  })

  // POST /api/tasks — create a task (or a stream with isStream: true)
  router.post('/api/tasks', async (req: Request, res: Response) => {
    try {
      const b = req.body as Record<string, any>
      if (!str(b.name)) {
        res.status(400).json({ error: 'name required' })
        return
      }
      const threadId = str(b.threadId) ?? null
      const task = await taskService.create({
        name: b.name,
        description: str(b.description),
        parentTaskIds: Array.isArray(b.parentTaskIds) ? b.parentTaskIds : undefined,
        tags: Array.isArray(b.tags) ? b.tags : undefined,
        membrane: str(b.membrane) ?? (threadId ? membraneOf?.(threadId) : undefined) ?? null,
        isStream: b.isStream === true,
        provider: b.provider,
        autoAssign: !!threadId,
        sourceThreadId: threadId ?? 'api'
      })
      res.status(201).json(task)
    } catch (err) {
      fail(res, err)
    }
  })

  // GET /api/tasks/summary — operational overview
  router.get('/api/tasks/summary', async (_req: Request, res: Response) => {
    try {
      const summary = await taskService.summary(resolveLabel)
      res.json(summary)
    } catch (err) {
      fail(res, err)
    }
  })

  // GET /api/tasks/store-status — persistence health (AD4M, outbox, snapshot)
  router.get('/api/tasks/store-status', (_req: Request, res: Response) => {
    res.json({ tasks: taskService.storeStatus(), meta: meta?.status() ?? null })
  })

  // GET /api/tasks/streams — work streams
  router.get('/api/tasks/streams', async (req: Request, res: Response) => {
    try {
      res.json({ streams: await taskService.listStreams(str(req.query.membrane)) })
    } catch (err) {
      fail(res, err)
    }
  })

  // POST /api/tasks/link | /api/tasks/unlink — { parentId, childId }
  router.post('/api/tasks/link', async (req: Request, res: Response) => {
    try {
      const { parentId, childId } = req.body as { parentId?: string; childId?: string }
      if (!parentId || !childId) {
        res.status(400).json({ error: 'parentId and childId required' })
        return
      }
      await taskService.link(parentId, childId, 'api')
      res.json({ linked: true })
    } catch (err) {
      fail(res, err)
    }
  })

  router.post('/api/tasks/unlink', async (req: Request, res: Response) => {
    try {
      const { parentId, childId } = req.body as { parentId?: string; childId?: string }
      if (!parentId || !childId) {
        res.status(400).json({ error: 'parentId and childId required' })
        return
      }
      await taskService.unlink(parentId, childId, 'api')
      res.json({ unlinked: true })
    } catch (err) {
      fail(res, err)
    }
  })

  // POST /api/tasks/import — { ref | url | plan, threadId?, parentTaskIds?, tags?, prompt?, membrane? }
  router.post('/api/tasks/import', async (req: Request, res: Response) => {
    if (!importer) {
      res.status(503).json({ error: 'task import not available' })
      return
    }
    try {
      const b = req.body as Record<string, any>
      const threadId = str(b.threadId)
      const result = await importer.import({
        ref: str(b.ref),
        url: str(b.url),
        plan: b.plan,
        threadId,
        parentTaskIds: Array.isArray(b.parentTaskIds) ? b.parentTaskIds : undefined,
        tags: Array.isArray(b.tags) ? b.tags : undefined,
        prompt: str(b.prompt),
        membrane: str(b.membrane) ?? (threadId ? membraneOf?.(threadId) : undefined) ?? null,
        sourceThreadId: 'api'
      })
      res.status(result.created ? 201 : 200).json(result)
    } catch (err) {
      const msg = (err as Error).message
      res
        .status(
          UNTRUSTED.test(msg) ? 403 : /needs exactly one|Not a|Only|must be|numeric|needs project/.test(msg) ? 400 : 500
        )
        .json({ error: msg })
    }
  })

  // GET /api/tasks/:id — single task with full graph
  router.get('/api/tasks/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.get(taskIdOf(String(req.params.id)))
      if (!task) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      res.json(task)
    } catch (err) {
      fail(res, err)
    }
  })

  // PATCH /api/tasks/:id — state, threadId (null unassigns), name, description,
  // transientState, tags, membrane, isStream
  router.patch('/api/tasks/:id', async (req: Request, res: Response) => {
    try {
      const b = req.body as Record<string, any>
      if (b.state !== undefined && !TASK_STATES.includes(b.state)) {
        res.status(400).json({ error: `state must be one of ${TASK_STATES.join(', ')}` })
        return
      }
      const task = await taskService.update(taskIdOf(String(req.params.id)), {
        state: b.state,
        threadId: b.threadId === null ? null : str(b.threadId),
        name: str(b.name),
        description: typeof b.description === 'string' ? b.description : undefined,
        transientState: typeof b.transientState === 'string' ? b.transientState : undefined,
        tags: Array.isArray(b.tags) ? b.tags : undefined,
        membrane: b.membrane === null ? null : str(b.membrane),
        isStream: typeof b.isStream === 'boolean' ? b.isStream : undefined,
        sourceThreadId: 'api'
      })
      res.json(task)
    } catch (err) {
      fail(res, err)
    }
  })

  // POST /api/tasks/:id/send-prompt — send a message to the task's thread
  router.post('/api/tasks/:id/send-prompt', async (req: Request, res: Response) => {
    try {
      const taskId = taskIdOf(String(req.params.id))
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
      fail(res, err)
    }
  })

  // POST /api/tasks/:id/poll — re-read the task's PR or issue now
  router.post('/api/tasks/:id/poll', async (req: Request, res: Response) => {
    if (!pollTask) {
      res.status(503).json({ error: 'forge polling not available' })
      return
    }
    try {
      const taskId = taskIdOf(String(req.params.id))
      await pollTask(taskId)
      const task = await taskService.get(taskId)
      res.json(task)
    } catch (err) {
      fail(res, err)
    }
  })

  return router
}
