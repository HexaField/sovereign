// Claude Code adapter — internal types. All public surface is re-exported
// through `./index.ts`.

import type { AgentStatus, BackendConnectionStatus, ReasoningEffort } from '@sovereign/core'

/** Configuration accepted by `createClaudeCodeBackend`. */
export interface ClaudeCodeConfig {
  /** Sovereign data dir. The adapter lives under `${dataDir}/agent-backend/claude-code/`. */
  dataDir: string
  /**
   * Sovereign config dir (e.g. `~/.sovereign`). Used to locate skills and
   * other config-rooted resources. When absent, features that depend on
   * configDir (e.g. AD4M skill symlink) silently skip.
   */
  configDir?: string
  /**
   * Working directory used as `cwd` for new sessions. Drives CLAUDE.md walk-up
   * and the on-disk session JSONL path layout under `~/.claude/projects/<encoded-cwd>/`.
   * Defaults to `process.cwd()`.
   */
  cwd?: string
  /**
   * Override `CLAUDE_CONFIG_DIR`-equivalent root for sessions and personality.
   * Defaults to `${HOME}/.claude`.
   */
  agentDir?: string
  /** Default model alias used when none is set per-session. */
  defaultModel?: string
  /**
   * Map of model alias → max context window tokens. Returned in
   * `getSessionMeta().contextTokens` so the UI can render a sensible
   * "X / 200k" usage bar. Unknown models fall back to 200_000.
   */
  modelContextWindows?: Record<string, number>
  /**
   * MCP servers to register with every session. Keys are server names. When
   * omitted, only the built-in `sovereign` server (registered by the adapter)
   * is exposed.
   */
  mcpServers?: Record<string, unknown>
  /**
   * Built-in tool allowlist for new sessions. Defaults to:
   * `Read, Write, Edit, Bash, Grep, Glob, LS`.
   */
  defaultTools?: string[]
  /**
   * If true, the adapter MUST NOT spawn a Claude CLI subprocess — the SDK is
   * used in-process exclusively. Default true; only flip for tests that need
   * to swap the SDK shim.
   */
  inProcessOnly?: boolean
  /** Context management settings — filter, recycle, cleanup. Comes from
   *  `configStore.get('contextManagement')`. */
  contextManagement?: {
    filter?: {
      enabled?: boolean
      trimThresholdBytes?: number
      trimMaxLines?: number
      dedupMinBytes?: number
      stripSignatures?: boolean
    }
    recycle?: {
      enabled?: boolean
      thresholdPercent?: number
      minIntervalMs?: number
      prescription?: string
      skipDuringSubagents?: boolean
    }
    cleanup?: {
      enabled?: boolean
      maxSessionSizeMB?: number
      schedule?: string
    }
  }
}

/**
 * Decision returned by a PreToolUse policy. `allow` lets the tool run; `deny`
 * blocks it with `reason` surfaced to the agent; `ask` defers to the user
 * (not currently implemented at the UI surface — treat as allow).
 */
export type ToolPolicyDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason?: string }

/** Inputs to a PreToolUse policy check. */
export interface ToolPolicyContext {
  sessionKey: string
  toolName: string
  toolInput: unknown
  /** Org id the parent thread is bound to, if any. */
  orgId?: string
}

/** Per-org / per-session tool-policy callback consulted in PreToolUse. */
export type ToolPolicy = (ctx: ToolPolicyContext) => ToolPolicyDecision | Promise<ToolPolicyDecision>

/** Live state for a single Claude Code session held by the adapter. */
export interface ClaudeSessionState {
  /** Canonical Sovereign session key (`agent:main:thread:<x>`). */
  sessionKey: string
  /** UUID Sovereign assigns and pins via the SDK's `sessionId` option. */
  backendSessionId: string
  /** cwd captured at session creation. */
  cwd: string
  /** Model alias / id in effect for the next prompt. */
  model: string | null
  /** Reasoning effort forwarded to the SDK's `options.effort`. */
  effort: ReasoningEffort
  /** Per-session context window override. Values above DEFAULT_CONTEXT_WINDOW enable the 1M beta. */
  contextWindow?: number
  /** Status mirror used to short-circuit duplicate emits. */
  agentStatus: AgentStatus
  /** Optional label persisted to registry. */
  label?: string
  /** Optional parent session key for subagent records. */
  parentSessionKey?: string
  /** Per-session context filter instance (Layer 1). Created once per session. */
  contextFilter?: import('./context-filter.js').ContextFilter
  /** Wall-clock ms of the last successful recycle (Layer 2 rate-limiting). */
  lastRecycleAt?: number
  /** Count of Layer 2 recycles completed this process lifetime. In-memory
   *  only — intentionally not persisted, resets to 0 across a restart. */
  recycleCount?: number
  /** Abort controller for the in-flight `query()` (if any). */
  abortController?: AbortController
  /** Input-queue write side for streaming input mode. */
  pushUserMessage?: (text: string, attachments?: Buffer[]) => void
  /** Cleanup function that stops the input queue. */
  endInput?: () => void
  /** Promise that resolves when the in-flight query iteration completes. */
  iteratorDone?: Promise<void>
  /** Tracked subagent ids currently in flight (parent only). */
  liveSubagents: Set<string>
  /** Streaming bookkeeping per-session. */
  streamLastLength: number
  thinkingAccum: string
  /** All text fragments emitted by the agent during the current round.
   * Joined with `\n\n` on handleResult to form the turn's content — the
   * SDK's `msg.result` only carries the FINAL text, so intermediate
   * narration ("About to run ls /tmp") would otherwise be lost from the
   * live chat.turn even though it survives in the JSONL. */
  textAccum: string[]
  /** Aggregate usage carried forward across turns. */
  lastUsage?: ClaudeUsage
  /** Path of the session JSONL on disk (set when known). */
  sessionFile?: string
  /** Handle to the live SDK Query — used to call `setModel`/`interrupt`/`getContextUsage` mid-session. */
  liveQuery?: {
    setModel(model?: string): Promise<void>
    // SDK 0.3.220 widened the return type from `Promise<void>` to
    // `Promise<SDKControlInterruptResponse | undefined>`. We ignore the
    // response payload; `unknown` accepts both shapes without pinning to
    // internal SDK types.
    interrupt(): Promise<unknown>
    /** Mid-session settings merge. Used to switch reasoning effort live; not all
     *  values are reachable this way — `max` only takes effect at session start.
     *  Optional because the SDK build may not expose it. */
    setSettings?(settings: Record<string, unknown>): Promise<void>
    /** Replace the active MCP server registration. Called from the PostCompact
     *  hook to force a fresh `tools/list` against every server so the SDK's
     *  deferred-tool catalog doesn't go stale across compact events. */
    setMcpServers?(servers: Record<string, unknown>): Promise<unknown>
    /** Rich per-category context breakdown. Used by Layer 2 (recycle) to
     *  monitor token accumulation and decide when to trigger a prune cycle. */
    getContextUsage?(): Promise<{
      totalTokens: number
      maxTokens: number
      autoCompactThreshold?: number
      messageBreakdown?: {
        toolResultTokens: number
        toolCallTokens: number
        assistantMessageTokens: number
        userMessageTokens: number
      }
    }>
  }
}

/** Subset of SDK usage data used for context-budget reporting. */
export interface ClaudeUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  totalCostUsd?: number
}

/** Internal adapter state. */
export interface ClaudeAdapterInternal {
  connectionStatus: BackendConnectionStatus
  sessions: Map<string, ClaudeSessionState>
  /** Subagent → parent session key lookup, derived from SDK SubagentStart. */
  subagentToParent: Map<string, string>
}

/** Result of `sovereign.cron_create`-style operations. */
export interface CronCreateResult {
  id: string
  /** Human-readable description of when it'll fire. */
  schedule: string
}
