// Threads — REST API endpoints

import fs from 'node:fs'
import { Router } from 'express'
import type { ThreadManager } from './types.js'
import type { ForwardHandler } from './forward.js'
import {
  deriveSessionKey,
  type AgentBackend,
  type AgentBackendKind,
  type BackendRouter,
  type SessionSummary,
  type SubagentSummary,
  type ThreadSessionBinding
} from '@sovereign/core'
import type { CronService } from '@sovereign/scheduler'

// Threads uses a richer routing surface (all/forKind) than the minimal core
// BackendRouter — declare the local extension here so we don't pull in the
// full @sovereign/agent-backend implementation.
interface RoutingBackend extends BackendRouter {
  all(): Array<{ kind: string; backend: AgentBackend }>
  forKind(kind: AgentBackendKind): AgentBackend | undefined
  default(): AgentBackend
  /** Record a thread→session→backend binding so forSession resolves later. */
  bindThread(record: { threadKey: string; sessionKey: string; backendKind: AgentBackendKind }): unknown
}

/** Aggregate `getActivityMap()` across every enabled backend in a routing
 *  setup. Returns short-key → lastActivity (max across backends so a
 *  re-bound thread always picks up the freshest reading). */
async function collectActivityMap(b: RoutingBackend | AgentBackend | undefined): Promise<Map<string, number>> {
  const merged = new Map<string, number>()
  if (!b) return merged
  const instances =
    'all' in b && typeof (b as RoutingBackend).all === 'function'
      ? (b as RoutingBackend).all().map((i) => i.backend)
      : [b as AgentBackend]
  for (const inst of instances) {
    if (!inst.getActivityMap) continue
    try {
      const m = await inst.getActivityMap()
      for (const [k, v] of m) {
        const prev = merged.get(k) ?? 0
        if (v > prev) merged.set(k, v)
      }
    } catch {
      /* ignore */
    }
  }
  return merged
}

/**
 * Minimal AskUserQuestion store surface consumed by the pending/submit routes.
 * The concrete store lives in `@sovereign/agent-backend`; declaring the shape
 * inline here avoids a threads→agent-backend dependency cycle.
 */
export interface AskUserQuestionRouteStore {
  submit(
    toolCallId: string,
    answers: {
      questions: unknown[]
      answers: Record<string, string>
      annotations?: Record<string, { custom?: boolean; notes?: string }>
    }
  ): boolean
  abort(toolCallId: string, reason?: string): void
  listPending(threadId?: string): Array<{
    toolCallId: string
    threadId: string
    input: { questions: unknown[] }
    createdAt: number
  }>
}

export function createThreadRoutes(
  threadManager: ThreadManager,
  forwardHandler: ForwardHandler,
  opts?: {
    chatModule?: ThreadSessionBinding
    backend?: RoutingBackend | AgentBackend
    cronService?: CronService
    askUserQuestionStore?: AskUserQuestionRouteStore
    /** Context management config getter — three-layer enabled flags + cleanup thresholds. */
    getContextManagementConfig?: () => {
      filter?: { enabled?: boolean }
      recycle?: { enabled?: boolean }
      cleanup?: { enabled?: boolean; maxSessionSizeMB?: number; schedule?: string }
    }
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
    // Accept both `orgId` (legacy wire alias) and `workspaceId` / `membraneId`
    // as filter params. `orgId` is translated to `workspaceId` server-side.
    const filter: Record<string, unknown> = {}
    if (req.query.workspaceId) filter.workspaceId = req.query.workspaceId
    else if (req.query.orgId) filter.workspaceId = req.query.orgId
    if (req.query.membraneId) filter.membraneId = req.query.membraneId
    if (req.query.projectId) filter.projectId = req.query.projectId
    if (req.query.active) filter.active = req.query.active === 'true'
    const threads = threadManager.list(Object.keys(filter).length > 0 ? (filter as never) : undefined)

    // Overlay lastActivity from each backend's `getActivityMap()` so the
    // sort reflects on-disk freshness even when the thread registry hasn't
    // been touched recently.
    const activityMap = await collectActivityMap(opts?.backend)

    const merged = threads.map((t) => {
      const freshTs = Math.max(activityMap.get(t.id) ?? 0, t.lastActivity ?? 0) || t.lastActivity
      return { ...t, lastActivity: freshTs }
    })
    merged.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))

    res.json({ threads: merged })
  })

  // Static-path GETs must be registered BEFORE `/api/threads/:key` (Express
  // matches in registration order; `:key` would otherwise eat
  // "active-subagents" / "gateway-sessions" and return 404 Thread not found).

  // Presence threads lookup — clients (voice, ambient surfaces) use this
  // to find the two role-flagged threads. `internal` is the ambient inbound
  // target; `gateway` is the user's primary text-chat surface. Either may be
  // null if not yet provisioned. See plans/presence-thread-spec.md.
  router.get('/api/threads/presence', (_req, res) => {
    res.json({
      internal: threadManager.getPresenceThread('internal') ?? null,
      gateway: threadManager.getPresenceThread('gateway') ?? null
    })
  })

  // Bulk active subagents grouped by parent thread.
  router.get('/api/threads/active-subagents', async (_req, res) => {
    try {
      const routing = opts?.backend
      if (!routing || !('all' in routing)) {
        res.json({ subagents: {} })
        return
      }
      const result: Record<string, Array<{ sessionKey: string; label: string; status: string; task: string }>> = {}
      for (const inst of (routing as RoutingBackend).all()) {
        let subagentSessions: SessionSummary[] = []
        try {
          subagentSessions = await inst.backend.listSessions({ kind: 'subagent' })
        } catch {
          continue
        }
        for (const s of subagentSessions) {
          const status = s.agentStatus || 'done'
          const isActive = status === 'running' || status === 'working' || status === 'thinking'
          if (!isActive) continue
          if (!s.parentKey) continue
          // Bare-UUID scheme: parentKey is the parent thread's id (or, for
          // nested subagents, the parent subagent's bare id). Coerce any
          // lingering legacy compound form to bare.
          let threadKey = s.parentKey
          if (s.parentKey === 'agent:main:main') threadKey = 'main'
          else if (s.parentKey.startsWith('agent:main:thread:'))
            threadKey = s.parentKey.replace('agent:main:thread:', '')
          else if (s.parentKey.startsWith('agent:main:subagent:'))
            threadKey = s.parentKey.replace('agent:main:subagent:', '')
          if (!result[threadKey]) result[threadKey] = []
          result[threadKey].push({
            sessionKey: s.key,
            label: s.label || s.key.split(':subagent:')[1]?.slice(0, 8) || 'Subagent',
            status: status === 'running' ? 'working' : status,
            task: s.task || s.label || ''
          })
        }
      }
      res.json({ subagents: result })
    } catch {
      res.status(500).json({ error: 'Failed to list subagents' })
    }
  })

  // Runtime sessions endpoint — aggregates main/thread sessions from every
  // enabled backend and merges with the local thread registry.
  router.get('/api/threads/gateway-sessions', async (_req, res) => {
    try {
      const localThreads = threadManager.list() as any[]
      // Build a lookup keyed by BOTH the bare UUID and the thread's label.
      // The session listing from each backend may report either form for
      // historic data (canonical key was `agent:main:thread:<key>` where
      // `<key>` was the label-or-key; we accept either at the join here).
      const localMap = new Map<string, any>()
      for (const t of localThreads) {
        localMap.set(t.id, t)
        if (t.label) localMap.set(t.label, t)
      }

      const merged: Array<{
        key: string
        shortKey: string
        kind: string
        label: string
        lastActivity?: number
        membraneId?: string
        workspaceIds?: string[]
        localLabel?: string
        isRegistered: boolean
      }> = []

      const routing = opts?.backend
      if (routing && 'all' in routing) {
        for (const inst of (routing as RoutingBackend).all()) {
          let sessions: SessionSummary[] = []
          try {
            sessions = await inst.backend.listSessions()
          } catch {
            continue
          }
          for (const s of sessions) {
            if (s.kind !== 'main' && s.kind !== 'thread') continue
            let shortKey = s.key
            if (shortKey.startsWith('agent:main:')) shortKey = shortKey.slice('agent:main:'.length)
            if (shortKey.startsWith('thread:')) shortKey = shortKey.slice('thread:'.length)
            const local = localMap.get(s.key) || localMap.get(shortKey)
            merged.push({
              key: s.key,
              shortKey,
              kind: s.kind,
              label: s.label || shortKey,
              lastActivity: s.lastActivity,
              membraneId: local?.membraneId,
              workspaceIds: local?.workspaceIds,
              localLabel: local?.label,
              isRegistered: !!local
            })
          }
        }
      }

      res.json({ sessions: merged })
    } catch (err: any) {
      console.error('Failed to list sessions:', err.message)
      res.status(500).json({ error: 'Failed to list sessions' })
    }
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
    const {
      label,
      entities,
      orgId: legacyOrgId,
      workspaceIds: bodyWorkspaceIds,
      membraneId: bodyMembraneId,
      backend: backendKindRaw,
      contextWindow: bodyContextWindow,
      presence: bodyPresence,
      subagentBackend: bodySubagentBackend,
      subagentModel: bodySubagentModel,
      cwd
    } = req.body ?? {}
    const workspaceIds = bodyWorkspaceIds ?? (legacyOrgId && legacyOrgId !== '_global' ? [legacyOrgId] : undefined)
    const contextWindow = typeof bodyContextWindow === 'number' && bodyContextWindow > 0 ? bodyContextWindow : undefined
    const presenceRole = bodyPresence === 'internal' || bodyPresence === 'gateway' ? bodyPresence : undefined
    let thread
    try {
      thread = threadManager.create({
        label,
        entities,
        workspaceIds,
        membraneId: bodyMembraneId,
        contextWindow,
        ...(presenceRole ? { presence: presenceRole } : {}),
        ...(typeof bodySubagentBackend === 'string' ? { subagentBackend: bodySubagentBackend } : {}),
        ...(typeof bodySubagentModel === 'string' ? { subagentModel: bodySubagentModel } : {})
      })
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message })
    }
    const backendKind = backendKindRaw as AgentBackendKind | undefined
    // Optional: pre-bind the thread to a specific backend (e.g. 'claude-code')
    // so the routing layer picks the right adapter on the first message.
    if (backendKind && opts?.backend && 'forKind' in opts.backend) {
      const routing = opts.backend as RoutingBackend
      const targetBackend = routing.forKind(backendKind)
      if (targetBackend) {
        try {
          // The adapter's own registry callback persists the binding.
          // Pass `orgId` for backend-side bookkeeping (separate concern from
          // thread.workspaceIds — backends still use orgId to scope cwd etc).
          const sessionOrgId = legacyOrgId ?? (workspaceIds && workspaceIds.length > 0 ? workspaceIds[0] : undefined)
          await targetBackend.createSession(label, {
            threadKey: thread.id,
            kind: 'thread',
            ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
            ...(sessionOrgId ? { orgId: sessionOrgId } : {}),
            ...(contextWindow ? { contextWindow } : {})
          })
        } catch (err: any) {
          console.error(`[threads] failed to bind thread "${thread.id}" to backend "${backendKind}":`, err.message)
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
    const {
      label,
      orgId: legacyOrgId,
      workspaceIds: bodyWorkspaceIds,
      membraneId,
      contextWindow: bodyContextWindow,
      presence: bodyPresence,
      subagentBackend: bodySubagentBackend,
      subagentModel: bodySubagentModel
    } = req.body
    // Translate legacy `orgId` body field. Empty/`_global` → empty array
    // so a PATCH with `orgId: '_global'` actually moves a thread to global.
    const workspaceIds =
      bodyWorkspaceIds !== undefined
        ? bodyWorkspaceIds
        : legacyOrgId !== undefined
          ? legacyOrgId === '_global'
            ? []
            : [legacyOrgId]
          : undefined
    const contextWindow =
      bodyContextWindow !== undefined
        ? typeof bodyContextWindow === 'number' && bodyContextWindow > 0
          ? bodyContextWindow
          : undefined
        : undefined
    // Translate the wire form for `presence` into the ThreadManager patch.
    //   undefined   → don't touch
    //   null/false  → clear role
    //   'internal' | 'gateway' → set role
    const presencePatch: { presence?: 'internal' | 'gateway' | null } =
      bodyPresence === undefined
        ? {}
        : bodyPresence === null || bodyPresence === false
          ? { presence: null }
          : bodyPresence === 'internal' || bodyPresence === 'gateway'
            ? { presence: bodyPresence }
            : {}
    let thread
    try {
      thread = threadManager.update(req.params.key, {
        label,
        membraneId,
        workspaceIds,
        ...(bodyContextWindow !== undefined ? { contextWindow } : {}),
        ...presencePatch,
        ...(bodySubagentBackend !== undefined ? { subagentBackend: bodySubagentBackend ?? null } : {}),
        ...(bodySubagentModel !== undefined ? { subagentModel: bodySubagentModel ?? null } : {})
      })
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message })
    }
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
        reasoningEffort: meta?.reasoningEffort ?? null,
        agentStatus: thread.agentStatus ?? 'idle',
        lastRecycleAt: meta?.lastRecycleAt ?? null,
        backendKind: meta?.backendKind ?? null,
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
        reasoningEffort: null,
        agentStatus: thread.agentStatus ?? 'idle',
        sessionKey: null
      })
    }
  })

  // ── Context Management health — Layers 1/2/3 ─────────────────────────
  // Sovereign's built-in context management (real-time filter, session
  // recycle, scheduled cleanup) replaced the Cozempic guard daemon. This
  // reports the three layers' live status for the Service Health dropdown.
  router.get('/api/threads/:key/context-health', async (_req, res) => {
    const threadKey = _req.params.key
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    const cmCfg = opts?.getContextManagementConfig?.()
    const layer1Enabled = cmCfg?.filter?.enabled !== false
    const layer2Enabled = cmCfg?.recycle?.enabled !== false
    const layer3Enabled = cmCfg?.cleanup?.enabled !== false

    let filterStats: {
      trimCount: number
      trimBytesReclaimed: number
      dedupCount: number
      dedupBytesReclaimed: number
    } | null = null
    let recycleCount = 0
    let lastRecycleAt: number | null = null

    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const backend = backendForSession(sessionKey)
      if (backend) {
        const [meta, status] = await Promise.all([
          backend.getSessionMeta(sessionKey),
          backend.getContextManagementStatus?.(sessionKey) ?? Promise.resolve(null)
        ])
        lastRecycleAt = meta?.lastRecycleAt ?? null
        if (status) {
          recycleCount = status.recycleCount
          if (status.filter) filterStats = status.filter
        }
      }
    } catch {
      // Fall through — the response below still carries the config-derived
      // enabled flags even when the live session lookup fails.
    }

    res.json({
      healthy: layer1Enabled && layer2Enabled && layer3Enabled,
      layer1: {
        enabled: layer1Enabled,
        trimCount: filterStats?.trimCount ?? 0,
        trimBytesReclaimed: filterStats?.trimBytesReclaimed ?? 0,
        dedupCount: filterStats?.dedupCount ?? 0,
        dedupBytesReclaimed: filterStats?.dedupBytesReclaimed ?? 0
      },
      layer2: { enabled: layer2Enabled, lastRecycleAt, recycleCount },
      layer3: { enabled: layer3Enabled }
    })
  })

  // ── Session Recycle — Layer 2 context management ────────────────────
  // Interrupt the live query, prune the JSONL, resume with reduced context.
  router.post('/api/threads/:key/recycle', async (req, res) => {
    const threadKey = req.params.key
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
    const backend = backendForSession(sessionKey)
    if (!backend?.recycleSession) {
      return res.status(400).json({ error: 'Backend does not support session recycle' })
    }

    try {
      const result = await backend.recycleSession(sessionKey)
      if (!result) {
        return res.json({ ok: false, reason: 'no-live-session', message: 'No active session available for recycle' })
      }
      res.json({ ok: true, ...result })
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message ?? 'recycle failed' })
    }
  })

  // ── AskUserQuestion — pending list + submit ──────────────────────────
  // Sovereign holds Claude Code `AskUserQuestion` tool calls open in the
  // agent-backend PreToolUse hook until the user submits answers here. The
  // pending list is the source of truth for the inline question card the
  // client renders below the requesting turn. Note the sessionKey → threadKey
  // resolution: the store keys by sessionKey (which for the primary agent
  // equals the threadKey via deriveSessionKey); subagent AskUserQuestion calls
  // would key by the subagent's sessionKey and are surfaced under the parent
  // thread by resolving through opts.chatModule.
  router.get('/api/threads/:key/questions/pending', (req, res) => {
    const threadKey = req.params.key
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    if (!opts?.askUserQuestionStore) return res.json({ pending: [] })
    const sessionKey = opts.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
    const pending = opts.askUserQuestionStore.listPending(sessionKey)
    res.json({ pending })
  })

  router.post('/api/threads/:key/questions/:toolCallId/answer', (req, res) => {
    const threadKey = req.params.key
    const toolCallId = req.params.toolCallId
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    if (!opts?.askUserQuestionStore) return res.status(503).json({ error: 'AskUserQuestion store not wired' })
    const body = (req.body ?? {}) as {
      questions?: unknown[]
      answers?: Record<string, string>
      annotations?: Record<string, { custom?: boolean; notes?: string }>
    }
    if (!Array.isArray(body.questions) || typeof body.answers !== 'object' || body.answers === null) {
      return res.status(400).json({ error: 'Body must include {questions, answers}' })
    }
    const ok = opts.askUserQuestionStore.submit(toolCallId, {
      questions: body.questions,
      answers: body.answers,
      annotations: body.annotations
    })
    if (!ok) return res.status(404).json({ error: 'No pending question with that tool_use_id' })
    res.json({ ok: true })
  })

  router.delete('/api/threads/:key/questions/:toolCallId', (req, res) => {
    const toolCallId = req.params.toolCallId
    if (!opts?.askUserQuestionStore) return res.status(503).json({ error: 'AskUserQuestion store not wired' })
    opts.askUserQuestionStore.abort(toolCallId, 'user cancelled')
    res.json({ ok: true })
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

  router.get('/api/models', async (req, res) => {
    try {
      // Accept ?backend=<kind> to query models from a specific backend.
      // Falls back to the default backend when omitted (back-compat).
      const backendKind = req.query.backend as AgentBackendKind | undefined
      let backend: AgentBackend | null | undefined
      if (backendKind && opts?.backend && 'forKind' in opts.backend) {
        backend = (opts.backend as RoutingBackend).forKind(backendKind)
      }
      if (!backend) backend = defaultBackend()
      if (!backend) return res.json({ models: [], defaultModel: null })
      const result = await backend.listAvailableModels()
      res.json(result)
    } catch {
      res.json({ models: [], defaultModel: null })
    }
  })

  // ── Backend listing — enabled backends + connection status ──────────
  router.get('/api/backends', (_req, res) => {
    if (!opts?.backend || !('all' in opts.backend)) {
      return res.json({ backends: [], defaultBackend: null })
    }
    const routing = opts.backend as RoutingBackend
    const all = routing.all()
    const def = routing.default()
    res.json({
      backends: all.map((inst) => ({
        kind: inst.kind,
        status: inst.backend.status(),
        capabilities: inst.backend.capabilities()
      })),
      defaultBackend: def?.kind ?? null
    })
  })

  router.get('/api/efforts', async (req, res) => {
    try {
      // Accept ?backend=<kind> to query efforts from a specific backend.
      // Falls back to the default backend when omitted (back-compat).
      const backendKind = req.query.backend as AgentBackendKind | undefined
      let backend: AgentBackend | null | undefined
      if (backendKind && opts?.backend && 'forKind' in opts.backend) {
        backend = (opts.backend as RoutingBackend).forKind(backendKind)
      }
      if (!backend) backend = defaultBackend()
      if (!backend || !backend.listAvailableEfforts) {
        return res.json({ efforts: [], defaultEffort: null })
      }
      const result = await backend.listAvailableEfforts()
      res.json(result)
    } catch {
      res.json({ efforts: [], defaultEffort: null })
    }
  })

  router.patch('/api/threads/:key/context-window', async (req, res) => {
    const threadKey = req.params.key
    const { contextWindow } = req.body ?? {}
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    const value = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : undefined
    threadManager.update(threadKey, { contextWindow: value })
    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const backend = backendForSession(sessionKey)
      if (backend?.setSessionContextWindow) {
        await backend.setSessionContextWindow(sessionKey, value)
      }
    } catch {
      /* best-effort — session may not exist yet */
    }
    res.json({ success: true, contextWindow: value, thread: { ...thread, contextWindow: value } })
  })

  router.patch('/api/threads/:key/effort', async (req, res) => {
    const threadKey = req.params.key
    const { effort } = req.body ?? {}
    if (!effort) return res.status(400).json({ error: 'effort required' })
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const backend = backendForSession(sessionKey)
      if (!backend) return res.status(500).json({ error: 'No backend available' })
      if (!backend.setSessionEffort) return res.status(400).json({ error: 'Backend does not support reasoning effort' })
      await backend.setSessionEffort(sessionKey, effort)
      res.json({ success: true, effort, thread })
    } catch (err) {
      res.status(500).json({ error: 'Failed to update effort', detail: (err as Error).message })
    }
  })

  router.post('/api/threads/switch-effort', async (req, res) => {
    const { sessionKey, effort } = req.body ?? {}
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
    if (!effort) return res.status(400).json({ error: 'effort required' })
    const thread = threadManager.get(sessionKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    try {
      const derivedKey = opts?.chatModule?.getSessionKeyForThread(sessionKey) ?? deriveSessionKey(sessionKey)
      const backend = backendForSession(derivedKey)
      if (!backend) return res.status(500).json({ error: 'No backend available' })
      if (!backend.setSessionEffort) return res.status(400).json({ error: 'Backend does not support reasoning effort' })
      await backend.setSessionEffort(derivedKey, effort)
      res.json({ success: true, effort, thread })
    } catch (err) {
      res.status(500).json({ error: 'Failed to update effort', detail: (err as Error).message })
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

  // ── Backend switch — rebind a thread to a different backend ─────────
  router.patch('/api/threads/:key/backend', async (req, res) => {
    const threadKey = req.params.key
    const { backend: newKind } = req.body ?? {}
    if (!newKind) return res.status(400).json({ error: 'backend required' })
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    if (!opts?.backend || !('forKind' in opts.backend)) {
      return res.status(500).json({ error: 'No routing backend available' })
    }
    const routing = opts.backend as RoutingBackend
    const targetBackend = routing.forKind(newKind as AgentBackendKind)
    if (!targetBackend) {
      return res.status(400).json({ error: `Backend "${newKind}" not enabled` })
    }

    try {
      // Create a new session on the target backend, bound to this thread.
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      await targetBackend.createSession(thread.label, {
        threadKey,
        kind: 'thread',
        ...(thread.contextWindow ? { contextWindow: thread.contextWindow } : {})
      })
      // Update the registry binding so future messages route to the new backend.
      routing.bindThread({
        threadKey,
        sessionKey,
        backendKind: newKind as AgentBackendKind
      })
      res.json({ success: true, backend: newKind, thread })
    } catch (err) {
      res.status(500).json({ error: 'Failed to switch backend', detail: (err as Error).message })
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

  // Subagent listing — children of a thread, aggregated across enabled backends.
  router.get('/api/threads/:key/subagents', async (req, res) => {
    try {
      const threadKey = req.params.key
      const parentSessionKey =
        threadKey === 'main'
          ? 'agent:main:main'
          : threadKey.startsWith('agent:')
            ? threadKey
            : `agent:main:thread:${threadKey}`
      const routing = opts?.backend
      const subagents: SubagentSummary[] = []
      if (routing && 'all' in routing) {
        for (const inst of (routing as RoutingBackend).all()) {
          try {
            const list = await inst.backend.listSubagents(parentSessionKey)
            subagents.push(...list)
          } catch {
            /* ignore per-backend errors */
          }
        }
      }
      res.json({ subagents })
    } catch (err: any) {
      console.error('Failed to list subagents:', err.message)
      res.status(500).json({ error: 'Failed to list subagents' })
    }
  })

  // Subagent history — fetch chat history for a subagent session key
  const subagentHistoryCache = new Map<string, { data: any; ts: number }>()
  const SUBAGENT_CACHE_TTL = 5000

  router.get('/api/threads/:key/history', async (req, res) => {
    try {
      const sessionKey = req.params.key.startsWith('agent:') ? req.params.key : `agent:main:subagent:${req.params.key}`
      const cached = subagentHistoryCache.get(sessionKey)
      if (cached && Date.now() - cached.ts < SUBAGENT_CACHE_TTL) {
        return res.json({ history: cached.data })
      }
      const routing = opts?.backend
      if (!routing || !('forSession' in routing)) {
        return res.json({ history: [] })
      }
      const { turns: history } = await (routing as RoutingBackend).forSession(sessionKey).getHistory(sessionKey)
      subagentHistoryCache.set(sessionKey, { data: history, ts: Date.now() })
      if (subagentHistoryCache.size > 50) {
        const now = Date.now()
        for (const [k, v] of subagentHistoryCache) {
          if (now - v.ts > 30000) subagentHistoryCache.delete(k)
        }
      }
      res.json({ history })
    } catch (err: any) {
      console.error('Failed to get subagent history:', err.message)
      res.status(500).json({ error: 'Failed to get history' })
    }
  })

  // Thread cron jobs endpoint
  router.get('/api/threads/:key/crons', async (req, res) => {
    const cronService = opts?.cronService
    if (!cronService) return res.json({ crons: [] })
    try {
      const threadKey = req.params.key
      const sessionKey =
        opts?.chatModule?.getSessionKeyForThread(threadKey) ??
        (threadKey === 'main'
          ? 'agent:main:main'
          : threadKey.startsWith('agent:')
            ? threadKey
            : `agent:main:thread:${threadKey}`)
      const jobs = await Promise.race([
        cronService.list(true),
        new Promise<any[]>((_, reject) => setTimeout(() => reject(new Error('cron list timeout')), 5000))
      ]).catch(() => [] as any[])
      const filtered = jobs.filter((j: any) => {
        if (j.sessionTarget === sessionKey) return true
        if (j.sessionKey === sessionKey) return true
        if (j.payload?.sessionTarget === sessionKey) return true
        if (j.sessionTarget === `session:${sessionKey}`) return true
        const text = j.payload?.message || j.payload?.text || ''
        if (text.includes(threadKey)) return true
        return false
      })
      res.json({ crons: filtered })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Session Cleanup — Layer 3 context management ────────────────────
  // Prune oversized session JONLs via cozempic or native pruning.
  router.post('/api/sessions/cleanup', async (_req, res) => {
    const backend = defaultBackend()
    if (!backend) {
      return res.status(500).json({ error: 'No backend available' })
    }

    const sessions = await backend.listSessions()
    const results: Array<{
      key: string
      sizeBytes: number
      pruned: boolean
      method?: string
      reclaimedBytes?: number
      error?: string
    }> = []

    for (const session of sessions) {
      const filePath = backend.getSessionFilePath?.(session.key)
      if (!filePath) continue
      let stat: { size: number }
      try {
        stat = fs.statSync(filePath)
      } catch {
        continue
      }

      // Prune sessions above the configured threshold (default 50MB).
      const cleanupCfg = opts?.getContextManagementConfig?.()?.cleanup
      const thresholdBytes = (cleanupCfg?.maxSessionSizeMB ?? 50) * 1024 * 1024
      if (stat.size < thresholdBytes) continue

      try {
        if (backend.recycleSession) {
          const result = await backend.recycleSession(session.key, { force: true })
          if (result) {
            results.push({
              key: session.key,
              sizeBytes: stat.size,
              pruned: result.reclaimedBytes > 0,
              method: result.method,
              reclaimedBytes: result.reclaimedBytes
            })
          } else {
            // recycleSession returned null — session disabled recycling,
            // hit rate limit, or had no file. Report as skipped.
            results.push({
              key: session.key,
              sizeBytes: stat.size,
              pruned: false,
              error: 'session skipped recycle (rate-limited or disabled)'
            })
          }
        }
      } catch (err: any) {
        results.push({
          key: session.key,
          sizeBytes: stat.size,
          pruned: false,
          error: err?.message
        })
      }
    }

    res.json({
      ok: true,
      sessionsScanned: sessions.length,
      sessionsPruned: results.filter((r) => r.pruned).length,
      results
    })
  })

  // Session tree — flat list of threads at top level (no special "main"
  // root any more), each with their subagents as children. Returned as an
  // array so the UI renders the drawer with N independent threads.
  router.get('/api/sessions/tree', async (_req, res) => {
    const threads = threadManager.list()
    const now = Date.now()

    interface SessionNode {
      id: string
      kind: 'thread' | 'subagent' | 'cron' | 'cron-run' | 'event-agent'
      label: string
      parentId: string | null
      updatedAt: number
      totalTokens: number
      children: SessionNode[]
    }

    const activityMap = await collectActivityMap(opts?.backend)

    /** Index by thread UUID so subagent attachment is O(1). */
    const threadNodes = new Map<string, SessionNode>()

    const topLevel: SessionNode[] = []
    for (const t of threads) {
      const overlayTs = activityMap.get(t.id) ?? 0
      const node: SessionNode = {
        id: t.id,
        kind: 'thread',
        label: t.label,
        parentId: null,
        updatedAt: Math.max(overlayTs, t.lastActivity ?? 0, t.createdAt ?? 0) || now,
        totalTokens: 0,
        children: []
      }
      topLevel.push(node)
      threadNodes.set(t.id, node)
    }

    // Attach subagents under their parent threads.
    try {
      const routing = opts?.backend
      const instances: AgentBackend[] =
        routing && 'all' in routing && typeof (routing as RoutingBackend).all === 'function'
          ? (routing as RoutingBackend).all().map((i) => i.backend)
          : routing
            ? [routing as AgentBackend]
            : []

      const allSubagents: SubagentSummary[] = []
      const subagentSessions: SessionSummary[] = []
      for (const inst of instances) {
        try {
          allSubagents.push(...(await inst.listSubagents()))
        } catch {
          /* ignore */
        }
        try {
          subagentSessions.push(...(await inst.listSessions({ kind: 'subagent' })))
        } catch {
          /* ignore */
        }
      }
      // childId → parentId (both UUIDs in the new model).
      const parentMap = new Map<string, string>()
      for (const s of subagentSessions) {
        if (s.parentKey) parentMap.set(s.key, s.parentKey)
      }
      for (const sub of allSubagents) {
        const parentId = parentMap.get(sub.sessionKey)
        if (!parentId) continue
        const parentNode = threadNodes.get(parentId)
        if (!parentNode) continue
        const updatedAt = sub.lastActivity ?? activityMap.get(sub.sessionKey) ?? now
        parentNode.children.push({
          id: sub.sessionKey,
          kind: 'subagent',
          label: sub.label ?? sub.sessionKey.slice(0, 8),
          parentId: parentNode.id,
          updatedAt,
          totalTokens: 0,
          children: []
        })
      }
    } catch {
      /* backend unavailable — flat tree only */
    }

    // Sort: threads by activity, subagents within each thread by activity.
    topLevel.sort((a, b) => b.updatedAt - a.updatedAt)
    for (const node of topLevel) {
      if (node.children.length > 0) node.children.sort((a, b) => b.updatedAt - a.updatedAt)
    }

    // Trim stale subagents (>24h since their parent's latest activity).
    const DAY_MS = 24 * 60 * 60 * 1000
    for (const node of topLevel) {
      node.children = node.children.filter((sub) => now - sub.updatedAt < DAY_MS)
    }

    res.json({ tree: topLevel })
  })

  return router
}

// Legacy export for backwards compat
const router = Router()
router.get('/api/threads', (_req, res) => res.status(501).json({ error: 'Use createThreadRoutes()' }))
export { router as threadRoutes }
