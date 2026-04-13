// Threads — REST API endpoints

import { Router } from 'express'
import type { ThreadManager } from './types.js'
import type { ForwardHandler } from './forward.js'
import { getGatewayActivityMap } from './parse-gateway-sessions.js'
import type { ChatModule } from '../chat/chat.js'
import { deriveSessionKey } from '../chat/derive-session-key.js'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'

const execFileAsync = promisify(execFile)

/** Resolve the openclaw binary path once at startup. */
function resolveOpenclawBin(): string {
  // 1. Explicit env override
  if (process.env.OPENCLAW_BIN && existsSync(process.env.OPENCLAW_BIN)) {
    return process.env.OPENCLAW_BIN
  }
  // 2. Try `which` (works if PATH is correct)
  try {
    const resolved = execFileSync('which', ['openclaw'], { encoding: 'utf-8' }).trim()
    if (resolved) return resolved
  } catch {
    /* not on PATH */
  }
  // 3. NVM-based fallback
  const home = process.env.HOME || ''
  const nvmBin = `${home}/.nvm/versions/node/${process.version}/bin/openclaw`
  if (existsSync(nvmBin)) return nvmBin
  // 4. Common global paths
  for (const p of ['/usr/local/bin/openclaw', '/usr/bin/openclaw']) {
    if (existsSync(p)) return p
  }
  return 'openclaw'
}

const openclawBin = resolveOpenclawBin()

// Default model to reset GPT sessions to
const DEFAULT_MODEL = 'github-copilot/claude-opus-4.6'

/** Reset any sessions currently using GPT models back to the default model */
export async function resetGptSessionsToDefault(): Promise<{ updated: string[] }> {
  const updated: string[] = []
  try {
    const fs = await import('node:fs')
    const nodePath = await import('node:path')
    const sessionsPath = nodePath.join(process.env.HOME || '', '.openclaw/agents/main/sessions/sessions.json')
    if (!fs.existsSync(sessionsPath)) return { updated }
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'))
    const slashIdx = DEFAULT_MODEL.indexOf('/')
    const defaultProvider = DEFAULT_MODEL.slice(0, slashIdx)
    const defaultModelName = DEFAULT_MODEL.slice(slashIdx + 1)

    for (const [key, meta] of Object.entries(sessions)) {
      const m = meta as Record<string, unknown>
      const model = (m.model as string) ?? ''
      if (/gpt/i.test(model)) {
        m.model = defaultModelName
        m.modelProvider = defaultProvider
        updated.push(key)
      }
    }
    if (updated.length > 0) {
      const tmpPath = sessionsPath + '.tmp'
      fs.writeFileSync(tmpPath, JSON.stringify(sessions, null, 2))
      fs.renameSync(tmpPath, sessionsPath)
    }
  } catch {
    /* ignore */
  }
  return { updated }
}

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

    // Merge lastActivity + agentStatus from gateway (source of truth)
    const activityMap = await getGatewayActivityMap()
    const merged = threads.map((t) => {
      const gw = activityMap.get(t.key)
      if (!gw) return t
      // Map gateway status to display status
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
      // Use cached getHistory from the backend (mtime-based cache, sub-ms on hit)
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      if (opts?.backend) {
        const { turns } = await opts.backend.getHistory(sessionKey)
        // Extract preview entries from the last few turns
        for (let i = turns.length - 1; i >= 0 && entries.length < limit; i--) {
          const turn = turns[i] as any
          if (turn.role === 'user' && turn.content) {
            const text = turn.content.slice(0, 120)
            if (text && text !== 'NO_REPLY' && text !== 'HEARTBEAT_OK') {
              entries.push({ type: 'user', text })
            }
          } else if (turn.role === 'assistant') {
            // Add work items as tool_call/thinking entries
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

  // ── Available models (cached, async) ─────────────────────────────────
  let modelsCache: { models: string[]; defaultModel: string | null; ts: number } | null = null
  const MODELS_CACHE_TTL = 30_000 // 30 seconds

  async function fetchModels(): Promise<{ models: string[]; defaultModel: string | null }> {
    if (modelsCache && Date.now() - modelsCache.ts < MODELS_CACHE_TTL) {
      return { models: modelsCache.models, defaultModel: modelsCache.defaultModel }
    }

    // Read directly from config file — avoids PATH resolution issues with openclaw CLI
    try {
      const fs = await import('node:fs')
      const nodePath = await import('node:path')
      const configPath = nodePath.join(process.env.HOME || '', '.openclaw/openclaw.json')
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const modelsObj = config?.agents?.defaults?.models ?? {}
      const models = Object.keys(modelsObj)
      const defaultModel = config?.agents?.defaults?.model?.primary ?? null
      modelsCache = { models, defaultModel, ts: Date.now() }
      return { models, defaultModel }
    } catch {
      return { models: [], defaultModel: null }
    }
  }

  router.get('/api/models', async (_req, res) => {
    try {
      const result = await fetchModels()
      res.json(result)
    } catch {
      res.json({ models: [], defaultModel: null })
    }
  })

  // ── Reset GPT sessions to default ────────────────────────────────────
  router.post('/api/models/reset-gpt', async (_req, res) => {
    const result = await resetGptSessionsToDefault()
    res.json(result)
  })

  // ── Switch thread model ──────────────────────────────────────────────
  router.patch('/api/threads/:key/model', async (req, res) => {
    const threadKey = req.params.key
    const { model } = req.body ?? {}
    if (!model) return res.status(400).json({ error: 'model required' })
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const fs = await import('node:fs')
      const nodePath = await import('node:path')
      const sessionsPath = nodePath.join(process.env.HOME || '', '.openclaw/agents/main/sessions/sessions.json')
      const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'))
      if (sessions[sessionKey]) {
        // Parse provider/model from "provider/model" format
        const slashIdx = model.indexOf('/')
        if (slashIdx > 0) {
          sessions[sessionKey].modelProvider = model.slice(0, slashIdx)
          sessions[sessionKey].model = model.slice(slashIdx + 1)
        } else {
          sessions[sessionKey].model = model
        }
        const tmpPath = sessionsPath + '.tmp'
        fs.writeFileSync(tmpPath, JSON.stringify(sessions, null, 2))
        fs.renameSync(tmpPath, sessionsPath)
      }
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
      const fs = await import('node:fs')
      const nodePath = await import('node:path')
      const sessionsPath = nodePath.join(process.env.HOME || '', '.openclaw/agents/main/sessions/sessions.json')
      const derivedKey = opts?.chatModule?.getSessionKeyForThread(sessionKey) ?? deriveSessionKey(sessionKey)
      const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'))
      if (sessions[derivedKey]) {
        const slashIdx = model.indexOf('/')
        if (slashIdx > 0) {
          sessions[derivedKey].modelProvider = model.slice(0, slashIdx)
          sessions[derivedKey].model = model.slice(slashIdx + 1)
        } else {
          sessions[derivedKey].model = model
        }
        const tmpPath = sessionsPath + '.tmp'
        fs.writeFileSync(tmpPath, JSON.stringify(sessions, null, 2))
        fs.renameSync(tmpPath, sessionsPath)
      }
      res.json({ success: true, model, thread })
    } catch (err) {
      res.status(500).json({ error: 'Failed to update model', detail: (err as Error).message })
    }
  })

  // Session tree — returns thread hierarchy for the ThreadDrawer
  router.get('/api/sessions/tree', async (_req, res) => {
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

    // Build a map of thread nodes for nesting subagents
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
      // Track full session key for parent matching
      const fullSessionKey = t.key.startsWith('agent:') ? t.key : `agent:main:thread:${t.key}`
      threadNodes.set(fullSessionKey, node)
    }

    // Read sessions.json to find subagent→parent relationships
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const sessionsPath = path.join(process.env.HOME || '', '.openclaw/agents/main/sessions/sessions.json')
      if (fs.existsSync(sessionsPath)) {
        const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'))
        for (const [sk, meta] of Object.entries(sessions)) {
          if (!sk.includes(':subagent:')) continue
          const m = meta as Record<string, unknown>
          const spawnedBy = m.spawnedBy as string | undefined
          if (!spawnedBy) continue

          // Find the parent thread node
          const parentNode = threadNodes.get(spawnedBy)
          if (!parentNode) continue

          // Check if this subagent is already in the tree (from threadManager)
          const shortKey = sk.replace(/^agent:main:/, '')
          const alreadyInTree = mainNode.children.some((c) => c.key === shortKey || c.fullKey === sk)
          if (alreadyInTree) {
            // Move it from mainNode.children to parentNode.children
            const idx = mainNode.children.findIndex((c) => c.key === shortKey || c.fullKey === sk)
            if (idx >= 0) {
              const [moved] = mainNode.children.splice(idx, 1)
              moved.parentKey = parentNode.key
              parentNode.children.push(moved)
            }
            continue
          }

          // Create a new subagent node under the parent
          const updatedAt = (m.updatedAt as number) || (m.startedAt as number) || now
          const label = (m.label as string) || shortKey
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
      }
    } catch {
      /* sessions.json read failed — continue with flat tree */
    }

    // Sort children by updatedAt descending
    mainNode.children.sort((a, b) => b.updatedAt - a.updatedAt)
    for (const child of mainNode.children) {
      if (child.children.length > 0) {
        child.children.sort((a, b) => b.updatedAt - a.updatedAt)
      }
    }

    // Prune stale subagents: remove subagent children older than 24h
    const DAY_MS = 24 * 60 * 60 * 1000
    const parentLatest = mainNode.children.length > 0 ? mainNode.children[0].updatedAt : now
    mainNode.children = mainNode.children.filter((child) => {
      if (child.kind === 'subagent') {
        const childAge = parentLatest - child.updatedAt
        return childAge < DAY_MS
      }
      return true
    })
    // Also prune stale subagents nested under threads
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
