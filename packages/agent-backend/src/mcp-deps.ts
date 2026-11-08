// Build the SovereignToolDeps bag for the Claude Code MCP server. Lives in
// the agent-backend module so the entry point doesn't need to know how each
// MCP tool wires into the underlying services.

import { randomUUID } from 'node:crypto'
import type {
  PresenceMcpDeps,
  EmbeddingsToolDeps,
  TaskMcpDeps,
  PrWatchMcpDeps,
  SovereignToolDeps
} from './claude-code/mcp-server.js'
import type { DecisionMcpDeps } from './claude-code/decision-tools.js'
import type { ForgeMcpDeps } from './claude-code/forge-tools.js'
import type { RoutingBackend } from './factory.js'
import type { CronService } from '@sovereign/scheduler'
import type { OrgManager } from '@sovereign/orgs'
import type { PlanningService } from '@sovereign/planning'
import type { IssueTracker } from '@sovereign/issues'
import type { MeetingsService } from '@sovereign/meetings'
import type { Notifications } from '@sovereign/notifications'
import type { BrowserService } from '@sovereign/browser'
import type { AgentBackend, AgentBackendKind, EventBus } from '@sovereign/core'
import { unwrapThreadId } from '@sovereign/core'
import type { ThreadManager } from '@sovereign/threads'
import { sessionKeyToThreadKey } from './wiring.js'
import type { HarnessProfile } from '@sovereign/config'
import { MAX_SUBAGENTS_PER_PARENT } from './claude-code/subagent-runner.js'
import type { HarnessRunner } from './harness/runner.js'

/** Global defaults for subagent routing. Thread-level config takes priority
 *  over these; these take priority over the model's explicit request. */
export interface SubagentDefaults {
  backend?: string
  model?: string
  /** Wall-clock limit per subagent; unset: the backend's default. */
  timeoutMinutes?: number
  /** The harness profile agents_spawn uses when the call names none; unset: claude. */
  harness?: string
}

export interface SovereignMcpDepsInput {
  bus: EventBus
  routing: RoutingBackend
  cronService: CronService
  orgManager: OrgManager
  planningService: PlanningService
  issueTracker: IssueTracker
  meetingsService: MeetingsService
  notificationsModule: Notifications
  browserService: BrowserService
  /** Thread manager — used by agents.spawn to resolve per-thread subagent
   *  routing config (subagentBackend / subagentModel). */
  threadManager?: ThreadManager
  /** Presence-thread integration. When set, registers the seven presence_*
   *  MCP tools. Sourced from `@sovereign/presence` in bootstrap. */
  presence?: PresenceMcpDeps
  /** Global subagent defaults — config `agentBackend.subagentDefaults`, read at
   *  each spawn. Thread-level config takes priority; these override the model's request. */
  subagentDefaults?: () => SubagentDefaults
  /** Embeddings service. When set, registers embeddings_search/index/collections/health
   *  tools in both the Claude Code MCP server and the local-llm backend. */
  embeddings?: EmbeddingsToolDeps
  /** Task service. When set, registers the eight task_* MCP tools. */
  tasks?: TaskMcpDeps
  /** PR watcher (pr_watch / pr_watch_list / pr_unwatch), bound later. */
  prWatch?: PrWatchMcpDeps
  /** Forge rethink tools (forge_*), registered in forge-rethink threads only. */
  forge?: ForgeMcpDeps
  /** decision_open / decision_close, in every thread once bound. */
  decisions?: DecisionMcpDeps
  /** Harness profiles (config `agentBackend.harnesses`) and the runner for the
   *  non-claude ones. Unset: only claude runs. */
  harnesses?: {
    runner: Pick<HarnessRunner, 'spawn' | 'list' | 'has' | 'stop' | 'describe'>
    profiles: () => Record<string, HarnessProfile>
  }
}

export function buildSovereignMcpDeps(input: SovereignMcpDepsInput): SovereignToolDeps {
  const {
    bus,
    routing,
    cronService,
    orgManager,
    planningService,
    issueTracker,
    meetingsService,
    notificationsModule,
    browserService
  } = input

  /** Resolve a user-facing session/thread key to the canonical session key
   *  used by the owning backend. A thread's session key is its bare id, the
   *  key the chat module and the UI use, so the legacy `agent:main:thread:`
   *  form is unwrapped too. The registry wins when it binds the thread to
   *  another key (local-llm). The old fallback re-added the legacy prefix,
   *  which started a second, hidden session for a thread with no session yet. */
  function resolveSessionKey(sessionKey: string): string {
    if (sessionKey === 'main') return 'agent:main:main'
    if (sessionKey.startsWith('agent:') && !sessionKey.startsWith('agent:main:thread:')) return sessionKey
    const id = unwrapThreadId(sessionKey)
    const record = routing.registry.getByThread(id) ?? routing.registry.getBySession(id)
    // A record can still name the legacy form: it resolves to the same bare key
    return record ? unwrapThreadId(record.sessionKey) : id
  }

  /** Running subagents: every backend's live children, then the harness runs. */
  async function listAgents(
    parentKey?: string
  ): Promise<Array<{ sessionKey: string; label: string; status: string; task?: string }>> {
    const out: Array<{ sessionKey: string; label: string; status: string; task?: string }> = []
    for (const inst of routing.all()) {
      try {
        const list = await inst.backend.listSubagents(parentKey)
        // Live only: every subagent ever spawned stays registered as idle,
        // and listing them all cost an agent ~270k characters per call.
        for (const s of list)
          if (s.status !== 'idle')
            out.push({ sessionKey: s.sessionKey, label: s.label, status: s.status, task: s.task })
      } catch {
        /* ignore */
      }
    }
    // Routing lists the harness runs too (harness/backend.ts): each run once.
    for (const r of input.harnesses?.runner.list(parentKey) ?? [])
      if (!out.some((s) => s.sessionKey === r.sessionKey))
        out.push({ sessionKey: r.sessionKey, label: r.label, status: r.status, task: r.task })
    return out
  }

  return {
    cron: {
      createUserMessageCron: async (o) => cronService.createUserMessageCron(o),
      list: async (d) => cronService.list(d),
      remove: async (id) => cronService.remove(id)
    },
    sessions: {
      async list(filter) {
        const out: Array<{ key: string; label?: string; kind?: string }> = []
        for (const inst of routing.all()) {
          if (filter?.backendKind && inst.kind !== filter.backendKind) continue
          try {
            const list = await inst.backend.listSessions()
            for (const s of list) out.push({ key: s.key, label: s.label, kind: s.kind })
          } catch {
            /* ignore per-backend errors */
          }
        }
        return out
      },
      async send(sessionKey, text) {
        const key = resolveSessionKey(sessionKey)
        // This bypasses the chat queue: say who sent it, so the turn it starts reads as
        // started by another thread (the chat module holds it until the session goes busy).
        bus?.emit({
          type: 'chat.message.injected',
          timestamp: new Date().toISOString(),
          source: 'agent-backend',
          payload: { sessionKey: key, via: 'agent', preview: text.slice(0, 200) }
        })
        await routing.forSession(key).sendMessage(key, text)
      },
      async history(sessionKey, limit) {
        const key = resolveSessionKey(sessionKey)
        const { turns } = await routing.forSession(key).getHistory(key)
        return turns.slice(-(limit ?? 20)).map((t: any) => ({ role: t.role, content: t.content }))
      }
    },
    agents: {
      list: listAgents,
      async spawn(parentKey, opts) {
        const defaults = input.subagentDefaults?.()
        const harness = opts.harness ?? defaults?.harness ?? 'claude'
        const profile = input.harnesses?.profiles()[harness]
        if (!profile && harness !== 'claude') {
          const names = Object.keys(input.harnesses?.profiles() ?? {})
          throw new Error(`agents_spawn: unknown harness ${harness} (configured: ${names.join(', ') || 'claude'})`)
        }
        // One limit across every harness: Claude children and harness runs alike.
        const running = (await listAgents(parentKey)).length
        if (running >= MAX_SUBAGENTS_PER_PARENT) {
          throw new Error(
            `agents_spawn: ${running} subagents already run for this thread (max ${MAX_SUBAGENTS_PER_PARENT}); wait for one to finish`
          )
        }
        // Other harnesses run their own models: the thread's and the global Claude routing do not apply.
        if (profile && profile.adapter !== 'claude') {
          if (!input.harnesses) throw new Error(`agents_spawn: harness ${harness} needs the harness runner`)
          const sessionKey = await input.harnesses.runner.spawn(parentKey, {
            harness,
            task: opts.task,
            cwd: opts.cwd,
            label: opts.label,
            ...(opts.model ? { model: opts.model } : {}),
            ...(defaults?.timeoutMinutes ? { timeoutMs: defaults.timeoutMinutes * 60_000 } : {})
          })
          return { sessionKey }
        }
        // Resolve the parent thread's subagent routing config (if any).
        const threadKey = sessionKeyToThreadKey(parentKey)
        const thread = threadKey ? input.threadManager?.get(threadKey) : undefined

        // Priority chain (NON-NEGOTIABLE — thread config is authoritative):
        //   1. Thread-level subagentBackend (highest — per-thread override)
        //   2. Global subagentDefaults.backend (system-wide policy)
        //   3. Parent session's own backend (fallback)
        let backend: AgentBackend
        const effectiveBackend = thread?.subagentBackend ?? defaults?.backend
        if (effectiveBackend) {
          const target = routing.forKind(effectiveBackend as AgentBackendKind)
          if (!target) throw new Error(`agents_spawn: backend "${effectiveBackend}" not enabled`)
          backend = target
        } else {
          backend = routing.forSession(parentKey)
        }
        if (!backend.spawnSubagent) throw new Error('agents_spawn: backend does not support subagent spawn')

        // Same priority for model: thread > global > the call's > the profile's > the parent's model.
        const effectiveModel = thread?.subagentModel ?? defaults?.model ?? (opts.model || profile?.model)
        const childKey = await backend.spawnSubagent(parentKey, {
          task: opts.task,
          cwd: opts.cwd,
          label: opts.label,
          ...(effectiveModel ? { model: { provider: '', model: effectiveModel } } : {}),
          ...(defaults?.timeoutMinutes ? { timeoutMs: defaults.timeoutMinutes * 60_000 } : {})
        })
        return { sessionKey: childKey }
      },
      async stop(sessionKey) {
        if (input.harnesses?.runner.has(sessionKey)) return input.harnesses.runner.stop(sessionKey)
        const backend = routing.forSession(sessionKey)
        if (!backend.stopSubagent) throw new Error('agents_stop: backend does not support stopping subagents')
        await backend.stopSubagent(sessionKey)
      },
      harnesses() {
        return input.harnesses?.runner.describe() ?? []
      }
    },
    notifications: {
      send(input) {
        const id = randomUUID()
        const notification = {
          id,
          timestamp: new Date().toISOString(),
          severity: (input.severity as 'info' | 'warning' | 'error' | 'critical') ?? 'info',
          title: input.title,
          body: input.body ?? '',
          source: 'sovereign-agent',
          read: false,
          dismissed: false,
          entityId: input.entityId
        }
        notificationsModule._store.append(notification)
        bus.emit({
          type: 'notification.created',
          timestamp: notification.timestamp,
          source: 'notifications',
          payload: notification
        })
        return { id }
      }
    },
    planning: {
      async createIssue(o) {
        const result = await planningService.createIssue(o.orgId, {
          remote: o.remote,
          projectId: o.projectId,
          title: o.title,
          body: o.body,
          labels: o.labels,
          assignees: o.assignees
        })
        return {
          id: result.issue.id,
          orgId: result.issue.orgId,
          projectId: result.issue.projectId,
          title: result.issue.title
        }
      },
      async updateIssue(o) {
        const updated = await issueTracker.update(o.orgId, o.projectId, o.issueId, {
          title: o.title,
          body: o.body,
          state: o.state,
          labels: o.labels
        })
        return {
          id: updated.id,
          orgId: updated.orgId,
          projectId: updated.projectId,
          title: updated.title,
          state: updated.state
        }
      }
    },
    orgs: {
      list() {
        return orgManager.listOrgs().map((o: any) => ({ id: o.id, name: o.name, path: o.path }))
      }
    },
    meetings: {
      async list(orgId, limit) {
        const list = await meetingsService.list(orgId, { limit: limit ?? 20 })
        return list.map((m: any) => ({ id: m.id, title: m.title, createdAt: m.createdAt }))
      },
      async read(orgId, id) {
        const m = await meetingsService.get(orgId, id)
        if (!m) return null
        return {
          id: m.id,
          title: m.title,
          transcript: m.transcript?.text,
          summary: m.summary?.text
        }
      }
    },
    browser: {
      async open(o) {
        return browserService.open(o)
      },
      async act(sid, action) {
        return browserService.act(sid, action)
      },
      async close(sid) {
        return browserService.close(sid)
      }
    },
    currentSessionKey() {
      // Base implementation returns undefined. Per-session overrides are injected
      // by createSovereignMcpInstance (Claude Code HTTP path) or by the local-llm
      // executor setting activeLocalSession before each turn.
      return undefined
    },
    ...(input.presence ? { presence: input.presence } : {}),
    ...(input.embeddings ? { embeddings: input.embeddings } : {}),
    ...(input.tasks ? { tasks: input.tasks } : {}),
    ...(input.prWatch ? { prWatch: input.prWatch } : {}),
    ...(input.forge ? { forge: input.forge } : {}),
    ...(input.decisions ? { decisions: input.decisions } : {})
  }
}
