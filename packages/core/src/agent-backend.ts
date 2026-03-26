// Agent Backend — Shared Types & Interfaces

/**
 * Connection status of the agent backend.
 */
export type BackendConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

/**
 * Agent activity status.
 */
export type AgentStatus = 'idle' | 'working' | 'thinking'

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
  /** True while the agent is actively producing this turn */
  streaming?: boolean
}

/**
 * Events emitted by the AgentBackend.
 */
export interface AgentBackendEvents {
  /** Streaming tokens from the agent */
  'chat.stream': { sessionKey: string; text: string }
  /** Agent completed a turn */
  'chat.turn': { sessionKey: string; turn: ParsedTurn }
  /** Agent status changed */
  'chat.status': { sessionKey: string; status: AgentStatus }
  /** Agent is performing work (tool calls, thinking) */
  'chat.work': { sessionKey: string; work: WorkItem }
  /** Context compaction started/completed */
  'chat.compacting': { sessionKey: string; active: boolean }
  /** Error from the agent */
  'chat.error': { sessionKey: string; error: string; retryAfterMs?: number }
  /** Session info (on connect or session switch) */
  'session.info': { sessionKey: string; label?: string; history: ParsedTurn[] }
  /** Backend connection state changed */
  'backend.status': { status: BackendConnectionStatus; reason?: string; errorType?: string }
}

/**
 * Abstract interface for agent backend implementations.
 * The server proxies between the client and this interface.
 */
export interface AgentBackend {
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
  createSession(label?: string): Promise<string>
  /** Get conversation history for a session */
  getHistory(sessionKey: string): Promise<{ turns: ParsedTurn[]; hasMore: boolean }>
  getFullHistory(sessionKey: string): Promise<ParsedTurn[]>
  /** Register a callback for backend events */
  on<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
  /** Unregister a callback */
  off<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
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
