// Threads — REST API endpoints

import { Router } from 'express'
import type { ThreadManager } from './types.js'
import type { ForwardHandler } from './forward.js'
import type { ChatModule } from '../chat/chat.js'
import { deriveSessionKey } from '../chat/derive-session-key.js'
import type { RoutingBackend } from '../agent-backend/factory.js'
import type { AgentBackend, AgentBackendKind, SessionSummary, SubagentSummary } from '@sovereign/core'

interface OpenClawActivityProvider {
  /**
   * Returns shortKey → {lastActivity, status} for "main" / "thread" sessions.
   * Implemented by the OpenClaw adapter; absent for Pi / Claude Code.
   */
  getGatewayActivityMap?(): Promise<Map<string, { lastActivity: number; status?: string }>>
}

export function createThreadRoutes(
  threadManager: ThreadManager,
  forwardHandler: ForwardHandler,
  opts?: {
    chatModule?: ChatModule
    backend?: RoutingBackend | AgentBackend
    activityProvider?: OpenClawActivityProvider
  }
): Router {
  const router = Router()

  /** Resolve a generic AgentBackend for backwards-compat callers. */
  function backendForSession(sessionKey: string): AgentBackend | null {
    const b = opts?.backend
    if (!b) return null
    if ('forSession' in b && typeof (b as RoutingBackend).forSession === 'function') {
      return (b as RoutingBackend).forSession(sessionKey)
    }
    return b as AgentBackend
  }

  function defaultBackend(): AgentBackend | null {
    const b = opts?.backend
    if (!b) return null
    if ('default' in b && typeof (b as RoutingBackend).default === 'function') {
      return (b as RoutingBackend).default()
    }
    return b as AgentBackend
  }

  router.get('/api/threads', async (req, res) => {
    const filter: Record<string, unknown> = {}
    if (req.query.orgId) filter.orgId = req.query.orgId
    if (req.query.projectId) filter.projectId = req.query.projectId
    if (req.query.active) filter.active = req.query.active === 'true'
    const threads = threadManager.list(Object.keys(filter).length > 0 ? (filter as never) : undefined)

    // Merge lastActivity + agentStatus from the OpenClaw activity provider (if available).
    let activityMap: Map<string, { lastActivity: number; status?: string }> | undefined
    try {
      activityMap = (await opts?.activityProvider?.getGatewayActivityMap?.()) ?? undefined
    } catch {
      /* ignore */
    }

    const merged = threads.map((t) => {
      const gw = activityMap?.get(t.key)
      if (!gw) return t
      let agentStatus = t.agentStatus
      if (gw.status === 'running') agentStatus = 'working' as any
      else if (gw.status === 'failed') agentStatus = 'failed' as any
      return { ...t, lastActivity: gw.lastActivity, agentStatus }
    })
    merged.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))

    res.json({ threads: merged })
  })

  router.get('/api/threads/:key/messages', (req, res) => {
    const events = threadManager.getEvents(req.params.key, {
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0
    })
    res.json({ messages: events })
  })

  router.get('/api/threads/:key', (req, res) => {
    const thread = threadManager.get(req.params.key)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    const events = threadManager.getEvents(req.params.key, {
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0
    })
    res.json({ thread, events })
  })

  router.post('/api/threads', async (req, res) => {
    const { label, entities, orgId, backend: backendKindRaw, cwd } = req.body ?? {}
    const thread = threadManager.create({ label, entities, orgId })
    const backendKind = backendKindRaw as AgentBackendKind | undefined
    // Optional: pre-bind the thread to a specific backend (e.g. 'claude-code')
    // so the routing layer picks the right adapter on the first message.
    if (backendKind && opts?.backend && 'forKind' in opts.backend) {
      const routing = opts.backend as RoutingBackend
      const targetBackend = routing.forKind(backendKind)
      if (targetBackend) {
        try {
          // The adapter's own registry callback persists the binding
          // (including backendSessionId + backendSessionFile + orgId/cwd).
          await targetBackend.createSession(label, {
            threadKey: thread.key,
            kind: 'thread',
            ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
            ...(orgId ? { orgId } : {})
          } as never)
        } catch (err: any) {
          console.error(`[threads] failed to bind thread "${thread.key}" to backend "${backendKind}":`, err.message)
        }
      }
    }
    res.status(201).json({ thread })
  })

  router.delete('/api/threads/:key', (req, res) => {
    const deleted = threadManager.delete(req.params.key)
    if (!deleted) return res.status(404).json({ error: 'Thread not found' })
    res.json({ success: true })
  })

  router.patch('/api/threads/:key', (req, res) => {
    const { label, orgId } = req.body
    const thread = threadManager.update(req.params.key, { label, orgId })
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    res.json({ thread })
  })

  router.post('/api/threads/:key/entities', (req, res) => {
    const thread = threadManager.addEntity(req.params.key, req.body)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    res.json({ thread })
  })

  router.delete('/api/threads/:key/entities/:entityType/:entityRef', (req, res) => {
    const thread = threadManager.removeEntity(req.params.key, req.params.entityType as never, req.params.entityRef)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    res.json({ thread })
  })

  router.post('/api/threads/:key/forward', (req, res) => {
    const result = forwardHandler.forward(req.body.sourceThread ?? req.params.key, req.params.key, req.body)
    if (!result.success) return res.status(400).json({ error: result.error })
    res.json({ success: true })
  })

  router.get('/api/threads/:key/events', (req, res) => {
    const events = threadManager.getEvents(req.params.key, {
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
      since: req.query.since ? Number(req.query.since) : undefined
    })
    res.json({ events })
  })

  // ── Thread preview (latest message) ──────────────────────────────────

  router.get('/api/threads/:key/preview', async (req, res) => {
    const threadKey = req.params.key
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    let lastMessage: string | null = null

    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const backend = backendForSession(sessionKey)
      if (backend) {
        const { turns } = await backend.getHistory(sessionKey)
        for (let i = turns.length - 1; i >= 0; i--) {
          const t = turns[i]
          if ((t.role === 'assistant' || t.role === 'user') && t.content) {
            const text = t.content
              .replace(/<antThinking>[\s\S]*?<\/antThinking>/g, '')
              .replace(/\[\[\s*(?:reply_to_current|reply_to:\s*[^\]]*|audio_as_voice)\s*\]\]/g, '')
              .trim()
            if (text && text !== 'NO_REPLY' && text !== 'HEARTBEAT_OK') {
              lastMessage = text.length > 120 ? text.slice(0, 120) + '...' : text
              break
            }
          }
        }
      }
    } catch {
      /* fall through */
    }

    res.json({
      lastMessage,
      agentStatus: thread.agentStatus ?? 'idle'
    })
  })

  // ── Thread preview messages (last N typed entries for rich card rendering) ──
  router.get('/api/threads/:key/preview-messages', async (req, res) => {
    const threadKey = req.params.key
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    const limit = Math.min(parseInt(req.query.limit as string) || 5, 20)
    type PreviewEntry = { type: string; text: string }
    const entries: PreviewEntry[] = []

    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const backend = backendForSession(sessionKey)
      if (backend) {
        const { turns } = await backend.getHistory(sessionKey)
        for (let i = turns.length - 1; i >= 0 && entries.length < limit; i--) {
          const turn = turns[i] as any
          if (turn.role === 'user' && turn.content) {
            const text = turn.content.slice(0, 120)
            if (text && text !== 'NO_REPLY' && text !== 'HEARTBEAT_OK') {
              entries.push({ type: 'user', text })
            }
          } else if (turn.role === 'assistant') {
            if (turn.workItems) {
              for (const w of turn.workItems.slice(-3)) {
                if (w.type === 'tool_call') {
                  entries.push({ type: 'tool_call', text: w.name || 'tool' })
                } else if (w.type === 'thinking' && w.output) {
                  entries.push({ type: 'thinking', text: w.output.slice(0, 80) })
                }
              }
            }
            if (turn.content) {
              entries.push({ type: 'assistant', text: turn.content.slice(0, 120) })
            }
          } else if (turn.role === 'system' && turn.content) {
            entries.push({ type: 'assistant', text: turn.content.slice(0, 80) })
          }
        }
      }
    } catch {
      /* ignore */
    }

    res.json({
      messages: entries.slice(-limit),
      agentStatus: thread.agentStatus ?? 'idle'
    })
  })

  // ── Thread management endpoints ──────────────────────────────────────

  router.get('/api/threads/:key/session-info', async (_req, res) => {
    const threadKey = _req.params.key
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const backend = backendForSession(sessionKey)
      const meta = backend ? await backend.getSessionMeta(sessionKey) : null

      res.json({
        model: meta?.model ?? null,
        modelProvider: meta?.modelProvider ?? null,
        contextTokens: meta?.contextTokens ?? null,
        totalTokens: meta?.totalTokens ?? 0,
        inputTokens: meta?.inputTokens ?? 0,
        outputTokens: meta?.outputTokens ?? 0,
        compactionCount: meta?.compactionCount ?? 0,
        thinkingLevel: meta?.thinkingLevel ?? null,
        agentStatus: thread.agentStatus ?? 'idle',
        sessionKey
      })
    } catch {
      res.json({
        model: null,
        modelProvider: null,
        contextTokens: null,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        compactionCount: 0,
        thinkingLevel: null,
        agentStatus: thread.agentStatus ?? 'idle',
        sessionKey: null
      })
    }
  })

  router.post('/api/threads/clear-lock', (req, res) => {
    const { sessionKey } = req.body ?? {}
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
    const thread = threadManager.get(sessionKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    thread.agentStatus = 'idle'
    res.json({ success: true, thread })
  })

  router.post('/api/threads/stop', (req, res) => {
    const { sessionKey } = req.body ?? {}
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
    const thread = threadManager.get(sessionKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    thread.agentStatus = 'idle'
    res.json({ success: true, thread })
  })

  router.get('/api/models', async (_req, res) => {
    try {
      const backend = defaultBackend()
      if (!backend) return res.json({ models: [], defaultModel: null })
      const result = await backend.listAvailableModels()
      res.json(result)
    } catch {
      res.json({ models: [], defaultModel: null })
    }
  })

  router.patch('/api/threads/:key/model', async (req, res) => {
    const threadKey = req.params.key
    const { model } = req.body ?? {}
    if (!model) return res.status(400).json({ error: 'model required' })
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const backend = backendForSession(sessionKey)
      if (!backend) return res.status(500).json({ error: 'No backend available' })
      const slashIdx = model.indexOf('/')
      const provider = slashIdx > 0 ? model.slice(0, slashIdx) : ''
      const modelName = slashIdx > 0 ? model.slice(slashIdx + 1) : model
      await backend.setSessionModel(sessionKey, provider, modelName)
      res.json({ success: true, model, thread })
    } catch (err) {
      res.status(500).json({ error: 'Failed to update model', detail: (err as Error).message })
    }
  })

  router.post('/api/threads/switch-model', async (req, res) => {
    const { sessionKey, model } = req.body ?? {}
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
    if (!model) return res.status(400).json({ error: 'model required' })
    const thread = threadManager.get(sessionKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    try {
      const derivedKey = opts?.chatModule?.getSessionKeyForThread(sessionKey) ?? deriveSessionKey(sessionKey)
      const backend = backendForSession(derivedKey)
      if (!backend) return res.status(500).json({ error: 'No backend available' })
      const slashIdx = model.indexOf('/')
      const provider = slashIdx > 0 ? model.slice(0, slashIdx) : ''
      const modelName = slashIdx > 0 ? model.slice(slashIdx + 1) : model
      await backend.setSessionModel(derivedKey, provider, modelName)
      res.json({ success: true, model, thread })
    } catch (err) {
      res.status(500).json({ error: 'Failed to update model', detail: (err as Error).message })
    }
  })

  // Session tree — returns thread hierarchy for the ThreadDrawer
  router.get('/api/sessions/tree', async (_req, res) => {
    const threads = threadManager.list()
    const now = Date.now()

    interface SessionNode {
      key: string
      fullKey: string
      kind: 'main' | 'thread' | 'cron' | 'cron-run' | 'subagent' | 'event-agent'
      label: string
      parentKey: string | null
      updatedAt: number
      totalTokens: number
      children: SessionNode[]
    }

    const mainNode: SessionNode = {
      key: 'main',
      fullKey: 'main',
      kind: 'main',
      label: 'Main',
      parentKey: null,
      updatedAt: now,
      totalTokens: 0,
      children: []
    }

    const threadNodes = new Map<string, SessionNode>()

    for (const t of threads) {
      const kind = t.key.startsWith('cron:')
        ? ('cron' as const)
        : t.key.startsWith('subagent:')
          ? ('subagent' as const)
          : ('thread' as const)
      const node: SessionNode = {
        key: t.key,
        fullKey: t.key,
        kind,
        label: t.label || t.key,
        parentKey: 'main',
        updatedAt: t.lastActivity || t.createdAt || now,
        totalTokens: 0,
        children: []
      }
      mainNode.children.push(node)
      const fullSessionKey = t.key.startsWith('agent:') ? t.key : `agent:main:thread:${t.key}`
      threadNodes.set(fullSessionKey, node)
    }

    // Use backend.listSubagents() if available to attach children under parents.
    try {
      const backend = defaultBackend()
      const allSubagents: SubagentSummary[] = backend ? await backend.listSubagents() : []
      // For each subagent, look up the parent. SubagentSummary doesn't
      // include the parent's key; use listSessions to recover that mapping.
      let parentMap = new Map<string, string>() // childKey -> parentKey
      if (backend) {
        const sessions: SessionSummary[] = await backend.listSessions({ kind: 'subagent' })
        for (const s of sessions) {
          if (s.parentKey) parentMap.set(s.key, s.parentKey)
        }
      }

      for (const sub of allSubagents) {
        const sk = sub.sessionKey
        const parentSessionKey = parentMap.get(sk)
        if (!parentSessionKey) continue
        const parentNode = threadNodes.get(parentSessionKey)
        if (!parentNode) continue

        const shortKey = sk.replace(/^agent:main:/, '')
        const alreadyInTree = mainNode.children.some((c) => c.key === shortKey || c.fullKey === sk)
        if (alreadyInTree) {
          const idx = mainNode.children.findIndex((c) => c.key === shortKey || c.fullKey === sk)
          if (idx >= 0) {
            const [moved] = mainNode.children.splice(idx, 1)
            moved.parentKey = parentNode.key
            parentNode.children.push(moved)
          }
          continue
        }

        const updatedAt = sub.lastActivity ?? now
        const label = sub.label ?? shortKey
        const subNode: SessionNode = {
          key: shortKey,
          fullKey: sk,
          kind: 'subagent',
          label,
          parentKey: parentNode.key,
          updatedAt,
          totalTokens: 0,
          children: []
        }
        parentNode.children.push(subNode)
      }
    } catch {
      /* backend unavailable — flat tree only */
    }

    mainNode.children.sort((a, b) => b.updatedAt - a.updatedAt)
    for (const child of mainNode.children) {
      if (child.children.length > 0) {
        child.children.sort((a, b) => b.updatedAt - a.updatedAt)
      }
    }

    const DAY_MS = 24 * 60 * 60 * 1000
    const parentLatest = mainNode.children.length > 0 ? mainNode.children[0].updatedAt : now
    mainNode.children = mainNode.children.filter((child) => {
      if (child.kind === 'subagent') {
        const childAge = parentLatest - child.updatedAt
        return childAge < DAY_MS
      }
      return true
    })
    for (const child of mainNode.children) {
      if (child.children.length > 0) {
        child.children = child.children.filter((sub) => {
          if (sub.kind === 'subagent') {
            const subAge = now - sub.updatedAt
            return subAge < DAY_MS
          }
          return true
        })
      }
    }

    res.json({ tree: [mainNode] })
  })

  return router
}

// Legacy export for backwards compat
const router = Router()
router.get('/api/threads', (_req, res) => res.status(501).json({ error: 'Use createThreadRoutes()' }))
export { router as threadRoutes }
