// Composition root for the agent-backend layer. Builds the routing backend,
// the Sovereign MCP server, the cron service, and the per-org tool policy —
// returning concrete refs the entry point binds to chat/threads/scheduler.

import fs from 'node:fs'
import type { EventBus, AgentBackendKind } from '@sovereign/core'
import type { ConfigStore } from '@sovereign/config'
import { createBackend } from './factory.js'
import { routingAsBackend } from './routing-as-backend.js'
import { createSessionsRegistry } from '@sovereign/primitives'
import { createActiveSessions, type ActiveSessions } from './active-sessions.js'
import {
  createClaudeCodeBackend,
  claudeCodeConfigGetter,
  createSovereignMcpServer,
  createAskUserQuestionStore,
  type ClaudeCodeBackend,
  type AskUserQuestionStore
} from './claude-code/index.js'
import { createLocalLlmBackend, localLlmConfigGetter } from './local-llm/index.js'
import { buildSovereignMcpDeps } from './mcp-deps.js'
import { createCronService, type CronService } from '@sovereign/scheduler'
import type { Scheduler } from '@sovereign/scheduler'
import type { OrgManager } from '@sovereign/orgs'
import type { MembraneManager } from '@sovereign/membranes'
import type { ThreadManager } from '@sovereign/threads'
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
  /** Sovereign config dir — threaded to the Claude Code adapter for config-rooted resources. */
  configDir?: string
  configStore: ConfigStore
  scheduler: Scheduler
  orgManager: OrgManager
  /**
   * Optional. When provided alongside `threadManager`, each Claude Code
   * session gets the membrane's `CONTEXT.md` appended to the SDK's
   * preset system prompt. Missing manager (or missing thread/membrane)
   * is a silent no-op — sessions still run with just the global
   * personality.
   */
  membraneManager?: MembraneManager
  /** Optional. Used together with `membraneManager` to resolve session → thread → membrane. */
  threadManager?: ThreadManager
  planningService: PlanningService
  issueTracker: IssueTracker
  meetingsService: MeetingsService
  notificationsModule: Notifications
  browserService: BrowserService
  /** Presence-thread integration. When set, the seven presence_* MCP tools
   *  are registered. Sourced from `@sovereign/presence`. */
  presence?: import('./claude-code/mcp-server.js').PresenceMcpDeps
  /** Path to PRESENCE.md — appended to the session prompt for the presence
   *  thread only. */
  presencePersonalityFile?: string
  /** Path to PRESENCE_MEMORY.md — appended to the session prompt for the
   *  presence thread only. */
  presenceMemoryFile?: string
  /** Path to PRESENCE_KNOWLEDGE.md — appended to the session prompt for
   *  BOTH presence threads (internal + gateway). Carries the AD4M knowledge
   *  graph schema, tools reference, and usage patterns. */
  presenceKnowledgeFile?: string
  /** Late-bound health summary for the internal presence thread. Called at
   *  session-start time (not at wiring time) so the system module can
   *  populate before any session fires. */
  presenceGetHealthSummary?: () => string | undefined
}

export interface AgentBackendWiringResult {
  routingBackend: RoutingBackend
  backend: AgentBackend
  cronService: CronService
  claudeCodeBackend: ClaudeCodeBackend | undefined
  sessionsRegistry: SessionsRegistry
  activeSessions: ActiveSessions
  sovereignMcpServer: import('@anthropic-ai/claude-agent-sdk').McpSdkServerConfigWithInstance
  /** Creates a fresh McpServer instance bound to the same live deps — use for per-session HTTP transport. */
  createSovereignMcpInstance: () => import('@modelcontextprotocol/sdk/server/mcp.js').McpServer
  /** Registry of pending Claude Code `AskUserQuestion` calls awaiting user submission. */
  askUserQuestionStore: AskUserQuestionStore
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

/**
 * Sovereign session keys take the form `agent:main:thread:<key>` for
 * threads and `agent:main:main` for the main "ambient" session. Inverse
 * of `deriveSessionKey`.
 */
export function sessionKeyToThreadKey(sessionKey: string): string | undefined {
  // Bare-UUID scheme: a thread session's key IS the Thread.id. Legacy
  // compound forms are coerced for safety. Subagent sessions resolve to a
  // non-thread id, so `threadManager.get()` simply misses and no membrane
  // context is injected for them — which is the desired behaviour.
  if (!sessionKey) return undefined
  if (sessionKey === 'agent:main:main') return 'main'
  if (sessionKey.startsWith('agent:main:subagent:')) return undefined
  const prefix = 'agent:main:thread:'
  if (sessionKey.startsWith(prefix)) return sessionKey.slice(prefix.length)
  return sessionKey
}

/**
 * Build the per-session system-prompt-append resolver from the membrane
 * + thread managers. Returns `undefined` (= no manager wiring) when
 * either input is missing, so the wiring is safe to call even when the
 * membrane layer isn't enabled.
 *
 * Exported for unit testing. Production wiring uses it internally.
 */
export function makeMembraneAppendResolver(
  membraneManager: MembraneManager | undefined,
  threadManager: ThreadManager | undefined
): ((sessionKey: string) => string | undefined) | undefined {
  if (!membraneManager || !threadManager) return undefined
  return (sessionKey: string): string | undefined => {
    const threadKey = sessionKeyToThreadKey(sessionKey)
    if (!threadKey) return undefined
    const thread = threadManager.get(threadKey)
    if (!thread?.membraneId) return undefined
    const ctx = membraneManager.renderContext(thread.membraneId)
    return ctx ?? undefined
  }
}

/**
 * Wraps the membrane append resolver so that presence sessions get extra
 * prompt layers on top of the membrane context:
 *
 *  - **Internal thread** — PRESENCE.md + PRESENCE_MEMORY.md + PRESENCE_KNOWLEDGE.md + health summary
 *  - **Gateway thread**  — PRESENCE_KNOWLEDGE.md only
 *
 * The knowledge file carries the AD4M knowledge-graph schema and usage
 * patterns; both threads need it so either can read/write the graph.
 * See plans/presence-thread-spec.md (R3).
 *
 * The health summary injects startup service status into the internal
 * thread so the LLM knows which services are available without probing.
 */
export function makePresenceAwareAppendResolver(
  membraneManager: MembraneManager | undefined,
  threadManager: ThreadManager | undefined,
  presence: {
    internalThreadId(): string | null
    gatewayThreadId(): string | null
    personalityFile?: string
    memoryFile?: string
    knowledgeFile?: string
    /** Late-bound health summary — called when the session starts (not at
     *  wiring time). Returns a formatted string or undefined to skip. */
    getHealthSummary?: () => string | undefined
  }
): ((sessionKey: string) => string | undefined) | undefined {
  const base = makeMembraneAppendResolver(membraneManager, threadManager)
  return (sessionKey: string): string | undefined => {
    const parts: string[] = []
    const baseAppend = base?.(sessionKey)
    if (baseAppend) parts.push(baseAppend)
    const threadKey = sessionKeyToThreadKey(sessionKey)
    const internalId = presence.internalThreadId()
    const gatewayId = presence.gatewayThreadId()

    // Internal thread gets personality + memory + knowledge + health.
    if (threadKey && internalId && threadKey === internalId) {
      if (presence.personalityFile) {
        try {
          const txt = fs.readFileSync(presence.personalityFile, 'utf-8').trim()
          if (txt) parts.push(txt)
        } catch {
          /* missing — skip silently */
        }
      }
      if (presence.memoryFile) {
        try {
          const txt = fs.readFileSync(presence.memoryFile, 'utf-8').trim()
          if (txt) parts.push(`# Presence memory\n\n${txt}`)
        } catch {
          /* missing — skip silently */
        }
      }

      // Health summary — injected at session start so the LLM knows
      // which external services are available right now.
      if (presence.getHealthSummary) {
        try {
          const summary = presence.getHealthSummary()
          if (summary) parts.push(summary)
        } catch {
          /* health unavailable — skip silently */
        }
      }
    }

    // Both presence threads (internal + gateway) get the knowledge layer.
    const isPresenceThread =
      threadKey != null &&
      ((internalId != null && threadKey === internalId) || (gatewayId != null && threadKey === gatewayId))
    if (isPresenceThread && presence.knowledgeFile) {
      try {
        const txt = fs.readFileSync(presence.knowledgeFile, 'utf-8').trim()
        if (txt) parts.push(txt)
      } catch {
        /* missing — skip silently */
      }
    }

    // Subagent routing — inject when the thread has a subagent config so the
    // model routes `agents_spawn` calls to the configured backend/model.
    if (threadKey && threadManager) {
      const thread = threadManager.get(threadKey)
      if (thread?.subagentBackend || thread?.subagentModel) {
        const lines: string[] = ['# Subagent Routing Configuration']
        lines.push(
          'This thread has per-thread subagent routing configured. When spawning subagents via `agents_spawn`:'
        )
        if (thread.subagentBackend) {
          lines.push(
            `- Pass \`backend: "${thread.subagentBackend}"\` to route subagents to the ${thread.subagentBackend} backend.`
          )
        }
        if (thread.subagentModel) {
          lines.push(`- The configured subagent model: \`${thread.subagentModel}\``)
        }
        lines.push(
          'The harness also enforces these defaults automatically — subagents spawned without an explicit backend/model override will use these values.'
        )
        parts.push(lines.join('\n'))
      }
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined
  }
}

export function wireAgentBackend(input: AgentBackendWiringInput): AgentBackendWiringResult {
  const {
    bus,
    dataDir,
    configStore,
    scheduler,
    orgManager,
    membraneManager,
    threadManager,
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
  const activeSessions = createActiveSessions({ dataDir })
  const askUserQuestionStore = createAskUserQuestionStore(bus)
  const sharedMcpDeps = buildSovereignMcpDeps({
    bus,
    routing: new Proxy({} as any, { get: (_t, p) => (routingBackend as any)[p as any] }),
    cronService: new Proxy({} as any, { get: (_t, p) => (cronService as any)[p as any] }),
    orgManager,
    threadManager,
    planningService,
    issueTracker,
    meetingsService,
    notificationsModule,
    browserService,
    getClaudeCodeBackend: () => claudeCodeBackend,
    ...(input.presence ? { presence: input.presence } : {})
  })
  const sovereignMcpServer = createSovereignMcpServer(sharedMcpDeps)

  const enabledBackends = configStore.get<string[]>('agentBackend.enabled') as AgentBackendKind[]
  const defaultKind = configStore.get<AgentBackendKind>('agentBackend.default')

  routingBackend = createBackend({
    enabled: enabledBackends,
    default: defaultKind,
    registry: sessionsRegistry,
    factories: {
      'claude-code': () => {
        const cc = createClaudeCodeBackend(claudeCodeConfigGetter(configStore, dataDir, input.configDir), {
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
                model: existing.model,
                effort: existing.effort,
                contextWindow: existing.contextWindow
              }
            }
          },
          toolPolicy: makeToolPolicy(orgManager),
          activeSessions,
          askUserQuestionStore,
          resolveAppendSystemPrompt: makePresenceAwareAppendResolver(membraneManager, threadManager, {
            internalThreadId: () => input.presence?.internalThreadId() ?? null,
            gatewayThreadId: () => input.presence?.gatewayThreadId() ?? null,
            personalityFile: input.presencePersonalityFile,
            memoryFile: input.presenceMemoryFile,
            knowledgeFile: input.presenceKnowledgeFile,
            getHealthSummary: input.presenceGetHealthSummary
          })
        })
        claudeCodeBackend = cc
        return cc
      },
      'local-llm': () => {
        return createLocalLlmBackend(localLlmConfigGetter(configStore, dataDir), {
          dataDir,
          registry: {
            upsertSession(record: Record<string, unknown>) {
              sessionsRegistry.upsert({ ...record, backendKind: 'local-llm' } as never)
            },
            lookupSession(sessionKey: string) {
              const existing = sessionsRegistry.getBySession(sessionKey)
              if (!existing || existing.backendKind !== 'local-llm') return null
              return existing
            }
          },
          resolveSystemPromptAppend: makePresenceAwareAppendResolver(membraneManager, threadManager, {
            internalThreadId: () => input.presence?.internalThreadId() ?? null,
            gatewayThreadId: () => input.presence?.gatewayThreadId() ?? null,
            personalityFile: input.presencePersonalityFile,
            memoryFile: input.presenceMemoryFile,
            knowledgeFile: input.presenceKnowledgeFile,
            getHealthSummary: input.presenceGetHealthSummary
          })
        })
      }
    }
  })

  // Cron fires call `injectChatMessage` (resolved lazily so bootstrap can
  // wire `chatModule.handleSend` after this function returns). When unwired,
  // the service falls back to direct routing — preserves test/CI defaults.
  // `opts.kind` (e.g. 'cron') flows through so the chat module can emit a
  // role-correct synthetic chat.turn (system for cron, user otherwise).
  let chatInjector: ((threadId: string, text: string, opts?: { kind?: 'cron' }) => Promise<void>) | undefined
  cronService = createCronService({
    routing: routingBackend,
    scheduler,
    bus,
    injectChatMessage: (threadId, text, opts) => {
      if (chatInjector) return chatInjector(threadId, text, opts)
      return routingBackend.forSession(threadId).sendMessage(threadId, text)
    }
  })
  // Expose the setter so bootstrap can plug in the chat module after it's
  // constructed without restructuring the existing return shape.
  ;(cronService as any).setInjectChatMessage = (
    fn: ((threadId: string, text: string, opts?: { kind?: 'cron' }) => Promise<void>) | undefined
  ): void => {
    chatInjector = fn
  }

  return {
    routingBackend,
    backend: routingAsBackend(routingBackend),
    cronService,
    claudeCodeBackend,
    sessionsRegistry,
    activeSessions,
    sovereignMcpServer,
    createSovereignMcpInstance: () => createSovereignMcpServer(sharedMcpDeps).instance,
    askUserQuestionStore
  }
}
