// Threads — REST API endpoints

import { Router } from 'express'
import type { ThreadManager } from './types.js'
import type { ForwardHandler } from './forward.js'
import { getGatewayActivityMap } from './parse-gateway-sessions.js'
import type { ChatModule } from '../chat/chat.js'
import { deriveSessionKey } from '../chat/derive-session-key.js'

interface AgentBackendLike {
  getHistory(sessionKey: string): Promise<{ turns: Array<{ role: string; content: string }>; hasMore: boolean }>
}

export function createThreadRoutes(
  threadManager: ThreadManager,
  forwardHandler: ForwardHandler,
  opts?: { chatModule?: ChatModule; backend?: AgentBackendLike }
): Router {
  const router = Router()

  router.get('/api/threads', async (req, res) => {
    const filter: Record<string, unknown> = {}
    if (req.query.orgId) filter.orgId = req.query.orgId
    if (req.query.projectId) filter.projectId = req.query.projectId
    if (req.query.active) filter.active = req.query.active === 'true'
    const threads = threadManager.list(Object.keys(filter).length > 0 ? (filter as never) : undefined)

    // Merge lastActivity from gateway (source of truth)
    const activityMap = await getGatewayActivityMap()
    const merged = threads.map((t) => {
      const gwActivity = activityMap.get(t.key)
      return gwActivity ? { ...t, lastActivity: gwActivity } : t
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

  router.post('/api/threads', (req, res) => {
    const { label, entities, orgId } = req.body ?? {}
    const thread = threadManager.create({ label, entities, orgId })
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

    // Fast path: read last 10 lines from JSONL directly
    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const { getSessionFilePath, readRecentMessages } = await import('../agent-backend/session-reader.js')
      const filePath = getSessionFilePath(sessionKey)
      if (filePath) {
        const { messages } = readRecentMessages(filePath, 10)
        // Find last user or assistant message (skip toolResult, system)
        for (let i = messages.length - 1; i >= 0; i--) {
          const role = messages[i]?.role
          if ((role === 'assistant' || role === 'user') && messages[i].content) {
            // Extract text from content (may be string or array of blocks)
            let text = ''
            const content = messages[i].content
            if (typeof content === 'string') {
              text = content
            } else if (Array.isArray(content)) {
              text = content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text ?? '')
                .join(' ')
            }
            // Strip thinking blocks and directive tags
            text = text
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
  // Returns an array of { type, text } entries where type is one of:
  //   'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result'
  router.get('/api/threads/:key/preview-messages', async (req, res) => {
    const threadKey = req.params.key
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    const limit = Math.min(parseInt(req.query.limit as string) || 5, 20)
    type PreviewEntry = { type: string; text: string }
    const entries: PreviewEntry[] = []

    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const { getSessionFilePath, readRecentMessages } = await import('../agent-backend/session-reader.js')
      const filePath = getSessionFilePath(sessionKey)
      if (filePath) {
        const { messages: raw } = readRecentMessages(filePath, limit * 10)
        // Walk backwards, collect up to `limit` meaningful entries
        for (let i = raw.length - 1; i >= 0 && entries.length < limit; i--) {
          const msg = raw[i]
          if (!msg) continue
          const role = msg.role
          const content = msg.content

          if (role === 'user') {
            let text = typeof content === 'string' ? content : ''
            if (Array.isArray(content)) {
              text = content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text ?? '')
                .join(' ')
            }
            text = text
              .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[^\]]*\]\s*/, '')
              .replace(/\[\[\s*(?:reply_to_current|reply_to:\s*[^\]]*|audio_as_voice)\s*\]\]/g, '')
              .trim()
            if (!text || text === 'NO_REPLY' || text === 'HEARTBEAT_OK') continue
            if (
              /^\(System\)/i.test(text) ||
              /^OpenClaw runtime context/i.test(text) ||
              /^Write any lasting notes/i.test(text) ||
              /^Heartbeat prompt:/i.test(text) ||
              /^\[Subagent (?:Context|Task)\]/i.test(text)
            )
              continue
            entries.unshift({ type: 'user', text: text.length > 150 ? text.slice(0, 150) + '…' : text })
          } else if (role === 'assistant') {
            if (!content) continue
            if (Array.isArray(content)) {
              // Process blocks in order — collect text, thinking, tool_use
              for (const block of content) {
                if (entries.length >= limit) break
                if (block.type === 'thinking' && block.thinking) {
                  const t = (block.thinking as string).trim()
                  if (t) entries.unshift({ type: 'thinking', text: t.length > 100 ? t.slice(0, 100) + '…' : t })
                } else if (block.type === 'tool_use' || block.type === 'toolCall') {
                  const name = block.name || block.toolName || 'tool'
                  entries.unshift({ type: 'tool_call', text: name })
                } else if (block.type === 'text' && block.text) {
                  let t = (block.text as string)
                    .replace(/<antThinking>[\s\S]*?<\/antThinking>/g, '')
                    .replace(/\[\[\s*(?:reply_to_current|reply_to:\s*[^\]]*|audio_as_voice)\s*\]\]/g, '')
                    .trim()
                  if (t && t !== 'NO_REPLY' && t !== 'HEARTBEAT_OK') {
                    entries.unshift({ type: 'assistant', text: t.length > 150 ? t.slice(0, 150) + '…' : t })
                  }
                }
              }
            } else if (typeof content === 'string') {
              let text = content
                .replace(/<antThinking>[\s\S]*?<\/antThinking>/g, '')
                .replace(/\[\[\s*(?:reply_to_current|reply_to:\s*[^\]]*|audio_as_voice)\s*\]\]/g, '')
                .trim()
              if (text && text !== 'NO_REPLY' && text !== 'HEARTBEAT_OK') {
                entries.unshift({ type: 'assistant', text: text.length > 150 ? text.slice(0, 150) + '…' : text })
              }
            }
          } else if (role === 'tool') {
            // Tool result — just record the tool name
            const name = msg.name || msg.tool_use_id || 'tool'
            entries.unshift({ type: 'tool_result', text: name })
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

  // Thread session info — model, tokens, compaction, etc.
  router.get('/api/threads/:key/session-info', async (_req, res) => {
    const threadKey = _req.params.key
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const sessionsPath = (await import('node:path')).join(
        process.env.HOME || '',
        '.openclaw/agents/main/sessions/sessions.json'
      )
      const fs = await import('node:fs')
      const raw = fs.readFileSync(sessionsPath, 'utf-8')
      const sessions = JSON.parse(raw)
      const meta = sessions[sessionKey] ?? {}

      res.json({
        model: meta.model ?? null,
        modelProvider: meta.modelProvider ?? null,
        contextTokens: meta.contextTokens ?? null,
        totalTokens: meta.totalTokens ?? 0,
        inputTokens: meta.inputTokens ?? 0,
        outputTokens: meta.outputTokens ?? 0,
        compactionCount: meta.compactionCount ?? 0,
        thinkingLevel: meta.thinkingLevel ?? null,
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
    // Clear the agent status lock
    thread.agentStatus = 'idle'
    res.json({ success: true, thread })
  })

  router.post('/api/threads/stop', (req, res) => {
    const { sessionKey } = req.body ?? {}
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
    const thread = threadManager.get(sessionKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    // Signal stop by setting status to idle
    thread.agentStatus = 'idle'
    res.json({ success: true, thread })
  })

  router.post('/api/threads/switch-model', (req, res) => {
    const { sessionKey, model } = req.body ?? {}
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
    if (!model) return res.status(400).json({ error: 'model required' })
    const thread = threadManager.get(sessionKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    // Model switching is acknowledged — the actual model change is handled by the agent runtime
    res.json({ success: true, model, thread })
  })

  // Session tree — returns thread hierarchy for the ThreadDrawer
  router.get('/api/sessions/tree', (_req, res) => {
    const threads = threadManager.list()
    const now = Date.now()

    // Build tree nodes from flat thread list
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
    }

    // Sort children by updatedAt descending
    mainNode.children.sort((a, b) => b.updatedAt - a.updatedAt)

    // Prune stale subagents: remove subagent children older than 24h
    // relative to main node's most recent activity
    const DAY_MS = 24 * 60 * 60 * 1000
    const parentLatest = mainNode.children.length > 0 ? mainNode.children[0].updatedAt : now
    mainNode.children = mainNode.children.filter((child) => {
      if (child.kind === 'subagent') {
        const childAge = parentLatest - child.updatedAt
        return childAge < DAY_MS
      }
      return true
    })

    res.json({ tree: [mainNode] })
  })

  return router
}

// Legacy export for backwards compat
const router = Router()
router.get('/api/threads', (_req, res) => res.status(501).json({ error: 'Use createThreadRoutes()' }))
export { router as threadRoutes }
