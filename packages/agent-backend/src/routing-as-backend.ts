// Wraps a RoutingBackend so callers that expect a single `AgentBackend`
// transparently dispatch per-session calls to the correct underlying
// backend.

import type {
  AgentBackend,
  AgentBackendEvents,
  AgentBackendKind,
  BackendCapabilities,
  ContextBudget,
  ParsedTurn,
  SessionKind,
  SessionMeta,
  SessionSummary,
  SubagentSummary
} from '@sovereign/core'
import type { RoutingBackend } from './factory.js'

/**
 * Returns an `AgentBackend`-shaped object whose session-keyed methods route
 * through `routing.forSession(sessionKey)`. Non-session methods (capabilities,
 * connect, etc.) delegate to the default backend.
 */
export function routingAsBackend(routing: RoutingBackend): AgentBackend {
  function forSession(sessionKey: string): AgentBackend {
    return routing.forSession(sessionKey)
  }

  const def = () => routing.default()
  const KIND: AgentBackendKind = def().kind

  return {
    kind: KIND,
    async connect() {
      await routing.connectAll()
    },
    async disconnect() {
      await routing.disconnectAll()
    },
    status() {
      return def().status()
    },
    async sendMessage(sessionKey, text, attachments) {
      await forSession(sessionKey).sendMessage(sessionKey, text, attachments)
    },
    async abort(sessionKey) {
      await forSession(sessionKey).abort(sessionKey)
    },
    async switchSession(sessionKey) {
      await forSession(sessionKey).switchSession(sessionKey)
    },
    async createSession(label, opts) {
      return await def().createSession(label, opts)
    },
    async getHistory(sessionKey): Promise<{ turns: ParsedTurn[]; hasMore: boolean }> {
      return await forSession(sessionKey).getHistory(sessionKey)
    },
    async getFullHistory(sessionKey): Promise<ParsedTurn[]> {
      return await forSession(sessionKey).getFullHistory(sessionKey)
    },
    on<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void) {
      routing.on(event, handler)
    },
    off<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void) {
      routing.off(event, handler)
    },
    capabilities(): BackendCapabilities {
      return def().capabilities()
    },
    async listSessions(filter?: { kind?: SessionKind; parentKey?: string }): Promise<SessionSummary[]> {
      const out: SessionSummary[] = []
      for (const inst of routing.all()) {
        try {
          out.push(...(await inst.backend.listSessions(filter)))
        } catch {
          /* ignore */
        }
      }
      return out
    },
    async listSubagents(parentKey?: string): Promise<SubagentSummary[]> {
      const out: SubagentSummary[] = []
      for (const inst of routing.all()) {
        try {
          out.push(...(await inst.backend.listSubagents(parentKey)))
        } catch {
          /* ignore */
        }
      }
      return out
    },
    async getSessionMeta(sessionKey): Promise<SessionMeta | null> {
      return await forSession(sessionKey).getSessionMeta(sessionKey)
    },
    async setSessionModel(sessionKey, provider, model) {
      await forSession(sessionKey).setSessionModel(sessionKey, provider, model)
    },
    async listAvailableModels() {
      return await def().listAvailableModels()
    },
    async getContextBudget(sessionKey): Promise<ContextBudget | null> {
      return await forSession(sessionKey).getContextBudget(sessionKey)
    },
    async spawnSubagent(parentSessionKey, opts) {
      const b = forSession(parentSessionKey)
      if (!b.spawnSubagent) throw new Error(`Backend ${b.kind} does not support spawnSubagent`)
      return await b.spawnSubagent(parentSessionKey, opts)
    },
    getSessionFilePath(sessionKey) {
      return forSession(sessionKey).getSessionFilePath?.(sessionKey) ?? null
    },
    async getActivityMap() {
      const merged = new Map<string, number>()
      for (const inst of routing.all()) {
        if (!inst.backend.getActivityMap) continue
        try {
          const m = await inst.backend.getActivityMap()
          for (const [k, v] of m) {
            const prev = merged.get(k) ?? 0
            if (v > prev) merged.set(k, v)
          }
        } catch {
          /* ignore per-backend failure */
        }
      }
      return merged
    }
  }
}
