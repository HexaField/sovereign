// Composition root for the agent-backend layer. Builds the routing backend,
// the Sovereign MCP server, the cron service, and the per-org tool policy —
// returning concrete refs the entry point binds to chat/threads/scheduler.

import type { EventBus, AgentBackendKind } from '@sovereign/core'
import { createBackend } from './factory.js'
import { routingAsBackend } from './routing-as-backend.js'
import { createSessionsRegistry } from '@sovereign/primitives'
import {
  createClaudeCodeBackend,
  claudeCodeConfigFromEnv,
  createSovereignMcpServer,
  type ClaudeCodeBackend
} from './claude-code/index.js'
import { createOpenClawBackend, type OpenClawBackend } from './openclaw/openclaw.js'
import { openClawConfigFromEnv } from './openclaw/env-config.js'
import { buildSovereignMcpDeps } from './mcp-deps.js'
import { createCronService, type CronService } from '@sovereign/scheduler'
import type { Scheduler } from '@sovereign/scheduler'
import type { OrgManager } from '@sovereign/orgs'
import type { PlanningService } from '@sovereign/planning'
import type { IssueTracker } from '@sovereign/issues'
import type { MeetingsService } from '@sovereign/meetings'
import type { Notifications } from '@sovereign/notifications'
import type { BrowserService } from '@sovereign/browser'
import type { SessionsRegistry } from '@sovereign/primitives'
import type { AgentBackend } from '@sovereign/core'
import type { RoutingBackend } from './factory.js'

export interface AgentBackendWiringInput {
  bus: EventBus
  dataDir: string
  scheduler: Scheduler
  orgManager: OrgManager
  planningService: PlanningService
  issueTracker: IssueTracker
  meetingsService: MeetingsService
  notificationsModule: Notifications
  browserService: BrowserService
}

export interface AgentBackendWiringResult {
  routingBackend: RoutingBackend
  backend: AgentBackend
  cronService: CronService
  openClawBackend: OpenClawBackend | undefined
  claudeCodeBackend: ClaudeCodeBackend | undefined
  sessionsRegistry: SessionsRegistry
  sovereignMcpServer: import('@anthropic-ai/claude-agent-sdk').McpSdkServerConfigWithInstance
  /** Creates a fresh McpServer instance bound to the same live deps — use for per-session HTTP transport. */
  createSovereignMcpInstance: () => import('@modelcontextprotocol/sdk/server/mcp.js').McpServer
}

function makeToolPolicy(orgManager: OrgManager) {
  return async ({ toolName, orgId }: { toolName: string; orgId?: string }) => {
    if (!orgId) return { decision: 'allow' as const }
    let cfg: Record<string, unknown> | null = null
    try {
      cfg = orgManager.getOrgConfig(orgId) as Record<string, unknown>
    } catch {
      return { decision: 'allow' as const }
    }
    const agentCfg = (cfg?.agent ?? {}) as Record<string, unknown>
    const allow = Array.isArray(agentCfg.toolAllowlist) ? (agentCfg.toolAllowlist as string[]) : null
    const deny = Array.isArray(agentCfg.toolDenylist) ? (agentCfg.toolDenylist as string[]) : null
    if (deny && deny.includes(toolName)) {
      return { decision: 'deny' as const, reason: `Tool '${toolName}' is denied by org '${orgId}' policy.` }
    }
    if (allow && allow.length > 0 && !allow.includes(toolName)) {
      return { decision: 'deny' as const, reason: `Tool '${toolName}' is not in org '${orgId}' allowlist.` }
    }
    return { decision: 'allow' as const }
  }
}

export function wireAgentBackend(input: AgentBackendWiringInput): AgentBackendWiringResult {
  const {
    bus,
    dataDir,
    scheduler,
    orgManager,
    planningService,
    issueTracker,
    meetingsService,
    notificationsModule,
    browserService
  } = input

  // Forward declarations so the MCP deps can reach cronService + claudeCode
  // by closure once they exist. Resolved before any MCP tool fires.
  let cronService!: CronService
  let claudeCodeBackend: ClaudeCodeBackend | undefined
  let routingBackend!: RoutingBackend

  const sessionsRegistry = createSessionsRegistry(dataDir)
  const sharedMcpDeps = buildSovereignMcpDeps({
    bus,
    routing: new Proxy({} as any, { get: (_t, p) => (routingBackend as any)[p as any] }),
    cronService: new Proxy({} as any, { get: (_t, p) => (cronService as any)[p as any] }),
    orgManager,
    planningService,
    issueTracker,
    meetingsService,
    notificationsModule,
    browserService,
    getClaudeCodeBackend: () => claudeCodeBackend
  })
  const sovereignMcpServer = createSovereignMcpServer(sharedMcpDeps)

  const enabledBackends = (process.env.SOVEREIGN_ENABLED_BACKENDS?.trim() || 'openclaw')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as AgentBackendKind[]
  const defaultKind = (process.env.SOVEREIGN_DEFAULT_BACKEND?.trim() || 'openclaw') as AgentBackendKind

  routingBackend = createBackend({
    enabled: enabledBackends,
    default: defaultKind,
    registry: sessionsRegistry,
    factories: {
      openclaw: () => createOpenClawBackend(openClawConfigFromEnv(dataDir)),
      'claude-code': () => {
        const cc = createClaudeCodeBackend(claudeCodeConfigFromEnv(dataDir), {
          sovereignMcpServer,
          registry: {
            upsertSession(record) {
              sessionsRegistry.upsert({ ...record, backendKind: 'claude-code' })
            },
            lookupSession(sessionKey) {
              const existing = sessionsRegistry.getBySession(sessionKey)
              if (!existing || existing.backendKind !== 'claude-code' || !existing.backendSessionId) return null
              return {
                backendSessionId: existing.backendSessionId,
                backendSessionFile: existing.backendSessionFile,
                label: existing.label,
                parentSessionKey: existing.parentSessionKey,
                orgId: existing.orgId,
                cwd: existing.cwd,
                model: existing.model
              }
            }
          },
          toolPolicy: makeToolPolicy(orgManager)
        })
        claudeCodeBackend = cc
        return cc
      }
    }
  })

  const openClawBackend = routingBackend.forKind('openclaw') as OpenClawBackend | undefined
  cronService = createCronService({ routing: routingBackend, scheduler, bus })
  if (openClawBackend?.cronBridge) cronService.registerCronBridge(openClawBackend.cronBridge)

  return {
    routingBackend,
    backend: routingAsBackend(routingBackend),
    cronService,
    openClawBackend,
    claudeCodeBackend,
    sessionsRegistry,
    sovereignMcpServer,
    createSovereignMcpInstance: () => createSovereignMcpServer(sharedMcpDeps).instance
  }
}
