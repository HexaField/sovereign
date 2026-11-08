// The agents_spawn harness runs (runner.ts) as a backend that owns only the
// sessions it starts (`harness-<uuid>`): routing sends those keys here, so
// the subagent card, view and lists read a harness run as they read a Claude
// Code subagent. A run takes no messages; abort stops it.

import { unwrapThreadId, type AgentBackend, type BackendCapabilities, type SessionSummary } from '@sovereign/core'
import type { HarnessRunner, HarnessRunRecord } from './runner.js'

const CAPABILITIES: BackendCapabilities = {
  subagents: 'unsupported',
  cron: 'sovereign-managed',
  steering: false,
  followUp: false,
  compaction: 'automatic-only',
  toolStreaming: false,
  deviceIdentity: false,
  multiProvider: false
}

export function isHarnessSessionKey(key: string): boolean {
  return key.startsWith('harness-')
}

export function createHarnessBackend(runner: HarnessRunner): AgentBackend {
  const agentStatus = (r: HarnessRunRecord) => (r.status === 'working' ? 'working' : 'idle')
  const ofParent = (parentKey?: string) => {
    const parent = parentKey ? unwrapThreadId(parentKey) : undefined
    return runner.records().filter((r) => !parent || unwrapThreadId(r.parentKey) === parent)
  }
  const noMessages = (sessionKey: string): never => {
    throw new Error(`${sessionKey} is a harness run: it takes no messages (agents_spawn a new run instead)`)
  }

  return {
    kind: 'harness',
    ownsSession: isHarnessSessionKey,
    async connect() {},
    async disconnect() {},
    status: () => 'connected',
    async sendMessage(sessionKey) {
      noMessages(sessionKey)
    },
    async abort(sessionKey) {
      if (runner.has(sessionKey)) await runner.stop(sessionKey)
    },
    async switchSession() {},
    async createSession() {
      throw new Error('harness runs start through agents_spawn')
    },
    async getHistory(sessionKey, opts) {
      let turns = runner.history(sessionKey) ?? []
      if (opts?.before) turns = turns.filter((t) => t.timestamp < opts.before!)
      const limit = opts?.limit ?? (opts?.before ? 50 : turns.length)
      const page = limit < turns.length ? turns.slice(-limit) : turns
      return { turns: page, hasMore: turns.length > page.length, oldestTimestamp: page[0]?.timestamp }
    },
    async getFullHistory(sessionKey) {
      return runner.history(sessionKey) ?? []
    },
    on: runner.on,
    off: runner.off,
    capabilities: () => CAPABILITIES,
    async listSessions(filter) {
      if (filter?.kind && filter.kind !== 'subagent') return []
      return ofParent(filter?.parentKey).map(
        (r): SessionSummary => ({
          key: r.sessionKey,
          kind: 'subagent',
          label: r.label,
          lastActivity: r.endedAt ?? Date.now(),
          agentStatus: agentStatus(r),
          parentKey: r.parentKey,
          task: r.task,
          cwd: r.cwd,
          startedAt: r.startedAt
        })
      )
    },
    async listSubagents(parentKey) {
      return ofParent(parentKey).map((r) => ({
        sessionKey: r.sessionKey,
        label: r.label,
        status: agentStatus(r),
        lastActivity: r.endedAt ?? Date.now(),
        task: r.task
      }))
    },
    async getSessionMeta(sessionKey) {
      const r = runner.record(sessionKey)
      if (!r) return null
      return {
        sessionKey,
        model: r.model ?? null,
        task: r.task,
        label: r.label,
        parentKey: r.parentKey,
        backendKind: 'harness'
      }
    },
    async setSessionModel(sessionKey) {
      throw new Error(`${sessionKey} is a harness run: its model is set at agents_spawn`)
    },
    async listAvailableModels() {
      return { models: [], defaultModel: null }
    },
    async getContextBudget() {
      return null
    },
    async stopSubagent(childKey) {
      await runner.stop(childKey)
    }
  }
}
