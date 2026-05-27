// Canonical liveness index across every backend. Written through to
// `<dataDir>/agent-backend/active-sessions.json` on every state transition
// (R7, R8). The CLI's `/api/system/agents/active` endpoint reads from here
// (R9), as does the boot-time `resumeActiveSessions()` sweep.
//
// Status transitions are written synchronously (R5) — a SIGKILL between two
// `chat.work` body events may lose the last work bump, but the transition
// itself is always on disk by the time it returns.

import path from 'node:path'
import type { AgentBackendKind } from '@sovereign/core'
import { createWriteThroughFile, type WriteThroughFile } from '@sovereign/primitives'

export type ActiveAgentStatus = 'working' | 'thinking'

export interface ActiveSubagent {
  agentId: string
  label?: string
  startedAt: number
}

export interface ActiveSessionEntry {
  threadKey: string
  sessionKey: string
  backendKind: AgentBackendKind
  backendSessionId: string
  backendSessionFile?: string
  cwd?: string
  orgId?: string
  agentStatus: ActiveAgentStatus
  lastTransitionAt: number
  lastTransitionReason?: string
  /** Queue id of the user message currently being processed, if any. */
  inFlightQueueId?: string
  /** Text of the user message currently being processed, if any. */
  inFlightPromptText?: string
  /** Wall time of the last assistant message we've seen for this session. */
  lastAssistantMessageAt?: number
  /** Size (bytes) of the backend session JSONL at the last transition. */
  lastJsonlSize?: number
  /** Live subagents spawned by this session. */
  subagents?: ActiveSubagent[]
}

export interface ActiveSessionsSnapshot {
  [sessionKey: string]: ActiveSessionEntry
}

export interface ActiveSessions {
  /** Upsert a session entry. Synchronous write (R5). */
  upsert(entry: ActiveSessionEntry): void
  /** Drop an entry — call this when a session goes idle (R7). Synchronous. */
  remove(sessionKey: string): void
  /** Snapshot of every entry currently considered active. */
  list(): ActiveSessionEntry[]
  /** Look up a single entry. */
  get(sessionKey: string): ActiveSessionEntry | undefined
  /** Record that a queued user message is now being processed by `sessionKey`. */
  setInFlight(sessionKey: string, info: { queueId: string; promptText: string }): void
  /** Update the JSONL size / lastAssistantMessageAt for a session. Debounced (R5). */
  bumpActivity(sessionKey: string, patch: { lastJsonlSize?: number; lastAssistantMessageAt?: number }): void
  /** Add a subagent record to its parent session. Synchronous. */
  addSubagent(sessionKey: string, sub: ActiveSubagent): void
  /** Remove a subagent record from its parent session. Synchronous. */
  removeSubagent(sessionKey: string, agentId: string): void
  /** Synchronously flush any pending debounced write. Called from shutdown. */
  flush(): void
}

const SCHEMA_VERSION = 1
const FILE_NAME = 'active-sessions.json'
// Status transitions write synchronously (R5); activity bumps use the
// debounce below (R5 high-frequency body events).
const ACTIVITY_DEBOUNCE_MS = 250

export interface CreateActiveSessionsOptions {
  dataDir: string
  /** Override file path (for tests). */
  filePath?: string
}

export function createActiveSessions(opts: CreateActiveSessionsOptions): ActiveSessions {
  const filePath = opts.filePath ?? path.join(opts.dataDir, 'agent-backend', FILE_NAME)

  // We use one file with two write paths: synchronous for transitions (R5)
  // and a debounced write for activity bumps. Both touch the same in-memory
  // snapshot; the debounce window is the only thing that differs.
  const file: WriteThroughFile<ActiveSessionsSnapshot> = createWriteThroughFile<ActiveSessionsSnapshot>({
    filePath,
    version: SCHEMA_VERSION,
    defaultValue: {},
    debounceMs: ACTIVITY_DEBOUNCE_MS,
    label: 'active-sessions'
  })

  function mutateSync(fn: (snap: ActiveSessionsSnapshot) => void): void {
    const next = { ...file.read() }
    fn(next)
    file.updateSync(() => next)
  }

  function mutateDebounced(fn: (snap: ActiveSessionsSnapshot) => void): void {
    const next = { ...file.read() }
    fn(next)
    file.update(() => next)
  }

  return {
    upsert(entry) {
      mutateSync((snap) => {
        const existing = snap[entry.sessionKey]
        snap[entry.sessionKey] = {
          ...existing,
          ...entry,
          subagents: entry.subagents ?? existing?.subagents
        }
      })
    },
    remove(sessionKey) {
      mutateSync((snap) => {
        delete snap[sessionKey]
      })
    },
    list() {
      const snap = file.read()
      return Object.values(snap)
    },
    get(sessionKey) {
      return file.read()[sessionKey]
    },
    setInFlight(sessionKey, info) {
      mutateSync((snap) => {
        const existing = snap[sessionKey]
        if (!existing) return
        existing.inFlightQueueId = info.queueId
        existing.inFlightPromptText = info.promptText
        existing.lastTransitionAt = Date.now()
      })
    },
    bumpActivity(sessionKey, patch) {
      mutateDebounced((snap) => {
        const existing = snap[sessionKey]
        if (!existing) return
        if (typeof patch.lastJsonlSize === 'number') existing.lastJsonlSize = patch.lastJsonlSize
        if (typeof patch.lastAssistantMessageAt === 'number') {
          existing.lastAssistantMessageAt = patch.lastAssistantMessageAt
        }
        existing.lastTransitionAt = Date.now()
      })
    },
    addSubagent(sessionKey, sub) {
      mutateSync((snap) => {
        const existing = snap[sessionKey]
        if (!existing) return
        const subs = existing.subagents ? [...existing.subagents] : []
        if (!subs.some((s) => s.agentId === sub.agentId)) subs.push(sub)
        existing.subagents = subs
      })
    },
    removeSubagent(sessionKey, agentId) {
      mutateSync((snap) => {
        const existing = snap[sessionKey]
        if (!existing?.subagents) return
        existing.subagents = existing.subagents.filter((s) => s.agentId !== agentId)
      })
    },
    flush() {
      file.flush()
    }
  }
}
