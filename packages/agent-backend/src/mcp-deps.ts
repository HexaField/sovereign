// Build the SovereignToolDeps bag for the Claude Code MCP server. Lives in
// the agent-backend module so the entry point doesn't need to know how each
// MCP tool wires into the underlying services.

import { randomUUID } from 'node:crypto'
import type { PresenceMcpDeps, SovereignToolDeps } from './claude-code/mcp-server.js'
import type { ClaudeCodeBackend } from './claude-code/index.js'
import type { RoutingBackend } from './factory.js'
import type { CronService } from '@sovereign/scheduler'
import type { OrgManager } from '@sovereign/orgs'
import type { PlanningService } from '@sovereign/planning'
import type { IssueTracker } from '@sovereign/issues'
import type { MeetingsService } from '@sovereign/meetings'
import type { Notifications } from '@sovereign/notifications'
import type { BrowserService } from '@sovereign/browser'
import type { EventBus } from '@sovereign/core'

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
  /** Resolver for the currently-active Claude Code session key (optional). */
  getClaudeCodeBackend?: () => ClaudeCodeBackend | undefined
  /** Presence-thread integration. When set, registers the seven presence_*
   *  MCP tools. Sourced from `@sovereign/presence` in bootstrap. */
  presence?: PresenceMcpDeps
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
    browserService,
    getClaudeCodeBackend
  } = input

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
        const key = sessionKey.startsWith('agent:')
          ? sessionKey
          : sessionKey === 'main'
            ? 'agent:main:main'
            : `agent:main:thread:${sessionKey}`
        await routing.forSession(key).sendMessage(key, text)
      },
      async history(sessionKey, limit) {
        const key = sessionKey.startsWith('agent:')
          ? sessionKey
          : sessionKey === 'main'
            ? 'agent:main:main'
            : `agent:main:thread:${sessionKey}`
        const { turns } = await routing.forSession(key).getHistory(key)
        return turns.slice(-(limit ?? 20)).map((t: any) => ({ role: t.role, content: t.content }))
      }
    },
    agents: {
      async list(parentKey) {
        const out: Array<{ sessionKey: string; label: string; status: string; task?: string }> = []
        for (const inst of routing.all()) {
          try {
            const list = await inst.backend.listSubagents(parentKey)
            for (const s of list) out.push({ sessionKey: s.sessionKey, label: s.label, status: s.status, task: s.task })
          } catch {
            /* ignore */
          }
        }
        return out
      },
      async spawn(parentKey, opts) {
        const backend = routing.forSession(parentKey)
        if (!backend.spawnSubagent) throw new Error('agents_spawn: backend does not support subagent spawn')
        const childKey = await backend.spawnSubagent(parentKey, { task: opts.task, label: opts.label })
        return { sessionKey: childKey }
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
      return getClaudeCodeBackend?.()?.getActiveSessionKey()
    },
    ...(input.presence ? { presence: input.presence } : {})
  }
}
