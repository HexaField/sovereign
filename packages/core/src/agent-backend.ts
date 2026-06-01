// Agent Backend — Shared Types & Interfaces

// Forward declaration: the agent-backend layer ships a routing implementation
// that resolves a session key to its owning backend. Lower-layer modules
// (scheduler, cron-service) consume this minimal contract so they can route
// sendMessage calls without depending on the agent-backend package.
//
// The full implementation in @sovereign/agent-backend's `RoutingBackend`
// extends this with `default()`, `forKind()`, etc. Lower layers only need
// `forSession`.
export interface BackendRouter {
  forSession(sessionKey: string): import('./agent-backend.js').AgentBackend
}

/**
 * Connection status of the agent backend.
 */
export type BackendConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

/**
 * Agent activity status.
 */
export type AgentStatus = 'idle' | 'working' | 'thinking'

/**
 * Identifies which concrete backend implementation owns a session/event.
 * Sovereign supports multiple backends concurrently (one per thread).
 */
export type AgentBackendKind = 'pi' | 'claude-code'

/**
 * A single unit of agent work: tool call, result, thinking block, or system event.
 */
export interface WorkItem {
  type: 'tool_call' | 'tool_result' | 'thinking' | 'system_event'
  toolCallId?: string
  name?: string
  input?: string
  output?: string
  icon?: string
  timestamp: number
}

/**
 * A complete conversation turn with role, content, timestamp, work items, and thinking blocks.
 */
export interface ParsedTurn {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  workItems: WorkItem[]
  thinkingBlocks: string[]
  pending?: boolean
  /** True when the send request failed (network error, server error) */
  sendFailed?: boolean
  /** True while the agent is actively producing this turn */
  streaming?: boolean
}

/**
 * Events emitted by the AgentBackend. The optional `backendKind` field lets
 * consumers route per-backend; existing consumers that ignore it keep working.
 */
export interface AgentBackendEvents {
  /** Streaming tokens from the agent */
  'chat.stream': { sessionKey: string; text: string; backendKind?: AgentBackendKind }
  /** Agent completed a turn */
  'chat.turn': { sessionKey: string; turn: ParsedTurn; backendKind?: AgentBackendKind }
  /** Agent status changed */
  'chat.status': { sessionKey: string; status: AgentStatus; backendKind?: AgentBackendKind }
  /** Agent is performing work (tool calls, thinking) */
  'chat.work': { sessionKey: string; work: WorkItem; backendKind?: AgentBackendKind }
  /** Context compaction started/completed */
  'chat.compacting': { sessionKey: string; active: boolean; backendKind?: AgentBackendKind }
  /** Error from the agent */
  'chat.error': { sessionKey: string; error: string; retryAfterMs?: number; backendKind?: AgentBackendKind }
  /** Session info (on connect or session switch) */
  'session.info': { sessionKey: string; label?: string; history: ParsedTurn[]; backendKind?: AgentBackendKind }
  /** Backend connection state changed */
  'backend.status': {
    status: BackendConnectionStatus
    reason?: string
    errorType?: string
    backendKind?: AgentBackendKind
  }
  /** A subagent was spawned by a parent session */
  'subagent.spawned': {
    parentKey: string
    childKey: string
    task: string
    label?: string
    backendKind?: AgentBackendKind
  }
  /** A subagent finished its task */
  'subagent.completed': {
    parentKey: string
    childKey: string
    result: string
    tokenUsage?: TokenUsage
    backendKind?: AgentBackendKind
  }
  /** A subagent failed */
  'subagent.failed': { parentKey: string; childKey: string; error: string; backendKind?: AgentBackendKind }
}

/**
 * Token accounting for a turn or session.
 */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/**
 * Classification of a session as exposed by a backend.
 */
export type SessionKind = 'main' | 'thread' | 'cron' | 'subagent' | 'event-agent' | 'unknown'

/**
 * Lightweight summary of a backend session — used for listing UIs.
 */
export interface SessionSummary {
  /** Canonical session key the backend uses for routing (`agent:main:thread:<x>` etc.) */
  key: string
  /** Backend-specific id (Pi UUID, Claude Code UUID). */
  backendSessionId?: string
  kind: SessionKind
  label?: string
  lastActivity?: number
  agentStatus?: string
  /** For subagent sessions: key of the parent session that spawned this one. */
  parentKey?: string
  task?: string
}

/**
 * Summary of a subagent session attached to a parent.
 */
export interface SubagentSummary {
  sessionKey: string
  label: string
  status: string
  lastActivity?: number
  task?: string
}

/**
 * Per-session metadata — used by the session-info panel and model switching UIs.
 */
export interface SessionMeta {
  sessionKey: string
  model?: string | null
  modelProvider?: string | null
  contextTokens?: number | null
  totalTokens?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  compactionCount?: number | null
  thinkingLevel?: string | null
  task?: string | null
  label?: string | null
  parentKey?: string | null
}

/**
 * Detailed context-budget report for the system view.
 */
export interface ContextBudget {
  source: 'gateway' | 'mock' | 'sovereign'
  generatedAt: number
  provider?: string
  model?: string
  workspaceDir?: string
  bootstrapMaxChars?: number
  systemPrompt?: { chars: number; projectContextChars?: number; nonProjectContextChars?: number }
  injectedWorkspaceFiles?: Array<{ path: string; chars: number }>
  skills?: { promptChars: number; entries: Array<{ name: string; chars: number }> }
  tools?: { listChars: number; schemaChars: number; entries: Array<{ name: string; chars: number }> }
  session?: { contextTokens?: number | null }
  fileContents?: Record<string, string>
  disabledTools?: string[]
  disabledSkills?: string[]
}

/**
 * Backend-specific device-identity info (used by `/api/system/devices`).
 */
export interface DeviceInfo {
  backendKind: AgentBackendKind
  deviceId: string
  publicKey?: string
  connectionStatus: string
  gatewayUrl?: string
  reconnectAttempt?: number
}

/**
 * Options for creating a backend session.
 */
export interface CreateSessionOptions {
  /** Logical thread key Sovereign wants to associate with this session. */
  threadKey?: string
  kind?: SessionKind
  /** For subagents: the parent session that owns this child. */
  parentSessionKey?: string
  /** Optional working directory hint for backends that respect it. */
  cwd?: string
  model?: { provider: string; model: string }
  thinkingLevel?: string
  systemPromptOverride?: string
}

/**
 * Options for spawning a subagent from a parent session.
 */
export interface SpawnSubagentOptions {
  task: string
  label?: string
  model?: { provider: string; model: string }
  thinkingLevel?: string
  toolAllowlist?: string[]
  timeoutMs?: number
}

/**
 * Declared capabilities of a backend — drives routing and feature toggles.
 */
export interface BackendCapabilities {
  subagents: 'native' | 'sovereign-orchestrated' | 'unsupported'
  cron: 'backend-managed' | 'sovereign-managed'
  steering: boolean
  followUp: boolean
  compaction: 'on-demand' | 'automatic-only'
  toolStreaming: boolean
  deviceIdentity: boolean
  multiProvider: boolean
}

/**
 * Abstract interface for agent backend implementations.
 * The server proxies between the client and this interface.
 */
export interface AgentBackend {
  /** Backend identity — for routing, UI, telemetry. Required on all implementations. */
  readonly kind: AgentBackendKind

  /** Connect to the agent backend */
  connect(): Promise<void>
  /** Disconnect from the agent backend */
  disconnect(): Promise<void>
  /** Current connection status */
  status(): BackendConnectionStatus
  /** Send a chat message to a session */
  sendMessage(sessionKey: string, text: string, attachments?: Buffer[]): Promise<void>
  /** Abort in-progress generation for a session */
  abort(sessionKey: string): Promise<void>
  /** Switch to / activate a session */
  switchSession(sessionKey: string): Promise<void>
  /** Create a new session */
  createSession(label?: string, opts?: CreateSessionOptions): Promise<string>
  /** Get conversation history for a session */
  getHistory(sessionKey: string): Promise<{ turns: ParsedTurn[]; hasMore: boolean }>
  getFullHistory(sessionKey: string): Promise<ParsedTurn[]>
  /** Register a callback for backend events */
  on<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
  /** Unregister a callback */
  off<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void

  /** Declared capabilities — drives Sovereign routing. */
  capabilities(): BackendCapabilities

  /** List sessions managed by this backend. Replaces direct sessions.json reads. */
  listSessions(filter?: { kind?: SessionKind; parentKey?: string }): Promise<SessionSummary[]>
  /** List subagents (children) of a parent session, or all subagents if no parent. */
  listSubagents(parentKey?: string): Promise<SubagentSummary[]>
  /** Get metadata for a single session (model, tokens, compaction, etc.). */
  getSessionMeta(sessionKey: string): Promise<SessionMeta | null>
  /** Update the model bound to a session. */
  setSessionModel(sessionKey: string, provider: string, model: string): Promise<void>
  /** List models available to this backend. */
  listAvailableModels(): Promise<{ models: string[]; defaultModel: string | null }>
  /** Get the context-budget report for a session. */
  getContextBudget(sessionKey: string): Promise<ContextBudget | null>

  /** OPTIONAL — backends that natively support subagents implement this. */
  spawnSubagent?(parentSessionKey: string, opts: SpawnSubagentOptions): Promise<string>
  /** OPTIONAL — backends with a device identity. */
  getDeviceInfo?(): DeviceInfo | null

  /**
   * Resolve a logical session key to the path of the backend's JSONL file (if any).
   * Returns `null` for backends that don't keep a JSONL on disk.
   * Used for fast history reads and live-poll views.
   */
  getSessionFilePath?(sessionKey: string): string | null

  /**
   * OPTIONAL — returns the last-activity wall time (ms) for every session
   * the backend knows about, regardless of whether it's currently running.
   *
   * Must be cheap: backends should derive timestamps from file mtimes or
   * registry/index lookups — NEVER load conversation contents. This feeds
   * the ThreadDrawer "5m ago" labels and the threads-list sort order;
   * calling it on every render must remain O(sessions) and IO-bounded by a
   * stat per session at worst.
   *
   * Map keys are *both* canonical session keys and the equivalent thread
   * key (so callers don't have to know the encoding) — e.g. an entry for
   * `agent:main:thread:foo` will also appear under `foo`, and
   * `agent:main:main` will also appear under `main`. Backends that don't
   * know about a session simply omit it.
   */
  getActivityMap?(): Promise<Map<string, number>>
}

/**
 * A message forwarded from one thread to another.
 */
export interface ForwardedMessage {
  /** Original message content (markdown) */
  originalContent: string
  /** Who sent the original message */
  originalRole: 'user' | 'assistant' | 'system'
  /** Unix timestamp of the original message */
  originalTimestamp: number
  /** Thread key where the message originated */
  sourceThread: string
  /** Human-readable source thread label */
  sourceThreadLabel: string
  /** Optional commentary added by the user when forwarding */
  commentary?: string
  /** File attachments from the original message */
  attachments?: string[]
}
