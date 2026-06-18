// Threads — REST API endpoints

import fs from 'node:fs'
import { execFile, spawn } from 'node:child_process'
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

export function createThreadRoutes(
  threadManager: ThreadManager,
  forwardHandler: ForwardHandler,
  opts?: {
    chatModule?: ThreadSessionBinding
    backend?: RoutingBackend | AgentBackend
    cronService?: CronService
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
      cwd
    } = req.body ?? {}
    // Translate legacy `orgId` body field into the new shape. Explicit
    // `workspaceIds` and `membraneId` always win.
    const workspaceIds = bodyWorkspaceIds ?? (legacyOrgId && legacyOrgId !== '_global' ? [legacyOrgId] : undefined)
    const thread = threadManager.create({ label, entities, workspaceIds, membraneId: bodyMembraneId })
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
            threadId: thread.id,
            kind: 'thread',
            ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
            ...(sessionOrgId ? { orgId: sessionOrgId } : {})
          } as never)
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
    const { label, orgId: legacyOrgId, workspaceIds: bodyWorkspaceIds, membraneId } = req.body
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
    const thread = threadManager.update(req.params.key, { label, membraneId, workspaceIds })
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

  router.get('/api/threads/:key/cozempic-health', async (_req, res) => {
    const threadKey = _req.params.key
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const backend = backendForSession(sessionKey)
      const meta = backend ? await backend.getSessionMeta(sessionKey) : null
      const backendSessionId = meta?.backendSessionId

      if (!backendSessionId) {
        return res.json({ healthy: null, reason: 'no-session' })
      }

      const short = backendSessionId.substring(0, 12)
      const pidFile = `/tmp/cozempic_guard_${short}.pid`
      let healthy = false
      let reason: string | null = null

      try {
        const pidStr = fs.readFileSync(pidFile, 'utf-8').trim()
        const pid = parseInt(pidStr, 10)
        if (pid > 0) {
          process.kill(pid, 0)
          healthy = true
        } else {
          reason = 'invalid-pid'
        }
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT') reason = 'no-pid-file'
        else if (code === 'ESRCH') reason = 'guard-exited'
        else reason = 'unknown'
      }

      if (!healthy) {
        const logFile = `/tmp/cozempic_guard_${short}.log`
        try {
          const log = fs.readFileSync(logFile, 'utf-8')
          if (log.includes('Guard powerless')) reason = 'context-bloat'
        } catch {
          /* log may not exist */
        }
      }

      res.json({ healthy, reason, backendSessionId, backendSessionFile: meta?.backendSessionFile ?? null })
    } catch {
      res.json({ healthy: null, reason: 'error' })
    }
  })

  router.post('/api/threads/:key/cozempic-restore', async (_req, res) => {
    const threadKey = _req.params.key
    const thread = threadManager.get(threadKey)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    try {
      const sessionKey = opts?.chatModule?.getSessionKeyForThread(threadKey) ?? deriveSessionKey(threadKey)
      const backend = backendForSession(sessionKey)
      const meta = backend ? await backend.getSessionMeta(sessionKey) : null
      const { backendSessionId, backendSessionFile } = meta ?? {}

      if (!backendSessionId || !backendSessionFile) {
        return res.status(400).json({ ok: false, message: 'No active session for this thread' })
      }

      // Spawn a sentinel process whose argv includes '@anthropic-ai/claude-code'
      // so cozempic's _is_claude_process identity check passes. The sentinel
      // stays alive as long as the Sovereign systemd unit is active, surviving
      // rebuilds (which change the server PID but not the sentinel).
      const sentinelPid = await new Promise<number>((resolve, reject) => {
        const sentinel = spawn(
          process.execPath,
          [
            '-e',
            'setInterval(()=>{try{require("child_process").execSync("systemctl --user is-active sovereign.service",{timeout:5000})}catch{process.exit(0)}},15000)',
            '--',
            '@anthropic-ai/claude-code'
          ],
          { detached: true, stdio: 'ignore' }
        )
        sentinel.unref()
        if (!sentinel.pid) return reject(new Error('Failed to spawn sentinel'))
        resolve(sentinel.pid)
      })

      await new Promise<void>((resolve, reject) => {
        const args = ['guard', '--daemon', '--session', backendSessionFile, '--claude-pid', String(sentinelPid)]
        execFile('cozempic', args, { timeout: 10_000 }, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      res.json({ ok: true, message: 'Cozempic guard spawned' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(500).json({ ok: false, message: msg })
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

  router.get('/api/efforts', async (_req, res) => {
    try {
      const backend = defaultBackend()
      if (!backend || !backend.listAvailableEfforts) {
        return res.json({ efforts: [], defaultEffort: null })
      }
      const result = await backend.listAvailableEfforts()
      res.json(result)
    } catch {
      res.json({ efforts: [], defaultEffort: null })
    }
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
