// Claude Code AgentBackend — uses @anthropic-ai/claude-agent-sdk in-process
// to host a per-thread session per Sovereign thread. Subagents, hooks, MCP
// tools, compaction events, and history all flow through the SDK; the
// adapter translates them to Sovereign's event bus.

import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type {
  Options as SdkOptions,
  Query as SdkQuery,
  SDKUserMessage,
  HookEvent,
  HookInput,
  HookCallbackMatcher,
  McpSdkServerConfigWithInstance
} from '@anthropic-ai/claude-agent-sdk'

import type {
  AgentBackend,
  AgentBackendKind,
  BackendCapabilities,
  BackendConnectionStatus,
  ContextBudget,
  ParsedTurn,
  ReasoningEffort,
  SessionKind,
  SessionMeta,
  SessionSummary,
  SpawnSubagentOptions,
  SubagentSummary,
  WorkItem
} from '@sovereign/core'
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS } from '@sovereign/core'

import { createBackendEmitter, createWriteThroughFile, createWriteThroughStore } from '@sovereign/primitives'
import type { WriteThroughFile, WriteThroughStore } from '@sovereign/primitives'
import {
  parseClaudeCodeTurns,
  readAllClaudeCodeMessages,
  readRecentClaudeCodeMessages,
  computeUsageFromFile,
  findSessionFile
} from './history.js'
import { dispatchSdkMessage } from './events.js'
import { defaultAgentDir, projectsDirForCwd, sessionJsonlPath } from './path-encoding.js'
import { ensureDefaultSubagentFile, ensureLayeredContextFile } from './personality.js'
import type { ClaudeAdapterInternal, ClaudeCodeConfig, ClaudeSessionState, ToolPolicy } from './types.js'
import type { DeviceInfo } from '@sovereign/core'
import type { ActiveSessions } from '../active-sessions.js'

const KIND: AgentBackendKind = 'claude-code'

const DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'LS']
const DEFAULT_MODEL_FALLBACK = 'opus'
const KNOWN_MODELS = ['opus', 'sonnet', 'haiku', 'opusplan']
const PROVIDER = 'anthropic'
const DEFAULT_CONTEXT_WINDOW = 200000

/** Strip a leading "anthropic/" if present so callers can pass either form. */
function bareModelName(model: string): string {
  return model.startsWith(`${PROVIDER}/`) ? model.slice(PROVIDER.length + 1) : model
}

const SUBAGENT_SESSION_PREFIX = 'agent:main:subagent:'
const THREAD_SESSION_PREFIX = 'agent:main:thread:'

/**
 * Coerce any session/thread reference to its bare id. Bare-UUID scheme:
 * threads are keyed by Thread.id (UUID), subagents by the SDK
 * backendSessionId. Legacy `agent:main:thread:<x>` / `agent:main:subagent:<x>`
 * / `agent:main:main` compound forms are stripped so lingering legacy callers
 * — and pre-migration on-disk data read before the one-shot migration runs —
 * still resolve.
 */
function bareId(value: string): string {
  if (!value) return value
  if (value.startsWith(THREAD_SESSION_PREFIX)) return value.slice(THREAD_SESSION_PREFIX.length)
  if (value.startsWith(SUBAGENT_SESSION_PREFIX)) return value.slice(SUBAGENT_SESSION_PREFIX.length)
  if (value === 'agent:main:main') return 'main'
  return value
}

// SDK built-in scheduling tools. These depend on `claude daemon` which we
// deliberately do not run — their schedules would never fire and would
// bypass Sovereign's message queue (no audit trail, no UI visibility).
// PreToolUse denies them with a redirect to the Sovereign equivalent.
// See plans/claude-code-wakeup-bridge-spec.md (revision 3).
const WAKEUP_TOOLS = new Set(['ScheduleWakeup', 'CronCreate', 'CronList', 'CronDelete'])
// MCP-exposed tool names (the SDK prefixes user-registered MCP tools with
// `mcp__<server-name>__`; see mcp-server.ts where the server is named
// 'sovereign'). Spell the FULL exposed name in the redirect so the agent
// doesn't have to guess the namespace convention.
const WAKEUP_REDIRECT: Record<string, string> = {
  ScheduleWakeup: 'mcp__sovereign__cron_create with schedule={kind:"oneshot", at:"<future ISO>"}',
  CronCreate: 'mcp__sovereign__cron_create',
  CronList: 'mcp__sovereign__cron_list',
  CronDelete: 'mcp__sovereign__cron_delete'
}

export interface ClaudeCodeBackend extends AgentBackend {
  /** Inject the canonical session key for the active in-flight request, used by MCP `agents_spawn`. */
  setActiveSession(sessionKey: string | undefined): void
  /** Return the canonical session key currently driving the active SDK iteration (if any). */
  getActiveSessionKey(): string | undefined
  /** Synchronously flush all file-backed state. Called on shutdown (R5). */
  flushState(): void
}

export interface ClaudeCodeBackendDeps {
  /** Sovereign-native MCP server registered into every session. Optional for tests. */
  sovereignMcpServer?: McpSdkServerConfigWithInstance
  /** Registry callbacks used to persist + look up sessions/subagents. Optional for tests. */
  registry?: {
    upsertSession(record: {
      sessionKey: string
      backendSessionId: string
      threadKey: string
      backendSessionFile?: string
      label?: string
      parentSessionKey?: string
      orgId?: string
      cwd?: string
      model?: string
      effort?: ReasoningEffort
    }): void
    /**
     * Look up a previously-persisted session by canonical key. Used on lazy
     * resume so a sendMessage to an unknown in-memory key picks up the
     * backendSessionId from disk instead of generating a fresh UUID.
     */
    lookupSession?(sessionKey: string): {
      backendSessionId: string
      backendSessionFile?: string
      label?: string
      parentSessionKey?: string
      orgId?: string
      cwd?: string
      model?: string
      effort?: ReasoningEffort
    } | null
  }
  /**
   * Per-session/per-org PreToolUse policy. Defaults to permit-all when omitted.
   * Returning `{ decision: 'deny', reason }` blocks the tool call and surfaces
   * `reason` to the agent as the tool_result.
   */
  toolPolicy?: ToolPolicy
  /**
   * Canonical liveness index across backends. The adapter writes to it on
   * every status transition + subagent hook so a restart can resume (R3).
   * Optional for tests.
   */
  activeSessions?: ActiveSessions
  /**
   * Per-session system-prompt append. Called once when a session loop
   * starts; the returned text is layered on top of Claude Code's preset
   * system prompt (which already covers the global `~/.claude/CLAUDE.md`).
   * Sovereign uses this to inject membrane-scoped context — see
   * `@sovereign/membranes`. Returning `undefined` leaves the SDK call
   * untouched (no `systemPrompt` override). Safe to omit.
   */
  resolveAppendSystemPrompt?: (sessionKey: string) => string | undefined
  /** Override sdkQuery for tests; defaults to the SDK's query(). */
  sdkQuery?: typeof sdkQuery
}

/** Persisted slice of `ClaudeSessionState` — everything serialisable. Live OS
 * handles (`liveQuery`, `abortController`, `pushUserMessage`, `endInput`,
 * `iteratorDone`) are re-created by `startSessionLoop` on demand and are
 * never written to disk. Per R2. */
interface PersistedClaudeSessionState {
  backendSessionId: string
  cwd: string
  model: string | null
  effort?: ReasoningEffort
  agentStatus: ClaudeSessionState['agentStatus']
  label?: string
  parentSessionKey?: string
  liveSubagents: string[]
  streamLastLength: number
  thinkingAccum: string
  textAccum: string[]
  lastUsage?: ClaudeSessionState['lastUsage']
  sessionFile?: string
}

const SESSION_STATE_SCHEMA_VERSION = 1
const ACTIVE_KEY_SCHEMA_VERSION = 1

export function createClaudeCodeBackend(config: ClaudeCodeConfig, deps: ClaudeCodeBackendDeps = {}): ClaudeCodeBackend {
  const emitter = createBackendEmitter(KIND)
  const internal: ClaudeAdapterInternal = {
    connectionStatus: 'disconnected',
    sessions: new Map(),
    subagentToParent: new Map()
  }

  // Reverse index from the SDK's session_id (backendSessionId) to our session
  // state. Every SDK hook input carries `session_id` — using this map to
  // resolve the owning session is race-free, unlike the legacy `activeSessionKey`
  // global which gets overwritten by every concurrent iterator iteration. Two
  // sessions running concurrently (e.g. cron-driven thread fires while you're
  // chatting in another) would otherwise see hook emissions cross-attributed.
  const sessionsByBackendId = new Map<string, ClaudeSessionState>()
  function indexSession(state: ClaudeSessionState): void {
    sessionsByBackendId.set(state.backendSessionId, state)
  }

  const home = process.env.HOME ?? ''
  const agentDir = config.agentDir ?? defaultAgentDir(home)
  const cwd = config.cwd ?? process.cwd()
  const defaultTools = config.defaultTools ?? DEFAULT_TOOLS
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL_FALLBACK
  const modelContextWindows = config.modelContextWindows ?? {}

  function contextWindowFor(model: string | null | undefined): number {
    if (!model) return DEFAULT_CONTEXT_WINDOW
    const bare = bareModelName(model)
    return modelContextWindows[bare] ?? modelContextWindows[model] ?? DEFAULT_CONTEXT_WINDOW
  }
  const query = deps.sdkQuery ?? sdkQuery
  const mcpServers: Record<string, any> = { ...config.mcpServers }
  // Three layers of preference, highest first:
  //   1. Whatever the caller already wired in `config.mcpServers.sovereign`.
  //   2. `SOVEREIGN_MCP_HTTP_URL` — the standalone sidecar daemon. Has its own
  //      lifecycle (com.sovereign.mcp.plist) so a Sovereign rebuild doesn't
  //      tear it down; SDK reconnects automatically.
  //   3. The in-process `McpSdkServerConfigWithInstance` injection — fallback
  //      when no sidecar is configured. Bound to this process's lifetime.
  if (!mcpServers['sovereign']) {
    const sidecarUrl = process.env.SOVEREIGN_MCP_HTTP_URL?.trim()
    if (sidecarUrl) {
      mcpServers.sovereign = { type: 'http', url: sidecarUrl }
    } else if (deps.sovereignMcpServer) {
      mcpServers.sovereign = deps.sovereignMcpServer
    }
  }

  // Workspace-local seed files — best-effort, never fatal. The global
  // personality (~/.claude/CLAUDE.md) is owned by the personality compiler
  // in bootstrap; only the layered-context file and default subagent get
  // seeded here.
  try {
    fs.mkdirSync(cwd, { recursive: true })
    ensureLayeredContextFile(cwd)
    ensureDefaultSubagentFile(cwd)
  } catch {
    /* user may have a read-only cwd in tests */
  }

  // ── Persistence (R2, R3) ──────────────────────────────────────────────
  // Per-session state under <dataDir>/agent-backend/claude-code-state/<sessionKey>.json
  // and the global active-session-pointer.json. Both rehydrated on adapter
  // construction so a restart resumes the last known state.
  const sessionStateStore: WriteThroughStore<PersistedClaudeSessionState> = createWriteThroughStore({
    dirPath: path.join(config.dataDir, 'agent-backend', 'claude-code-state'),
    version: SESSION_STATE_SCHEMA_VERSION,
    debounceMs: 250,
    label: 'claude-code-state'
  })
  const activeKeyFile: WriteThroughFile<string | null> = createWriteThroughFile<string | null>({
    filePath: path.join(config.dataDir, 'agent-backend', 'active-session-pointer.json'),
    version: ACTIVE_KEY_SCHEMA_VERSION,
    defaultValue: null,
    debounceMs: 0, // pointer changes are always synchronous (R5)
    label: 'active-session-pointer'
  })

  // ⚠️ `activeSessionKey` is the "last session whose iterator delivered a
  // message" pointer, used **only** as a hint for the MCP layer (which has no
  // session_id in its callback context). It is NOT safe for hook attribution
  // — concurrent sessions stomp on each other. Every SDK hook reads
  // `input.session_id` via `stateForHook` instead.
  let activeSessionKey: string | undefined = activeKeyFile.read() ?? undefined

  function setActiveSessionKey(key: string | undefined): void {
    if (activeSessionKey === key) return
    activeSessionKey = key
    activeKeyFile.writeSync(key ?? null)
  }

  function persistState(state: ClaudeSessionState): void {
    sessionStateStore.set(state.sessionKey, {
      backendSessionId: state.backendSessionId,
      cwd: state.cwd,
      model: state.model,
      effort: state.effort,
      agentStatus: state.agentStatus,
      label: state.label,
      parentSessionKey: state.parentSessionKey,
      liveSubagents: [...state.liveSubagents],
      streamLastLength: state.streamLastLength,
      thinkingAccum: state.thinkingAccum,
      textAccum: state.textAccum,
      lastUsage: state.lastUsage,
      sessionFile: state.sessionFile
    })
  }

  function rehydrate(): void {
    for (const { key, value } of sessionStateStore.entries()) {
      const state: ClaudeSessionState = {
        sessionKey: key,
        backendSessionId: value.backendSessionId,
        cwd: value.cwd,
        model: value.model,
        effort: value.effort ?? DEFAULT_REASONING_EFFORT,
        agentStatus: value.agentStatus,
        label: value.label,
        parentSessionKey: value.parentSessionKey,
        liveSubagents: new Set(value.liveSubagents),
        streamLastLength: value.streamLastLength,
        thinkingAccum: value.thinkingAccum,
        textAccum: value.textAccum,
        lastUsage: value.lastUsage,
        sessionFile: value.sessionFile
      }
      internal.sessions.set(key, state)
      indexSession(state)
      if (value.parentSessionKey) internal.subagentToParent.set(value.backendSessionId, value.parentSessionKey)
    }
  }
  rehydrate()

  // Active-sessions index — written through on every status transition + subagent hook (R8).
  const activeSessions = deps.activeSessions

  function lookupThreadKey(sessionKey: string): string | undefined {
    return deps.registry?.lookupSession?.(sessionKey) ? sessionKey : undefined
  }

  /** Mark a session as active in the liveness index. Idempotent. */
  function markActive(state: ClaudeSessionState, reason: string): void {
    if (!activeSessions) return
    const reg = deps.registry?.lookupSession?.(state.sessionKey) ?? null
    const threadKey = reg && 'threadKey' in (reg as object) ? (reg as { threadKey?: string }).threadKey : undefined
    // Bare-UUID scheme: the sessionKey already IS the thread id. Prefer the
    // registry's threadKey when present, else fall back to the (bare) key.
    const inferredThreadKey = threadKey ?? bareId(state.sessionKey)
    const status: 'working' | 'thinking' = state.agentStatus === 'thinking' ? 'thinking' : 'working'
    let lastJsonlSize: number | undefined
    if (state.sessionFile) {
      try {
        lastJsonlSize = fs.statSync(state.sessionFile).size
      } catch {
        /* file not yet created */
      }
    }
    activeSessions.upsert({
      sessionKey: state.sessionKey,
      threadKey: inferredThreadKey,
      backendKind: KIND,
      backendSessionId: state.backendSessionId,
      backendSessionFile: state.sessionFile,
      cwd: state.cwd,
      orgId: reg?.orgId,
      agentStatus: status,
      lastTransitionAt: Date.now(),
      lastTransitionReason: reason,
      lastJsonlSize
    })
  }

  /** Drop a session from the liveness index. Idempotent. */
  function markIdle(state: ClaudeSessionState): void {
    activeSessions?.remove(state.sessionKey)
  }

  // Reference suppression — kept for future use when chat module needs to
  // resolve thread keys from session keys directly.
  void lookupThreadKey

  // Internal subscription: every emission that changes durable state is
  // mirrored to disk so a restart resumes from the last transition (R1–R3).
  emitter.on('chat.status', (data) => {
    const state = internal.sessions.get(data.sessionKey)
    if (!state) return
    if (data.status === 'idle') markIdle(state)
    else markActive(state, `status:${data.status}`)
    persistState(state)
  })
  emitter.on('chat.work', (data) => {
    const state = internal.sessions.get(data.sessionKey)
    if (!state) return
    persistState(state)
    if (!activeSessions) return
    let lastJsonlSize: number | undefined
    if (state.sessionFile) {
      try {
        lastJsonlSize = fs.statSync(state.sessionFile).size
      } catch {
        /* missing */
      }
    }
    activeSessions.bumpActivity(state.sessionKey, {
      lastJsonlSize,
      lastAssistantMessageAt: Date.now()
    })
  })
  emitter.on('chat.turn', (data) => {
    const state = internal.sessions.get(data.sessionKey)
    if (state) persistState(state)
  })
  emitter.on('subagent.spawned', (data) => {
    if (!data.parentKey) return
    const backendId = bareId(data.childKey)
    activeSessions?.addSubagent(data.parentKey, {
      agentId: backendId,
      label: data.label,
      startedAt: Date.now()
    })
  })
  emitter.on('subagent.completed', (data) => {
    if (!data.parentKey) return
    const backendId = bareId(data.childKey)
    activeSessions?.removeSubagent(data.parentKey, backendId)
  })

  function setStatus(status: BackendConnectionStatus, reason?: string) {
    internal.connectionStatus = status
    emitter.emit('backend.status', { status, reason })
  }

  // Bare-UUID identity scheme: a session's canonical key IS its bare id.
  // Thread sessions are keyed by the Thread.id (UUID); subagents by their
  // SDK-assigned backendSessionId; an unbound session falls back to its own
  // backend id.
  function canonicalSessionKey(opts: { kind?: SessionKind; threadKey?: string; backendSessionId: string }): string {
    if (opts.kind === 'subagent') return opts.backendSessionId
    if (opts.threadKey) return bareId(opts.threadKey)
    return opts.backendSessionId
  }

  function ensureSessionState(opts: {
    sessionKey: string
    backendSessionId: string
    cwd?: string
    model?: string
    effort?: ReasoningEffort
    label?: string
    parentSessionKey?: string
  }): ClaudeSessionState {
    let state = internal.sessions.get(opts.sessionKey)
    if (state) return state
    const sessionFile = sessionJsonlPath(agentDir, opts.cwd ?? cwd, opts.backendSessionId)
    state = {
      sessionKey: opts.sessionKey,
      backendSessionId: opts.backendSessionId,
      cwd: opts.cwd ?? cwd,
      model: opts.model ?? defaultModel,
      effort: opts.effort ?? DEFAULT_REASONING_EFFORT,
      agentStatus: 'idle',
      label: opts.label,
      parentSessionKey: opts.parentSessionKey,
      liveSubagents: new Set(),
      streamLastLength: 0,
      thinkingAccum: '',
      textAccum: [],
      sessionFile
    }
    internal.sessions.set(opts.sessionKey, state)
    indexSession(state)
    return state
  }

  function persistRegistry(state: ClaudeSessionState, threadKey: string, orgId?: string) {
    deps.registry?.upsertSession({
      sessionKey: state.sessionKey,
      backendSessionId: state.backendSessionId,
      threadKey,
      backendSessionFile: state.sessionFile,
      label: state.label,
      parentSessionKey: state.parentSessionKey,
      orgId,
      cwd: state.cwd,
      model: state.model ?? undefined,
      effort: state.effort
    })
  }

  function lookupSessionOrgId(sessionKey: string): string | undefined {
    const existing = deps.registry?.lookupSession?.(sessionKey)
    return existing?.orgId
  }

  /** Resolve the session that owns a hook firing. Every `HookInput` carries
   * `session_id` (the SDK's backend UUID) — using this map is race-free,
   * unlike reading the legacy `activeSessionKey` global which gets stomped
   * by every concurrent iterator iteration. */
  function stateForHook(input: HookInput): ClaudeSessionState | undefined {
    const sid = (input as { session_id?: string }).session_id
    if (!sid) return undefined
    return sessionsByBackendId.get(sid)
  }

  function buildHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const onSessionStart = async (input: HookInput) => {
      if (input.hook_event_name !== 'SessionStart') return { continue: true }
      const state = stateForHook(input)
      if (state) emitter.emit('chat.status', { sessionKey: state.sessionKey, status: 'idle' })
      return { continue: true }
    }
    const onUserPromptSubmit = async (_input: HookInput) => {
      // Acknowledge — no-op. Logged elsewhere via chat.message.sent on the bus.
      return { continue: true }
    }
    const onPreToolUse = async (input: HookInput) => {
      if (input.hook_event_name !== 'PreToolUse') return { continue: true }
      const inp = input as Extract<HookInput, { hook_event_name: 'PreToolUse' }>
      const state = stateForHook(input)

      // Redirect SDK built-in scheduling tools to Sovereign equivalents.
      // Runs before the toolPolicy check so the redirect applies regardless
      // of per-org allowlists and even when no session/policy is bound.
      // Includes the current session's threadKey in the reason so the agent
      // doesn't have to guess it (mcp__sovereign__cron_create requires it).
      if (WAKEUP_TOOLS.has(inp.tool_name)) {
        const target = WAKEUP_REDIRECT[inp.tool_name]
        const sk = state?.sessionKey ?? ''
        const threadKeyHint = sk ? ` Pass threadKey="${sk}" so the wakeup fires back into THIS thread.` : ''
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason:
              `This Sovereign-managed session does not support ${inp.tool_name}. ` +
              `Use ${target} instead — it schedules through Sovereign's own ` +
              `scheduler which fires the prompt back into this thread via the ` +
              `standard message queue (observable, cancellable, durable).${threadKeyHint}`
          }
        }
      }

      const policy = deps.toolPolicy
      if (!state || !policy) return { continue: true }
      const orgId = lookupSessionOrgId(state.sessionKey)
      const decision = await policy({
        sessionKey: state.sessionKey,
        toolName: inp.tool_name,
        toolInput: inp.tool_input,
        orgId
      })
      if (decision.decision === 'deny') {
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: decision.reason
          }
        }
      }
      if (decision.decision === 'ask') {
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'ask' as const,
            permissionDecisionReason: decision.reason
          }
        }
      }
      return { continue: true }
    }
    // PostToolUse fires AFTER a successful tool execution. We DELIBERATELY
    // do NOT emit chat.work tool_result here — the SDK echoes the same
    // tool result a few ms later as a user-role message with a
    // `tool_result` content block, which `handleSdkUserMessage` surfaces
    // through `events.ts` with a clean, image-aware output via
    // `contentToOutputStr`. Emitting from both paths produced the
    // visible 2× duplication seen in production live state (every
    // tool_call ended up with two tool_results: one JSON-wrapped from
    // this hook, one plain-text from the user-role echo). The user-role
    // echo wins because its output formatting is what the UI's tool
    // detail views are built around.
    //
    // We keep the hook registered as a no-op return so future audits
    // (or per-org PostToolUse instrumentation) have a stable wiring
    // point.
    const onPostToolUse = async (input: HookInput) => {
      if (input.hook_event_name !== 'PostToolUse') return { continue: true }
      return { continue: true }
    }
    // PostToolUseFailure DOES still emit — the SDK does not always echo a
    // user-role tool_result for failed tools, so the failure hook is the
    // safety net. If the SDK ever starts double-echoing failures we'll
    // see them in the live state and add dedup here.
    const onPostToolUseFailure = async (input: HookInput) => {
      if (input.hook_event_name !== 'PostToolUseFailure') return { continue: true }
      const state = stateForHook(input)
      if (!state) return { continue: true }
      const inp = input as any
      emitter.emit('chat.work', {
        sessionKey: state.sessionKey,
        work: {
          type: 'tool_result',
          name: inp.tool_name,
          output: `Error: ${inp.error ?? inp.tool_response ?? 'tool failed'}`,
          toolCallId: inp.tool_use_id,
          timestamp: Date.now()
        } as WorkItem
      })
      return { continue: true }
    }
    const onSubagentStart = async (input: HookInput) => {
      if (input.hook_event_name !== 'SubagentStart') return { continue: true }
      // SubagentStart's `input.session_id` is the parent's session id (the SDK
      // fires the hook from the parent's context). The new subagent's id is on
      // `inp.agent_id`.
      const parent = stateForHook(input)
      if (!parent) return { continue: true }
      const parentKey = parent.sessionKey
      const inp = input as Extract<HookInput, { hook_event_name: 'SubagentStart' }>
      // Bare-UUID scheme: a subagent's canonical key is its SDK agent id.
      const childKey = inp.agent_id
      internal.subagentToParent.set(inp.agent_id, parentKey)
      const child = ensureSessionState({
        sessionKey: childKey,
        backendSessionId: inp.agent_id,
        parentSessionKey: parentKey,
        label: inp.agent_type
      })
      // Mark the child as working — `listSessions` returns this status verbatim,
      // and `/api/threads/active-subagents` filters on it. Without this flip,
      // every live subagent shows up as 'idle' and gets filtered out.
      child.agentStatus = 'working'
      deps.registry?.upsertSession({
        sessionKey: childKey,
        backendSessionId: inp.agent_id,
        threadKey: childKey,
        parentSessionKey: parentKey,
        label: inp.agent_type
      })
      parent.liveSubagents.add(inp.agent_id)
      // Persist BOTH parent (its liveSubagents Set just changed) and child
      // (its status just flipped). Without this, the next restart loses the
      // tracking even though the records exist on disk.
      persistState(parent)
      persistState(child)
      emitter.emit('subagent.spawned', {
        parentKey,
        childKey,
        task: inp.agent_type,
        label: inp.agent_type
      })
      return { continue: true }
    }
    const onSubagentStop = async (input: HookInput) => {
      if (input.hook_event_name !== 'SubagentStop') return { continue: true }
      const inp = input as Extract<HookInput, { hook_event_name: 'SubagentStop' }>
      // Prefer the recorded parent (set by SubagentStart) — that's authoritative
      // even after this adapter restarts. Fall back to the hook's own
      // session_id, which the SDK fires from the parent's context.
      const parentKey = internal.subagentToParent.get(inp.agent_id) ?? stateForHook(input)?.sessionKey
      if (!parentKey) return { continue: true }
      const childKey = inp.agent_id
      const parent = internal.sessions.get(parentKey)
      parent?.liveSubagents.delete(inp.agent_id)
      const child = internal.sessions.get(childKey)
      if (child) child.agentStatus = 'idle'
      if (parent) persistState(parent)
      if (child) persistState(child)
      emitter.emit('subagent.completed', {
        parentKey,
        childKey,
        result: inp.last_assistant_message ?? ''
      })
      internal.subagentToParent.delete(inp.agent_id)
      return { continue: true }
    }
    const onPreCompact = async (input: HookInput) => {
      if (input.hook_event_name !== 'PreCompact') return { continue: true }
      const state = stateForHook(input)
      if (!state) return { continue: true }
      emitter.emit('chat.compacting', { sessionKey: state.sessionKey, active: true })
      return { continue: true }
    }
    const onPostCompact = async (input: HookInput) => {
      if (input.hook_event_name !== 'PostCompact') return { continue: true }
      const state = stateForHook(input)
      if (!state) return { continue: true }
      emitter.emit('chat.compacting', { sessionKey: state.sessionKey, active: false })
      // MCP rehydration: compact tears down the SDK's deferred-tool catalog
      // for any MCP server that didn't re-register itself. Forcing
      // `setMcpServers(mcpServers)` makes the SDK redo `tools/list` against
      // every configured server — recovers `mcp__sovereign__*` tools after
      // both auto-compact and manual `/compact`.
      // See plans/claude-code-mcp-rehydration-bug.md for the bug history.
      try {
        await state.liveQuery?.setMcpServers?.(mcpServers)
      } catch (err) {
        // SDK builds without setMcpServers will throw or be undefined.
        // Best-effort — the next session loop start re-registers anyway.
        console.error('[claude-code] PostCompact MCP rehydration failed:', (err as Error)?.message ?? err)
      }
      return { continue: true }
    }
    const onStop = async (input: HookInput) => {
      if (input.hook_event_name !== 'Stop') return { continue: true }
      const state = stateForHook(input)
      if (!state) return { continue: true }
      if (state.agentStatus !== 'idle') {
        state.agentStatus = 'idle'
        emitter.emit('chat.status', { sessionKey: state.sessionKey, status: 'idle' })
      }
      return { continue: true }
    }
    const onNotification = async (_input: HookInput) => ({ continue: true })
    const onSessionEnd = async (input: HookInput) => {
      if (input.hook_event_name !== 'SessionEnd') return { continue: true }
      const state = stateForHook(input)
      if (state) emitter.emit('chat.status', { sessionKey: state.sessionKey, status: 'idle' })
      return { continue: true }
    }

    return {
      SessionStart: [{ hooks: [onSessionStart] }],
      UserPromptSubmit: [{ hooks: [onUserPromptSubmit] }],
      PreToolUse: [{ hooks: [onPreToolUse] }],
      PostToolUse: [{ hooks: [onPostToolUse] }],
      PostToolUseFailure: [{ hooks: [onPostToolUseFailure] }],
      SubagentStart: [{ hooks: [onSubagentStart] }],
      SubagentStop: [{ hooks: [onSubagentStop] }],
      PreCompact: [{ hooks: [onPreCompact] }],
      PostCompact: [{ hooks: [onPostCompact] }],
      Stop: [{ hooks: [onStop] }],
      SessionEnd: [{ hooks: [onSessionEnd] }],
      Notification: [{ hooks: [onNotification] }]
    }
  }

  // ── streaming-input message pump ──────────────────────────────────────
  // A single long-running `query()` per session enables `interrupt()` and
  // `setModel()`. We feed user messages into the input async-iterable as
  // they arrive.
  interface InputPump {
    push(text: string, attachments?: Buffer[]): void
    end(): void
    iterable: AsyncIterable<SDKUserMessage>
  }

  function makeInputPump(sessionId: string): InputPump {
    const queue: Array<SDKUserMessage | null> = []
    const waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = []

    function next(): Promise<IteratorResult<SDKUserMessage>> {
      if (queue.length > 0) {
        const head = queue.shift()!
        if (head === null) return Promise.resolve({ value: undefined as any, done: true })
        return Promise.resolve({ value: head, done: false })
      }
      return new Promise((resolve) => waiters.push(resolve))
    }

    function deliver(msg: SDKUserMessage | null) {
      if (waiters.length > 0) {
        const waiter = waiters.shift()!
        if (msg === null) waiter({ value: undefined as any, done: true })
        else waiter({ value: msg, done: false })
        return
      }
      queue.push(msg)
    }

    const iterable: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next,
          return: async () => ({ value: undefined as any, done: true })
        }
      }
    }

    return {
      push(text, attachments) {
        const content: any =
          attachments && attachments.length > 0
            ? [
                { type: 'text', text },
                ...attachments.map((buf) => ({
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') }
                }))
              ]
            : text
        deliver({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          session_id: sessionId
        } as SDKUserMessage)
      },
      end() {
        deliver(null)
      },
      iterable
    }
  }

  function startSessionLoop(state: ClaudeSessionState): InputPump {
    const pump = makeInputPump(state.backendSessionId)
    const abort = new AbortController()
    state.abortController = abort

    const resumeExisting = state.sessionFile && fs.existsSync(state.sessionFile)
    // Per-session membrane context (CONTEXT.md for the membrane this
    // session's thread belongs to). Layered on top of Claude Code's
    // preset prompt via `systemPrompt.append` — preserves the default
    // ~/.claude/CLAUDE.md loading; only ADDS the membrane prelude.
    const membraneAppend = deps?.resolveAppendSystemPrompt?.(state.sessionKey)
    const sdkOptions: SdkOptions = {
      cwd: state.cwd,
      ...(resumeExisting ? { resume: state.backendSessionId } : { sessionId: state.backendSessionId }),
      abortController: abort,
      model: state.model ?? undefined,
      effort: state.effort,
      allowedTools: defaultTools,
      mcpServers,
      hooks: buildHooks(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: false,
      ...(membraneAppend ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: membraneAppend } } : {}),
      stderr: (line: string) => console.error(`[claude-code cli] ${line}`)
    } as SdkOptions

    let q: SdkQuery
    try {
      q = query({ prompt: pump.iterable, options: sdkOptions })
    } catch (err: any) {
      emitter.emit('chat.error', { sessionKey: state.sessionKey, error: err?.message ?? String(err) })
      return pump
    }

    state.pushUserMessage = (text, attachments) => pump.push(text, attachments)
    state.endInput = () => pump.end()
    state.liveQuery = q

    state.iteratorDone = (async () => {
      try {
        for await (const msg of q) {
          setActiveSessionKey(state.sessionKey)
          dispatchSdkMessage(msg, state, emitter)
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          emitter.emit('chat.error', { sessionKey: state.sessionKey, error: err?.message ?? String(err) })
        }
      } finally {
        // Reset pump bindings so the next sendMessage starts a fresh query loop
        // — without this the iterator's exit leaves stale handles around and
        // subsequent sends silently dead-letter into a defunct pump.
        state.pushUserMessage = undefined
        state.endInput = undefined
        state.abortController = undefined
        state.liveQuery = undefined
        state.agentStatus = 'idle'
        emitter.emit('chat.status', { sessionKey: state.sessionKey, status: 'idle' })
      }
    })()

    return pump
  }

  function getOrStartSession(state: ClaudeSessionState): void {
    if (state.pushUserMessage) return
    startSessionLoop(state)
  }

  // ── AgentBackend methods ──────────────────────────────────────────────

  async function connect() {
    setStatus('connected')
  }

  async function disconnect() {
    for (const state of internal.sessions.values()) {
      try {
        state.abortController?.abort()
      } catch {
        /* ignore */
      }
      state.endInput?.()
    }
    setStatus('disconnected')
  }

  function status(): BackendConnectionStatus {
    return internal.connectionStatus
  }

  async function createSession(
    label?: string,
    opts?: {
      threadKey?: string
      cwd?: string
      kind?: SessionKind
      parentSessionKey?: string
      model?: { provider: string; model: string }
      reasoningEffort?: ReasoningEffort
      orgId?: string
    }
  ) {
    const backendSessionId = randomUUID()
    const sessionKey = canonicalSessionKey({
      kind: opts?.kind,
      threadKey: opts?.threadKey,
      backendSessionId
    })
    const state = ensureSessionState({
      sessionKey,
      backendSessionId,
      cwd: opts?.cwd,
      model: opts?.model?.model,
      effort: opts?.reasoningEffort,
      label,
      parentSessionKey: opts?.parentSessionKey
    })
    persistRegistry(state, opts?.threadKey ?? sessionKey, opts?.orgId)
    // Seed the per-cwd workspace files if this session uses a different cwd
    // than the adapter default — gives per-org workspaces their own
    // layered-context + default-subagent without touching the global
    // personality (which the compiler owns).
    if (opts?.cwd && opts.cwd !== cwd) {
      try {
        ensureLayeredContextFile(opts.cwd)
        ensureDefaultSubagentFile(opts.cwd)
      } catch {
        /* read-only cwd in tests */
      }
    }
    emitter.emit('session.info', { sessionKey, label, history: [] })
    return sessionKey
  }

  async function sendMessage(sessionKey: string, text: string, attachments?: Buffer[]) {
    let state = internal.sessions.get(sessionKey)
    if (!state) {
      // Registry-driven resume: if Sovereign already persisted this key,
      // pick up the original backendSessionId so the SDK resumes the same
      // session instead of starting a fresh one. Also rehydrate the model
      // preference so model switches survive restarts.
      const existing = deps.registry?.lookupSession?.(sessionKey)
      const backendSessionId = existing?.backendSessionId ?? randomUUID()
      state = ensureSessionState({
        sessionKey,
        backendSessionId,
        cwd: existing?.cwd,
        model: existing?.model,
        effort: existing?.effort,
        label: existing?.label,
        parentSessionKey: existing?.parentSessionKey
      })
      // If we just minted a fresh UUID for an unbound thread, persist the
      // binding immediately so cold restart + history endpoints can find
      // the session JSONL without needing to call sendMessage first.
      if (!existing) {
        persistRegistry(state, bareId(sessionKey))
      }
    }
    getOrStartSession(state)
    setActiveSessionKey(sessionKey)
    state.streamLastLength = 0
    state.thinkingAccum = ''
    state.agentStatus = 'working'
    emitter.emit('chat.status', { sessionKey, status: 'working' })
    persistState(state)
    state.pushUserMessage?.(text, attachments)
  }

  async function abort(sessionKey: string) {
    const state = internal.sessions.get(sessionKey)
    if (!state) return
    // Prefer the SDK's in-band interrupt — it lets the session keep running
    // and just stops the current turn. Fall back to AbortController which
    // tears the whole session down.
    if (state.liveQuery) {
      try {
        await state.liveQuery.interrupt()
        return
      } catch {
        /* fall through to hard abort */
      }
    }
    try {
      state.abortController?.abort()
    } catch {
      /* ignore */
    }
    state.endInput?.()
    state.pushUserMessage = undefined
    state.endInput = undefined
    state.abortController = undefined
    state.liveQuery = undefined
    state.agentStatus = 'idle'
    emitter.emit('chat.status', { sessionKey, status: 'idle' })
  }

  async function switchSession(sessionKey: string) {
    setActiveSessionKey(sessionKey)
  }

  async function getHistory(sessionKey: string): Promise<{ turns: ParsedTurn[]; hasMore: boolean }> {
    const filePath = sessionFilePath(sessionKey)
    if (!filePath || !fs.existsSync(filePath)) return { turns: [], hasMore: false }
    const { messages, hasMore } = readRecentClaudeCodeMessages(filePath, 2000)
    return { turns: parseClaudeCodeTurns(messages), hasMore }
  }

  async function getFullHistory(sessionKey: string): Promise<ParsedTurn[]> {
    const filePath = sessionFilePath(sessionKey)
    if (!filePath || !fs.existsSync(filePath)) return []
    const messages = readAllClaudeCodeMessages(filePath)
    return parseClaudeCodeTurns(messages)
  }

  /**
   * Resolve the on-disk JSONL for a subagent. The SDK writes subagent files
   * at a nested layout under the parent's session dir:
   *
   *   <projectsDir>/<parent_session_id>/subagents/agent-<agent_id>.jsonl
   *
   * Returns null when the file or the parent linkage isn't available. Called
   * from `sessionFilePath` only when the top-level lookup misses.
   */
  function findSubagentSessionFile(
    childBackendSessionId: string,
    parentBackendSessionId: string,
    sessionCwd: string
  ): string | null {
    const candidate = path.join(
      projectsDirForCwd(agentDir, sessionCwd),
      parentBackendSessionId,
      'subagents',
      `agent-${childBackendSessionId}.jsonl`
    )
    return fs.existsSync(candidate) ? candidate : null
  }

  function sessionFilePath(sessionKey: string): string | null {
    const state = internal.sessions.get(sessionKey)
    // For subagents we must NOT trust `state.sessionFile` — `ensureSessionState`
    // pre-stamps it with the top-level path (`<projectsDir>/<id>.jsonl`), but
    // the SDK actually writes subagent JSONLs nested under the parent. Probe
    // the nested layout first when we have a parent linkage.
    if (state?.parentSessionKey && state?.backendSessionId) {
      const parent = internal.sessions.get(state.parentSessionKey)
      if (parent?.backendSessionId) {
        const nested = findSubagentSessionFile(state.backendSessionId, parent.backendSessionId, parent.cwd ?? state.cwd)
        if (nested) return nested
      }
    }
    // For non-subagent sessions the pre-stamped path is authoritative even
    // before the SDK has written the JSONL — callers (tests, history routes)
    // rely on this to compute where to write or where the file will be.
    if (state?.sessionFile) return state.sessionFile
    if (state?.backendSessionId) {
      const topLevel = findSessionFile(projectsDirForCwd(agentDir, state.cwd), state.backendSessionId)
      if (topLevel) return topLevel
    }
    // Cold-resume path: no in-memory state yet (post-restart, history fetched
    // before any sendMessage). Fall back to the persisted registry record.
    const existing = deps.registry?.lookupSession?.(sessionKey)
    if (existing?.backendSessionFile) return existing.backendSessionFile
    if (existing?.backendSessionId) {
      const sessionCwd = existing.cwd ?? cwd
      const topLevel = findSessionFile(projectsDirForCwd(agentDir, sessionCwd), existing.backendSessionId)
      if (topLevel) return topLevel
      // Cold-resume subagent fallback — look up the parent in the registry
      // and probe the same nested layout.
      if (existing.parentSessionKey) {
        const parentRec = deps.registry?.lookupSession?.(existing.parentSessionKey)
        if (parentRec?.backendSessionId) {
          const nested = findSubagentSessionFile(
            existing.backendSessionId,
            parentRec.backendSessionId,
            parentRec.cwd ?? sessionCwd
          )
          if (nested) return nested
        }
      }
    }
    return null
  }

  function capabilities(): BackendCapabilities {
    return {
      subagents: 'native',
      cron: 'sovereign-managed',
      steering: false,
      followUp: false,
      compaction: 'automatic-only',
      toolStreaming: true,
      deviceIdentity: false,
      multiProvider: false
    }
  }

  async function listSessions(filter?: { kind?: SessionKind; parentKey?: string }): Promise<SessionSummary[]> {
    const out: SessionSummary[] = []
    for (const state of internal.sessions.values()) {
      // Bare-UUID scheme: the key no longer encodes kind. A session with a
      // recorded parent is a subagent; everything else is a thread.
      const kind: SessionKind = state.parentSessionKey ? 'subagent' : 'thread'
      if (filter?.kind && filter.kind !== kind) continue
      if (filter?.parentKey && state.parentSessionKey !== filter.parentKey) continue
      let lastActivity = 0
      if (state.sessionFile) {
        try {
          lastActivity = fs.statSync(state.sessionFile).mtimeMs
        } catch {
          /* JSONL not yet written */
        }
      }
      if (!lastActivity) {
        const active = activeSessions?.get(state.sessionKey)
        lastActivity = active?.lastAssistantMessageAt ?? active?.lastTransitionAt ?? Date.now()
      }
      out.push({
        key: state.sessionKey,
        backendSessionId: state.backendSessionId,
        kind,
        label: state.label,
        lastActivity,
        agentStatus: state.agentStatus,
        parentKey: state.parentSessionKey
      })
    }
    return out
  }

  /** sessionKey → ms timestamp of the JSONL's last write. Falls back to
   * `lastUsage`-bearing turns and finally session-state writes so a session
   * with no JSONL yet still reports *something* fresh. */
  async function getActivityMap(): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    for (const state of internal.sessions.values()) {
      let ts = 0
      if (state.sessionFile) {
        try {
          ts = fs.statSync(state.sessionFile).mtimeMs
        } catch {
          /* JSONL not yet written */
        }
      }
      if (!ts) {
        // No JSONL? Fall back to the active-sessions snapshot for live work.
        const active = activeSessions?.get(state.sessionKey)
        ts = active?.lastAssistantMessageAt ?? active?.lastTransitionAt ?? 0
      }
      if (!ts) continue
      map.set(state.sessionKey, ts)
      // Also index by thread key shape so callers don't have to translate.
      if (state.sessionKey === 'agent:main:main') {
        map.set('main', ts)
      } else if (state.sessionKey.startsWith('agent:main:thread:')) {
        map.set(state.sessionKey.slice('agent:main:thread:'.length), ts)
      }
    }
    return map
  }

  async function listSubagents(parentKey?: string): Promise<SubagentSummary[]> {
    const out: SubagentSummary[] = []
    for (const state of internal.sessions.values()) {
      if (!state.parentSessionKey) continue
      if (parentKey && state.parentSessionKey !== parentKey) continue
      let lastActivity = 0
      if (state.sessionFile) {
        try {
          lastActivity = fs.statSync(state.sessionFile).mtimeMs
        } catch {
          /* JSONL not yet written — fall through to active-sessions snapshot */
        }
      }
      if (!lastActivity) {
        const active = activeSessions?.get(state.sessionKey)
        lastActivity = active?.lastAssistantMessageAt ?? active?.lastTransitionAt ?? Date.now()
      }
      out.push({
        sessionKey: state.sessionKey,
        label: state.label ?? state.backendSessionId.slice(0, 8),
        status: state.agentStatus,
        lastActivity
      })
    }
    return out
  }

  async function getSessionMeta(sessionKey: string): Promise<SessionMeta | null> {
    const state = internal.sessions.get(sessionKey)
    if (!state) return null
    // `totalTokens` here means "tokens currently filling the context window"
    // — what the UI divides by `contextTokens` for the usage bar. For
    // Anthropic that's input + cache_read + cache_creation on the latest
    // turn (the full prompt size). Output tokens are not in-window after
    // the turn completes and are exposed separately via `outputTokens`.
    const inputTokens = state.lastUsage?.inputTokens ?? 0
    const cacheRead = state.lastUsage?.cacheReadInputTokens ?? 0
    const cacheCreate = state.lastUsage?.cacheCreationInputTokens ?? 0
    const filled = inputTokens + cacheRead + cacheCreate
    return {
      sessionKey,
      model: state.model,
      modelProvider: PROVIDER,
      contextTokens: contextWindowFor(state.model),
      totalTokens: filled,
      inputTokens,
      outputTokens: state.lastUsage?.outputTokens ?? 0,
      compactionCount: 0,
      thinkingLevel: null,
      reasoningEffort: state.effort,
      task: null,
      label: state.label ?? null,
      parentKey: state.parentSessionKey ?? null
    }
  }

  async function setSessionModel(sessionKey: string, provider: string, model: string) {
    // Accept empty provider as a shortcut for "anthropic" so the UI can pass
    // bare aliases when callers haven't reconciled the prefix yet.
    const effectiveProvider = provider || PROVIDER
    if (effectiveProvider !== PROVIDER) {
      throw new Error(`claude-code: only ${PROVIDER} provider is supported (got ${provider})`)
    }
    const state = internal.sessions.get(sessionKey)
    if (!state) return
    state.model = bareModelName(model)
    // Persist so the choice survives a Sovereign restart.
    const existing = deps.registry?.lookupSession?.(sessionKey)
    if (existing) {
      const threadKey = sessionKey.startsWith('agent:main:thread:')
        ? sessionKey.slice('agent:main:thread:'.length)
        : sessionKey
      persistRegistry(state, threadKey, existing.orgId)
    }
    // If the session has a live query, switch the running session to the new
    // model immediately so the next user turn uses it without requiring a
    // session restart.
    if (state.liveQuery) {
      try {
        await state.liveQuery.setModel(state.model ?? undefined)
      } catch {
        /* SDK may not support setModel in this build; the change still takes
           effect when a new session loop starts. */
      }
    }
  }

  async function listAvailableModels() {
    // Return `provider/model` form to match the rest of Sovereign (routes
    // that split on '/'). The UI's `selectedModel` derived from
    // `getSessionMeta` (`${modelProvider}/${model}`) only lines up with the
    // dropdown options when these are prefixed too — otherwise the current
    // model never appears as the selected option.
    return {
      models: KNOWN_MODELS.map((m) => `${PROVIDER}/${m}`),
      defaultModel: defaultModel ? `${PROVIDER}/${bareModelName(defaultModel)}` : null
    }
  }

  async function setSessionEffort(sessionKey: string, effort: ReasoningEffort) {
    if (!REASONING_EFFORTS.includes(effort)) {
      throw new Error(`claude-code: unknown reasoning effort "${effort}"`)
    }
    const state = internal.sessions.get(sessionKey)
    if (!state) return
    state.effort = effort
    // Persist so the choice survives a Sovereign restart.
    const existing = deps.registry?.lookupSession?.(sessionKey)
    if (existing) {
      const threadKey = sessionKey.startsWith('agent:main:thread:')
        ? sessionKey.slice('agent:main:thread:'.length)
        : sessionKey
      persistRegistry(state, threadKey, existing.orgId)
    }
    persistState(state)
    // Best-effort mid-session apply. The SDK only honours `low|medium|high|xhigh`
    // via setSettings — `max` takes effect on the next session loop.
    if (state.liveQuery?.setSettings && effort !== 'max') {
      try {
        await state.liveQuery.setSettings({ effortLevel: effort })
      } catch {
        /* SDK may not expose setSettings in this build; the change still
           takes effect when a new session loop starts. */
      }
    }
  }

  async function listAvailableEfforts() {
    return {
      efforts: [...REASONING_EFFORTS] as ReasoningEffort[],
      defaultEffort: DEFAULT_REASONING_EFFORT
    }
  }

  async function getContextBudget(sessionKey: string): Promise<ContextBudget | null> {
    const state = internal.sessions.get(sessionKey)
    if (!state) return null
    let usage = state.lastUsage
    if (!usage && state.sessionFile && fs.existsSync(state.sessionFile)) {
      const fromFile = computeUsageFromFile(state.sessionFile)
      usage = {
        inputTokens: fromFile.inputTokens,
        outputTokens: fromFile.outputTokens,
        cacheReadInputTokens: fromFile.cacheRead,
        cacheCreationInputTokens: fromFile.cacheWrite,
        totalCostUsd: fromFile.costUsd
      }
    }
    if (!usage) return null
    const inputTokens = usage.inputTokens ?? 0
    return {
      source: 'sovereign',
      generatedAt: Date.now(),
      provider: 'anthropic',
      model: state.model ?? undefined,
      workspaceDir: state.cwd,
      systemPrompt: { chars: 0 },
      session: { contextTokens: inputTokens },
      fileContents: undefined,
      disabledTools: [],
      disabledSkills: [],
      tools: { listChars: 0, schemaChars: 0, entries: [] },
      skills: { promptChars: 0, entries: [] }
    } as ContextBudget
  }

  async function spawnSubagent(parentSessionKey: string, opts: SpawnSubagentOptions): Promise<string> {
    // The SDK's native Task tool is the canonical path. To synthesize a
    // Sovereign-tracked spawn we send a user-message into the parent
    // session asking for a Task; the SubagentStart hook will register the
    // child and emit `subagent.spawned`. Returns a placeholder child key
    // that the caller can match against the emitted event.
    const state = internal.sessions.get(parentSessionKey)
    if (!state) throw new Error(`claude-code: parent session ${parentSessionKey} unknown`)
    getOrStartSession(state)
    setActiveSessionKey(parentSessionKey)
    const text = `Use the Task tool to spawn a subagent.\n\nTask: ${opts.task}\n${opts.label ? `Label: ${opts.label}\n` : ''}`
    state.pushUserMessage?.(text)
    // We don't know the agent_id yet — the hook will register on SubagentStart.
    return `${SUBAGENT_SESSION_PREFIX}<pending>`
  }

  function getSessionFilePath(sessionKey: string): string | null {
    return sessionFilePath(sessionKey)
  }

  function getDeviceInfo(): DeviceInfo {
    return {
      backendKind: KIND,
      deviceId: 'local',
      connectionStatus: internal.connectionStatus
    }
  }

  // Helper used by `path` join above for sessionFilePath fallback.
  void path

  const backend: ClaudeCodeBackend = {
    kind: KIND,
    connect,
    disconnect,
    status,
    sendMessage,
    abort,
    switchSession,
    createSession,
    getHistory,
    getFullHistory,
    on: emitter.on,
    off: emitter.off,
    capabilities,
    listSessions,
    listSubagents,
    getSessionMeta,
    setSessionModel,
    listAvailableModels,
    setSessionEffort,
    listAvailableEfforts,
    getContextBudget,
    spawnSubagent,
    getSessionFilePath,
    getActivityMap,
    getDeviceInfo,
    setActiveSession(sessionKey) {
      setActiveSessionKey(sessionKey)
    },
    getActiveSessionKey() {
      return activeSessionKey
    },
    flushState() {
      sessionStateStore.flush()
      activeKeyFile.flush()
    }
  }

  return backend
}
