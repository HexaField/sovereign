// Claude Code AgentBackend — uses @anthropic-ai/claude-agent-sdk in-process
// to host a per-thread session per Sovereign thread. Subagents, hooks, MCP
// tools, compaction events, and history all flow through the SDK; the
// adapter translates them to Sovereign's event bus.
//
// Design intent: Sovereign owns the context surface end-to-end.
//
// - `settingSources: ['user', 'local']` — loads user-level (~/.claude/
//   settings.json: plugins, MCP servers, user hooks) and local-level
//   (.claude/settings.local.json) but DROPS the project-level source.
//   The project source is the only legitimate source of CLAUDE.md walk-up
//   per the SDK, but it also pulled in `<cwd>/.claude/settings.json` —
//   which cozempic's installer mirrors from the user file, producing
//   duplicate hook matchers (one per source) and double-firing every
//   shell command per event. Dropping `'project'` eliminates that
//   duplication at its source.
// - Global `~/.claude/CLAUDE.md` is loaded explicitly by Sovereign and
//   prepended to the membrane append below, so Hex's compiled personality
//   still reaches every session even with the project source disabled.
// - Sovereign-specific overrides retained: state-tracking hooks,
//   `sovereign` MCP server, scheduling-tool redirect, bypass-permissions
//   for trusted local execution.

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
  McpSdkServerConfigWithInstance,
  SdkBeta
} from '@anthropic-ai/claude-agent-sdk'

import type {
  AgentBackend,
  AgentBackendKind,
  BackendCapabilities,
  BackendConnectionStatus,
  ContextBudget,
  ContextManagementStatus,
  ModelCatalogEntry,
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
  normalizeClaudeCodeEntry,
  readAllClaudeCodeMessages,
  readRecentClaudeCodeMessages,
  latestUsageFromFile,
  findSessionFile
} from './history.js'
import { dispatchSdkMessage } from './events.js'
import { defaultAgentDir, projectsDirForCwd, sessionJsonlPath } from './path-encoding.js'
import { ensureAd4mSkill, ensureDefaultSubagentFile, ensureLayeredContextFile } from './personality.js'
import type { ClaudeAdapterInternal, ClaudeCodeConfig, ClaudeSessionState, ToolPolicy } from './types.js'
import { createContextFilter } from './context-filter.js'
import type { ContextFilterConfig } from './context-filter.js'
import type { DeviceInfo } from '@sovereign/core'
import type { ActiveSessions } from '../active-sessions.js'
import { parseCozempicOutput } from './cozempic-parser.js'
import {
  archiveJsonlBeforeRecycle,
  archiveRawToolOutput,
  listSessionArchives,
  readArchiveEntries
} from '../history-archive.js'

const KIND: AgentBackendKind = 'claude-code'

const DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'LS']
const PROVIDER = 'anthropic'
const DEFAULT_CONTEXT_WINDOW = 200000

/**
 * Curated Anthropic model catalog, grouped by family. Each family exposes a
 * bare "latest" alias (`opus` — resolved to the provider's current pin) plus
 * version-pinned ids (`claude-opus-4-6`) so a thread can be held on a specific
 * release. The bundled `@anthropic-ai/claude-agent-sdk` accepts both forms and
 * passes them through to the model endpoint unchanged.
 *
 * Naming caveat: the 4-series pins a minor (`claude-opus-4-6`), but the
 * 5-series drops the suffix entirely — the id is `claude-opus-5`, NOT
 * `claude-opus-5-0`. Extrapolating the 4-series pattern yields an id the API
 * rejects with "It may not exist or you may not have access to it". Every id
 * below was verified live via `claude --model <id> -p …` before being listed.
 */
interface CatalogFamily {
  family: string
  familyLabel: string
  versions: Array<{ id: string; version: string | null; versionLabel: string }>
}

const MODEL_CATALOG: CatalogFamily[] = [
  {
    family: 'opus',
    familyLabel: 'Opus',
    versions: [
      { id: 'opus', version: null, versionLabel: 'Latest' },
      { id: 'claude-opus-5', version: '5', versionLabel: '5' },
      { id: 'claude-opus-4-8', version: '4.8', versionLabel: '4.8' },
      { id: 'claude-opus-4-7', version: '4.7', versionLabel: '4.7' },
      { id: 'claude-opus-4-6', version: '4.6', versionLabel: '4.6' },
      { id: 'claude-opus-4-5', version: '4.5', versionLabel: '4.5' }
    ]
  },
  {
    family: 'sonnet',
    familyLabel: 'Sonnet',
    versions: [
      { id: 'sonnet', version: null, versionLabel: 'Latest' },
      { id: 'claude-sonnet-5', version: '5', versionLabel: '5' },
      { id: 'claude-sonnet-4-6', version: '4.6', versionLabel: '4.6' },
      { id: 'claude-sonnet-4-5', version: '4.5', versionLabel: '4.5' }
    ]
  },
  {
    family: 'haiku',
    familyLabel: 'Haiku',
    versions: [
      { id: 'haiku', version: null, versionLabel: 'Latest' },
      { id: 'claude-haiku-4-5', version: '4.5', versionLabel: '4.5' }
    ]
  },
  {
    family: 'opusplan',
    familyLabel: 'Opus Plan',
    versions: [{ id: 'opusplan', version: null, versionLabel: 'Default' }]
  }
]

/** Default model when none is configured per-session. Opus 4.6 (verified active). */
const DEFAULT_MODEL_FALLBACK = 'claude-opus-4-6'

/** Strip a leading "anthropic/" if present so callers can pass either form. */
function bareModelName(model: string): string {
  return model.startsWith(`${PROVIDER}/`) ? model.slice(PROVIDER.length + 1) : model
}

/**
 * Resolve a model id/alias to its catalog family (`opus`, `sonnet`, …) so
 * family-keyed config (e.g. `modelContextWindows.opus`) keeps applying to
 * version-pinned ids like `claude-opus-4-6`. Falls back to a prefix match for
 * ids not in the catalog.
 */
function familyForModel(model: string | null | undefined): string | null {
  if (!model) return null
  const bare = bareModelName(model)
  const inCatalog = MODEL_CATALOG.find((c) => c.versions.some((v) => v.id === bare))
  if (inCatalog) return inCatalog.family
  const m = /^claude-(opus|sonnet|haiku)/.exec(bare)
  return m ? m[1] : null
}

/**
 * Read the user's global Claude Code personality file
 * (`~/.claude/CLAUDE.md`). Sovereign's personality compiler writes here.
 * Loaded explicitly because `settingSources` drops the `'project'` source
 * that would normally trigger the SDK's CLAUDE.md walk-up. Returns empty
 * string when the file is missing or unreadable — the SDK's preset prompt
 * still works without it.
 */
function readGlobalPersonality(agentDir: string): string {
  try {
    return fs.readFileSync(path.join(agentDir, 'CLAUDE.md'), 'utf8')
  } catch {
    return ''
  }
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
      contextWindow?: number
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
      contextWindow?: number
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
  /**
   * Per-session tool denylist. Called once when a session loop starts;
   * the returned array is passed as `disallowedTools` to the SDK, which
   * removes the named tools from the model's context entirely. Sovereign
   * uses this to block the built-in `Agent` tool when a thread's subagent
   * routing directs spawning through the local-llm backend. Returning
   * `undefined` or an empty array leaves all tools available.
   */
  resolveDisallowedTools?: (sessionKey: string) => string[] | undefined
  /** Override sdkQuery for tests; defaults to the SDK's query(). */
  sdkQuery?: typeof sdkQuery
  /**
   * Pending-question registry for Claude Code's built-in `AskUserQuestion`
   * tool. When present, the PreToolUse hook holds AskUserQuestion calls open
   * until the user submits answers through Sovereign's UI, then returns the
   * answers as the tool_result. When absent, calls fall through to the SDK's
   * default (which auto-errors with "Answer questions?").
   */
  askUserQuestionStore?: import('./ask-user-question-store.js').AskUserQuestionStore
  /** Shared metrics accumulator. Optional — when absent, no metrics emitted. */
  metrics?: import('../metrics.js').MetricsAccumulator
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
  contextWindow?: number
  agentStatus: ClaudeSessionState['agentStatus']
  label?: string
  parentSessionKey?: string
  lastRecycleAt?: number
  liveSubagents: string[]
  streamLastLength: number
  thinkingAccum: string
  textAccum: string[]
  lastUsage?: ClaudeSessionState['lastUsage']
  sessionFile?: string
  compactionCount?: number
}

const SESSION_STATE_SCHEMA_VERSION = 1
const ACTIVE_KEY_SCHEMA_VERSION = 1

export function createClaudeCodeBackend(
  configOrGetter: ClaudeCodeConfig | (() => ClaudeCodeConfig),
  deps: ClaudeCodeBackendDeps = {}
): ClaudeCodeBackend {
  const getConfig = typeof configOrGetter === 'function' ? configOrGetter : () => configOrGetter
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

  // Read dataDir once at construction — it derives state-store paths that
  // cannot safely change mid-flight.
  const initConfig = getConfig()
  const dataDir = initConfig.dataDir

  /** Build the MCP server map from the latest config + deps.  Called per
   *  session creation so a refreshed AD4M token takes effect immediately. */
  function resolveMcpServers(): Record<string, any> {
    const cfg = getConfig()
    const servers: Record<string, any> = { ...cfg.mcpServers }
    // Always override — the in-process instance is the source of truth.
    // A stale or misconfigured 'sovereign' key in cfg must never shadow it.
    if (deps.sovereignMcpServer) {
      servers.sovereign = deps.sovereignMcpServer
    }
    return servers
  }

  function contextWindowFor(model: string | null | undefined): number {
    if (!model) return DEFAULT_CONTEXT_WINDOW
    const bare = bareModelName(model)
    const family = familyForModel(bare)
    const windows = getConfig().modelContextWindows ?? {}
    return windows[bare] ?? (family ? windows[family] : undefined) ?? windows[model] ?? DEFAULT_CONTEXT_WINDOW
  }
  const query = deps.sdkQuery ?? sdkQuery

  // Workspace-local seed files — best-effort, never fatal. The global
  // personality (~/.claude/CLAUDE.md) is owned by the personality compiler
  // in bootstrap; only the layered-context file and default subagent get
  // seeded here.
  try {
    const initCwd = initConfig.cwd ?? process.cwd()
    const initAgentDir = initConfig.agentDir ?? defaultAgentDir(home)
    fs.mkdirSync(initCwd, { recursive: true })
    ensureLayeredContextFile(initCwd)
    ensureDefaultSubagentFile(initCwd)
    const initMcp = resolveMcpServers()
    if (initMcp['ad4m'] && initConfig.configDir) ensureAd4mSkill(initConfig.configDir, initAgentDir)
  } catch {
    /* user may have a read-only cwd in tests */
  }

  // ── Persistence (R2, R3) ──────────────────────────────────────────────
  // Per-session state under <dataDir>/agent-backend/claude-code-state/<sessionKey>.json
  // and the global active-session-pointer.json. Both rehydrated on adapter
  // construction so a restart resumes the last known state.
  const sessionStateStore: WriteThroughStore<PersistedClaudeSessionState> = createWriteThroughStore({
    dirPath: path.join(dataDir, 'agent-backend', 'claude-code-state'),
    version: SESSION_STATE_SCHEMA_VERSION,
    debounceMs: 250,
    label: 'claude-code-state'
  })
  const activeKeyFile: WriteThroughFile<string | null> = createWriteThroughFile<string | null>({
    filePath: path.join(dataDir, 'agent-backend', 'active-session-pointer.json'),
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
      contextWindow: state.contextWindow,
      agentStatus: state.agentStatus,
      label: state.label,
      parentSessionKey: state.parentSessionKey,
      lastRecycleAt: state.lastRecycleAt,
      liveSubagents: [...state.liveSubagents],
      streamLastLength: state.streamLastLength,
      thinkingAccum: state.thinkingAccum,
      textAccum: state.textAccum,
      lastUsage: state.lastUsage,
      sessionFile: state.sessionFile,
      compactionCount: state.compactionCount
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
        contextWindow: value.contextWindow,
        // Reset any non-idle status on restart — nothing is actually running.
        // The resume orchestrator re-activates sessions that need to continue.
        agentStatus: 'idle',
        label: value.label,
        parentSessionKey: value.parentSessionKey,
        lastRecycleAt: value.lastRecycleAt,
        // Recycle count resets on restart — it gates dedup within a process.
        recycleCount: 0,
        compactionCount: value.compactionCount ?? 0,
        liveSubagents: new Set(), // cleared on restart — nothing survives the process boundary
        streamLastLength: value.streamLastLength,
        thinkingAccum: value.thinkingAccum,
        textAccum: value.textAccum,
        lastUsage: value.lastUsage,
        sessionFile: value.sessionFile
      }
      internal.sessions.set(key, state)
      indexSession(state)
      if (value.parentSessionKey) {
        internal.subagentToParent.set(value.backendSessionId, value.parentSessionKey)
        // Mark subagents that were working before the restart as abandoned —
        // they can't resume across a process boundary. Emit a system turn so
        // the parent thread's transcript shows what happened.
        if (value.agentStatus === 'working' || value.agentStatus === 'thinking') {
          console.warn(`[claude-code] subagent ${key} was ${value.agentStatus} at shutdown — marking abandoned`)
          emitter.emit('chat.turn', {
            sessionKey: value.parentSessionKey,
            turn: {
              role: 'system' as const,
              content: `⚠️ Subagent abandoned (${value.label ?? key}) — was ${value.agentStatus} when Sovereign restarted. The task did not complete.`,
              timestamp: Date.now(),
              workItems: [],
              thinkingBlocks: []
            }
          })
        }
      }
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
    contextWindow?: number
    label?: string
    parentSessionKey?: string
  }): ClaudeSessionState {
    let state = internal.sessions.get(opts.sessionKey)
    if (state) return state
    const cfg = getConfig()
    const cfgAgentDir = cfg.agentDir ?? defaultAgentDir(home)
    const cfgCwd = cfg.cwd ?? process.cwd()
    const sessionFile = sessionJsonlPath(cfgAgentDir, opts.cwd ?? cfgCwd, opts.backendSessionId)
    // Create a per-session context filter (Layer 1) when filtering enabled.
    const filterCfg = cfg.contextManagement?.filter
    const contextFilter =
      filterCfg?.enabled !== false
        ? createContextFilter(filterCfg as Partial<ContextFilterConfig> | undefined)
        : undefined

    state = {
      sessionKey: opts.sessionKey,
      backendSessionId: opts.backendSessionId,
      cwd: opts.cwd ?? cfgCwd,
      model: opts.model ?? cfg.defaultModel ?? DEFAULT_MODEL_FALLBACK,
      effort: opts.effort ?? DEFAULT_REASONING_EFFORT,
      contextWindow: opts.contextWindow,
      agentStatus: 'idle',
      label: opts.label,
      parentSessionKey: opts.parentSessionKey,
      contextFilter,
      recycleCount: 0,
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
      effort: state.effort,
      contextWindow: state.contextWindow
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
    // Track tool start times for duration measurement — keyed by tool_use_id.
    const toolStartTimes = new Map<string, number>()

    const onPreToolUse = async (input: HookInput) => {
      if (input.hook_event_name !== 'PreToolUse') return { continue: true }
      const inp = input as Extract<HookInput, { hook_event_name: 'PreToolUse' }>
      const state = stateForHook(input)

      // Record start time for metrics duration tracking
      const toolUseId = (inp as Record<string, unknown>).tool_use_id as string | undefined
      if (toolUseId) toolStartTimes.set(toolUseId, Date.now())

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

      // AskUserQuestion — hold the SDK until the user submits answers, then
      // return them as the tool result. The SDK's built-in behaviour is to
      // auto-fail this tool with `is_error:true, content:"Answer questions?"`
      // when no interactive TUI is attached; intercepting here converts it
      // into a first-class Sovereign UI interaction with the answers flowing
      // back through the same `permissionDecision: 'deny'` channel the SDK
      // already surfaces to the model.
      if (inp.tool_name === 'AskUserQuestion' && deps.askUserQuestionStore) {
        const toolCallId = (inp as { tool_use_id?: string }).tool_use_id
        const sk = state?.sessionKey
        if (toolCallId && sk) {
          const rawInput = (inp.tool_input ?? {}) as { questions?: unknown }
          const questions = Array.isArray(rawInput.questions) ? rawInput.questions : []
          if (questions.length > 0) {
            // Walk the parentSessionKey chain up to the top-level thread so
            // subagent AskUserQuestion calls surface on the parent thread the
            // user is actually looking at — the subagent's own thread view is
            // deeply nested and easy to miss. Cap the walk at 8 hops for
            // safety in case a subagent chain ever cycles.
            let anchorKey = sk
            for (let i = 0; i < 8; i++) {
              const parent = internal.sessions.get(anchorKey)?.parentSessionKey
              if (!parent) break
              anchorKey = parent
            }
            // Persist the hook-await on the liveness snapshot so a boot-time
            // resume can distinguish "working because holding a tool_result"
            // from "working because draining a queued user message" and skip
            // its Tier 3 auto-continue accordingly. Set on the anchor session
            // (which is the sessionKey the resume orchestrator will see) and
            // cleared unconditionally in `finally`. The SDK re-fires the
            // tool_use on session resume, so no rehydration of the store's
            // in-memory promise is needed — the fresh hook invocation
            // registers a new pending entry with the same tool_use_id.
            activeSessions?.setPendingToolAwait(anchorKey, {
              toolName: 'AskUserQuestion',
              toolCallId
            })
            try {
              const result = await deps.askUserQuestionStore.register(anchorKey, toolCallId, {
                questions: questions as any
              })
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: JSON.stringify(result)
                }
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: `AskUserQuestion aborted by Sovereign: ${message}`
                }
              }
            } finally {
              activeSessions?.clearPendingToolAwait(anchorKey)
            }
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
      const state = stateForHook(input)
      const inp = input as Record<string, unknown>
      const toolName = (inp.tool_name as string) ?? ''

      // Compute duration from PreToolUse timing
      const toolUseId = (inp.tool_use_id as string) ?? ''
      const startTime = toolStartTimes.get(toolUseId) ?? Date.now()
      toolStartTimes.delete(toolUseId)
      const durationMs = Date.now() - startTime

      // Measure raw I/O chars
      const inputChars = JSON.stringify(inp.tool_input ?? '').length
      const rawOutputStr = JSON.stringify(inp.tool_response ?? '')
      const rawOutputChars = rawOutputStr.length

      // Run context filter (Layer 1)
      let filtered: unknown | null = null
      if (state?.contextFilter) {
        filtered = state.contextFilter.filterToolOutput(toolName, inp.tool_response)
      }
      // Measure filter savings — works for both string and structured returns.
      // When the filter returns an object, JSON.stringify gives the comparable
      // size against the raw serialised output.
      const filteredOutputChars =
        filtered != null ? (typeof filtered === 'string' ? filtered : JSON.stringify(filtered)).length : rawOutputChars
      const trimmedChars = rawOutputChars > filteredOutputChars ? rawOutputChars - filteredOutputChars : 0

      // Record tool call metric
      if (deps.metrics && state) {
        deps.metrics.recordToolCall({
          ts: Date.now(),
          sessionKey: state.sessionKey,
          backendKind: 'claude-code',
          model: state.model ?? 'unknown',
          toolName,
          inputChars,
          outputChars: rawOutputChars,
          outputTrimmedChars: trimmedChars,
          durationMs,
          isSubagent: !!state.parentSessionKey
        })
      }

      if (filtered == null) return { continue: true }

      // Archive the raw tool output before the trimmed version replaces it.
      // The archive preserves full, unfiltered history — the SDK's JSONL
      // only ever receives the trimmed version.
      if (trimmedChars > 0 && state) {
        archiveRawToolOutput(dataDir, state.backendSessionId, {
          ts: Date.now(),
          toolName,
          toolUseId,
          rawChars: rawOutputChars,
          trimmedChars,
          raw: inp.tool_response
        })
      }

      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse' as const,
          updatedToolOutput: filtered
        }
      }
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
      // Archive the full JSONL BEFORE the SDK truncates it for compaction.
      // Without this, SDK auto-compaction destroys pre-compaction history
      // with no recovery path. Sovereign's own recycleSession() also
      // archives, but that only covers explicit recycling — this catches
      // the SDK's automatic compaction events.
      if (state.sessionFile && fs.existsSync(state.sessionFile)) {
        archiveJsonlBeforeRecycle(dataDir, state.backendSessionId, state.sessionFile)
      }
      emitter.emit('chat.compacting', { sessionKey: state.sessionKey, active: true })
      return { continue: true }
    }
    const onPostCompact = async (input: HookInput) => {
      if (input.hook_event_name !== 'PostCompact') return { continue: true }
      const state = stateForHook(input)
      if (!state) return { continue: true }
      state.compactionCount = (state.compactionCount ?? 0) + 1
      persistState(state)
      emitter.emit('chat.compacting', { sessionKey: state.sessionKey, active: false })
      // MCP rehydration: compact tears down the SDK's deferred-tool catalog
      // for any MCP server that didn't re-register itself. Forcing
      // `setMcpServers(...)` makes the SDK redo `tools/list` against
      // every configured server — recovers `mcp__sovereign__*` tools after
      // both auto-compact and manual `/compact`.
      // See plans/claude-code-mcp-rehydration-bug.md for the bug history.
      try {
        await state.liveQuery?.setMcpServers?.(resolveMcpServers())
      } catch (err) {
        // SDK builds without setMcpServers will throw or be undefined.
        // Best-effort — the next session loop start re-registers anyway.
        console.error('[claude-code] PostCompact MCP rehydration failed:', (err as Error)?.message ?? err)
      }
      // Cozempic post-compaction prune — run standard-tier strategies on the
      // JSONL to clean up pre-compaction residue (tool-use-result-strip,
      // metadata-strip, envelope-strip, etc.).  Fire-and-forget: pruning
      // happens async and does not block the model's next turn.
      if (state.sessionFile && fs.existsSync(state.sessionFile)) {
        const { execFile } = await import('node:child_process')
        const cozempicBin = process.env.COZEMPIC_BIN ?? 'cozempic'
        execFile(cozempicBin, ['treat', '--rx', 'standard', state.sessionFile], { timeout: 30_000 }, (err, stdout) => {
          if (err) {
            // Cozempic not installed or failed — log and continue.
            // Not a hard failure: the conversation functions without it.
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.warn(`[claude-code] PostCompact cozempic prune failed: ${err.message}`)
            }
          } else if (stdout.trim()) {
            console.log(`[claude-code] PostCompact cozempic: ${stdout.trim().split('\n')[0]}`)
            // Record context strategy metrics from cozempic output
            if (deps.metrics) {
              const parsed = parseCozempicOutput(stdout)
              if (parsed) {
                deps.metrics.recordContextStrategy({
                  ts: Date.now(),
                  sessionKey: state.sessionKey,
                  backendKind: 'claude-code',
                  model: state.model ?? 'unknown',
                  ...parsed
                })
              }
            }
          }
        })
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

    // Sovereign's programmatic hooks only — user settings.json hooks
    // (cozempic, plugin hooks) are fired by the CLI subprocess directly
    // via `settingSources: ['user', 'project', 'local']`. Wrapping them
    // programmatically here would double-fire (the CLI runs each shell
    // command once natively, the wrapper would run it a second time).
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
    // Per-session context. Two layers, both injected via `systemPrompt.append`:
    //   1. Global personality — `~/.claude/CLAUDE.md` (compiled by the
    //      Sovereign personality compiler). Loaded by Sovereign here because
    //      we've dropped the `'project'` setting source (see top comment),
    //      and the SDK's CLAUDE.md walk-up is gated by that source.
    //   2. Membrane prelude — per-thread CONTEXT.md resolved by the membrane
    //      manager, scoped to the thread's membrane id.
    // Both are joined and appended onto the `claude_code` preset.
    const cfgAtStart = getConfig()
    const cfgAgentDir = cfgAtStart.agentDir ?? defaultAgentDir(home)
    const globalPersonality = readGlobalPersonality(cfgAgentDir)
    const membraneAppend = deps?.resolveAppendSystemPrompt?.(state.sessionKey)
    const combinedAppend = [globalPersonality, membraneAppend].filter(Boolean).join('\n\n')
    const effectiveContextWindow = state.contextWindow ?? contextWindowFor(state.model)
    const betas: SdkBeta[] = effectiveContextWindow > DEFAULT_CONTEXT_WINDOW ? ['context-1m-2025-08-07'] : []
    const sessionMcpServers = resolveMcpServers()
    const disallowedTools = deps?.resolveDisallowedTools?.(state.sessionKey)
    const sdkOptions: SdkOptions = {
      cwd: state.cwd,
      ...(resumeExisting ? { resume: state.backendSessionId } : { sessionId: state.backendSessionId }),
      abortController: abort,
      model: state.model ?? undefined,
      effort: state.effort,
      ...(betas.length > 0 ? { betas } : {}),
      allowedTools: cfgAtStart.defaultTools ?? DEFAULT_TOOLS,
      ...(disallowedTools && disallowedTools.length > 0 ? { disallowedTools } : {}),
      mcpServers: sessionMcpServers,
      hooks: buildHooks(),
      // User + local only. Project-level settings deliberately skipped —
      // cozempic's installer mirrors user hooks into <cwd>/.claude/settings.json,
      // and loading both causes every cozempic shell command to fire twice
      // per event. With this list, the project file exists on disk (cozempic
      // keeps recreating it) but the CLI never reads it. Global CLAUDE.md
      // is loaded above via `globalPersonality` to compensate for the
      // CLAUDE.md walk-up that the `'project'` source would have provided.
      settingSources: ['user', 'local'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: false,
      ...(combinedAppend ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: combinedAppend } } : {}),
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

    // Verify sovereign MCP connected after initialization — if missing,
    // tear down and let the next sendMessage restart with fresh config.
    // 'pending' is a normal transient status right after init while the
    // in-process MCP handshake completes, so poll briefly before treating
    // it as a real failure — a single immediate sample raced the handshake
    // and tore down every session on its first message.
    const MCP_VERIFY_POLL_MS = 200
    const MCP_VERIFY_TIMEOUT_MS = 5000
    q.initializationResult()
      .then(async () => {
        const deadline = Date.now() + MCP_VERIFY_TIMEOUT_MS
        try {
          let sovereign: { status?: string } | undefined
          for (;;) {
            const statuses = await q.mcpServerStatus()
            sovereign = statuses.find((s: any) => s.name === 'sovereign')
            if (sovereign?.status === 'connected') {
              console.log(`[claude-code] sovereign MCP verified for session ${state.sessionKey}`)
              return
            }
            if (sovereign?.status !== 'pending' || Date.now() >= deadline) break
            await new Promise((resolve) => setTimeout(resolve, MCP_VERIFY_POLL_MS))
          }
          console.warn(
            `[claude-code] sovereign MCP not connected (status: ${sovereign?.status ?? 'missing'}) for session ${state.sessionKey} — tearing down for restart`
          )
          try {
            state.abortController?.abort()
          } catch {
            /* ignore */
          }
          state.pushUserMessage = undefined
          state.endInput = undefined
          state.abortController = undefined
          state.liveQuery = undefined
        } catch (err) {
          console.warn(`[claude-code] MCP status check failed for ${state.sessionKey}:`, err)
        }
      })
      .catch(() => {
        /* init not ready — best effort */
      })

    state.iteratorDone = (async () => {
      try {
        for await (const msg of q) {
          setActiveSessionKey(state.sessionKey)
          dispatchSdkMessage(msg, state, emitter)

          // Layer 2 auto-trigger: check context fill after each turn
          // completes. The SDK emits a `result` message at the end of
          // every assistant turn — this fires WITHIN the iterator loop,
          // not after it exits (the iterator stays open for the session
          // lifetime, so post-loop triggers never run during normal
          // operation). Skip subagent sessions (recycling them mid-flight
          // strands the parent — that guard also lives in
          // maybeAutoRecycle itself, this avoids the async call entirely).
          if (msg?.type === 'result' && !state.parentSessionKey) {
            maybeAutoRecycle(state).catch((err) => {
              console.warn('[context-recycle] auto-trigger error:', err)
            })
          }
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
      contextWindow?: number
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
      contextWindow: opts?.contextWindow,
      label,
      parentSessionKey: opts?.parentSessionKey
    })
    persistRegistry(state, opts?.threadKey ?? sessionKey, opts?.orgId)
    // Seed the per-cwd workspace files if this session uses a different cwd
    // than the adapter default — gives per-org workspaces their own
    // layered-context + default-subagent without touching the global
    // personality (which the compiler owns).
    if (opts?.cwd && opts.cwd !== (getConfig().cwd ?? process.cwd())) {
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
        contextWindow: existing?.contextWindow,
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
   * Load archived (pre-compaction) conversation history.
   * Reads all pre-recycle JSONL snapshots for a session, merges them,
   * deduplicates against the current live history by timestamp, and
   * returns only turns that predate the live history.
   */
  async function getArchivedHistory(sessionKey: string): Promise<{ turns: ParsedTurn[]; archiveCount: number }> {
    const sk = bareId(sessionKey)
    const state = internal.sessions.get(sk)
    const backendId = state?.backendSessionId ?? sk

    // Primary lookup: archives filed under the current backendSessionId.
    let archives = listSessionArchives(dataDir, backendId)

    // Secondary: the registry may hold a different backendSessionId (e.g.
    // after machine migration or SDK session rotation). Check that too.
    if (archives.length === 0) {
      const existing = deps.registry?.lookupSession?.(sk)
      if (existing?.backendSessionId && existing.backendSessionId !== backendId) {
        archives = listSessionArchives(dataDir, existing.backendSessionId)
      }
    }

    if (archives.length === 0) return { turns: [], archiveCount: 0 }

    // Get the oldest timestamp from live history — archived turns before
    // this cutoff represent pre-compaction content.
    const liveResult = await getHistory(sessionKey)
    const oldestLiveTs = liveResult.turns.reduce(
      (min, t) => (t.timestamp && t.timestamp < min ? t.timestamp : min),
      Infinity
    )

    // Read all archives, normalize + parse each, collect turns
    const allTurns: ParsedTurn[] = []
    const seenTimestamps = new Set<number>()

    for (const archive of archives) {
      const entries = readArchiveEntries(archive.path)
      const normalized: any[] = []
      for (const entry of entries) {
        const msg = normalizeClaudeCodeEntry(entry)
        if (msg) normalized.push(msg)
      }
      const parsed = parseClaudeCodeTurns(normalized)
      for (const turn of parsed) {
        // Skip turns that exist in the live history (overlap zone)
        if (turn.timestamp >= oldestLiveTs) continue
        // Deduplicate across archives (same turn may appear in multiple snapshots)
        if (turn.timestamp && seenTimestamps.has(turn.timestamp)) continue
        if (turn.timestamp) seenTimestamps.add(turn.timestamp)
        allTurns.push(turn)
      }
    }

    // Sort chronologically
    allTurns.sort((a, b) => a.timestamp - b.timestamp)
    return { turns: allTurns, archiveCount: archives.length }
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
    const cfgAgentDir = getConfig().agentDir ?? defaultAgentDir(home)
    const candidate = path.join(
      projectsDirForCwd(cfgAgentDir, sessionCwd),
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
      const cfgAgentDir = getConfig().agentDir ?? defaultAgentDir(home)
      const topLevel = findSessionFile(projectsDirForCwd(cfgAgentDir, state.cwd), state.backendSessionId)
      if (topLevel) return topLevel
    }
    // Cold-resume path: no in-memory state yet (post-restart, history fetched
    // before any sendMessage). Fall back to the persisted registry record.
    const existing = deps.registry?.lookupSession?.(sessionKey)
    if (existing?.backendSessionFile) return existing.backendSessionFile
    if (existing?.backendSessionId) {
      const cfgAgentDir = getConfig().agentDir ?? defaultAgentDir(home)
      const sessionCwd = existing.cwd ?? getConfig().cwd ?? process.cwd()
      const topLevel = findSessionFile(projectsDirForCwd(cfgAgentDir, sessionCwd), existing.backendSessionId)
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
    // `totalTokens` = tokens currently filling the context window (what the
    // UI divides by `contextTokens` for the usage bar). For Anthropic that's
    // input + cache_read + cache_creation on the LAST API CALL (the full
    // prompt size for that call). Output tokens leave the window after the
    // turn and are exposed separately.
    //
    // IMPORTANT: `state.lastUsage` contains the SDK's ACCUMULATED usage
    // across all API calls in one agentic turn (tool-use loop). A turn with
    // 50 tool calls accumulates ~50× the actual context fill. We must read
    // the last API call's usage from the JSONL instead.
    let filled = 0
    let inputTokens = 0
    let outputTokens = 0
    if (state.sessionFile && fs.existsSync(state.sessionFile)) {
      const latest = latestUsageFromFile(state.sessionFile)
      inputTokens = latest.inputTokens
      filled = latest.inputTokens + latest.cacheRead + latest.cacheWrite
      outputTokens = latest.outputTokens
    } else if (state.lastUsage) {
      // No JSONL yet (session just created) — fall back to SDK usage.
      inputTokens = state.lastUsage.inputTokens ?? 0
      filled =
        inputTokens + (state.lastUsage.cacheReadInputTokens ?? 0) + (state.lastUsage.cacheCreationInputTokens ?? 0)
      outputTokens = state.lastUsage.outputTokens ?? 0
    }
    return {
      sessionKey,
      model: state.model,
      modelProvider: PROVIDER,
      contextTokens: state.contextWindow ?? contextWindowFor(state.model),
      totalTokens: filled,
      inputTokens,
      outputTokens,
      compactionCount: state.compactionCount ?? 0,
      thinkingLevel: null,
      reasoningEffort: state.effort,
      task: null,
      label: state.label ?? null,
      parentKey: state.parentSessionKey ?? null,
      backendSessionId: state.backendSessionId ?? null,
      backendSessionFile: state.sessionFile ?? null,
      lastRecycleAt: state.lastRecycleAt ?? null,
      backendKind: KIND
    }
  }

  /** Layer 1 + Layer 2 context-management telemetry for one session. Feeds
   *  the Sovereign UI's Service Health "Context Management" row. */
  async function getContextManagementStatus(sessionKey: string): Promise<ContextManagementStatus | null> {
    const state = internal.sessions.get(sessionKey)
    if (!state) return null
    return {
      filter: state.contextFilter?.stats() ?? null,
      recycleCount: state.recycleCount ?? 0,
      lastRecycleAt: state.lastRecycleAt ?? null
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
    const catalog: ModelCatalogEntry[] = MODEL_CATALOG.flatMap((c) =>
      c.versions.map((v) => ({
        id: `${PROVIDER}/${v.id}`,
        provider: PROVIDER,
        family: c.family,
        familyLabel: c.familyLabel,
        version: v.version,
        versionLabel: v.versionLabel
      }))
    )
    return {
      models: catalog.map((e) => e.id),
      defaultModel: (() => {
        const model = getConfig().defaultModel ?? DEFAULT_MODEL_FALLBACK
        return `${PROVIDER}/${bareModelName(model)}`
      })(),
      catalog
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

  async function setSessionContextWindow(sessionKey: string, contextWindow: number | undefined) {
    const state = internal.sessions.get(sessionKey)
    if (!state) return
    state.contextWindow = contextWindow
    const existing = deps.registry?.lookupSession?.(sessionKey)
    if (existing) {
      const threadKey = sessionKey.startsWith('agent:main:thread:')
        ? sessionKey.slice('agent:main:thread:'.length)
        : sessionKey
      persistRegistry(state, threadKey, existing.orgId)
    }
    persistState(state)
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
      // Fallback to the LAST turn's usage from the JSONL (not cumulative sum).
      const fromFile = latestUsageFromFile(state.sessionFile)
      usage = {
        inputTokens: fromFile.inputTokens,
        outputTokens: fromFile.outputTokens,
        cacheReadInputTokens: fromFile.cacheRead,
        cacheCreationInputTokens: fromFile.cacheWrite,
        totalCostUsd: fromFile.costUsd
      }
    }
    if (!usage) return null
    // Context fill = input + cacheRead + cacheCreate (matches getSessionMeta
    // and maybeAutoRecycle — single source of truth).
    const filled = (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
    return {
      source: 'sovereign',
      generatedAt: Date.now(),
      provider: 'anthropic',
      model: state.model ?? undefined,
      workspaceDir: state.cwd,
      systemPrompt: { chars: 0 },
      session: { contextTokens: filled },
      fileContents: undefined,
      disabledTools: [],
      disabledSkills: [],
      tools: { listChars: 0, schemaChars: 0, entries: [] },
      skills: { promptChars: 0, entries: [] }
    } as ContextBudget
  }

  // ── Layer 2: Auto-Trigger ──────────────────────────────────────────
  //
  // Called after each normal turn completion. Compares the session's
  // current context fill against the configured threshold and triggers
  // a recycle when the fill exceeds it.

  async function maybeAutoRecycle(state: ClaudeSessionState): Promise<void> {
    const recycleCfg = getConfig().contextManagement?.recycle
    if (recycleCfg?.enabled === false) return
    // Skip subagent sessions — recycling them mid-flight strands the parent.
    if (state.parentSessionKey) return

    // Use the session's actual context window (set per-thread), falling back
    // to the model's default. Most Claude sessions use 200K, not 1M — using
    // the real value makes the threshold meaningful.
    const maxTokens = state.contextWindow ?? contextWindowFor(state.model)
    if (maxTokens <= 0) return

    // Adaptive threshold: the configured percentage (default 45%) applies to
    // whichever context window the session uses. At 200K this triggers at
    // ~90K tokens; at 1M at ~450K — both realistic production fill levels.
    const threshold = recycleCfg?.thresholdPercent ?? 45

    // Read actual context fill from the LAST API call in the JSONL.
    // `state.lastUsage` contains the SDK's accumulated turn total (all API
    // calls in one agentic loop), which inflates by N× for N tool uses.
    let filled = 0
    if (state.sessionFile && fs.existsSync(state.sessionFile)) {
      const latest = latestUsageFromFile(state.sessionFile)
      filled = latest.inputTokens + latest.cacheRead + latest.cacheWrite
    } else if (state.lastUsage) {
      filled =
        (state.lastUsage.inputTokens ?? 0) +
        (state.lastUsage.cacheReadInputTokens ?? 0) +
        (state.lastUsage.cacheCreationInputTokens ?? 0)
    }
    if (filled <= 0) return
    const fillPercent = (filled / maxTokens) * 100

    // Record context snapshot after every turn (regardless of recycle decision)
    if (deps.metrics) {
      deps.metrics.recordContextSnapshot({
        ts: Date.now(),
        sessionKey: state.sessionKey,
        backendKind: 'claude-code',
        model: state.model ?? 'unknown',
        totalTokens: filled,
        contextWindow: maxTokens,
        fillPercent
      })
    }

    if (fillPercent < threshold) return

    console.log(
      `[context-recycle] auto-trigger: ${fillPercent.toFixed(1)}% of ${maxTokens} tokens filled ` +
        `(threshold: ${threshold}%), recycling session ${state.sessionKey}`
    )

    const result = await recycleSession(state.sessionKey, { metricsMethod: 'auto-recycle' })
    if (result) {
      console.log(
        `[context-recycle] auto-recycle complete: ` + `${result.reclaimedBytes} bytes reclaimed (${result.method})`
      )
    }
  }

  // ── Layer 2: Session Recycle ───────────────────────────────────────
  //
  // Interrupt the live Query, prune the JSONL transcript, then resume
  // with the smaller file. The session continues with less context.

  async function recycleSession(
    sessionKey: string,
    opts?: { force?: boolean; metricsMethod?: 'recycle' | 'auto-recycle' }
  ): Promise<{
    preTokens: number
    postTokens: number
    reclaimedTokens: number
    reclaimedBytes: number
    method: 'cozempic' | 'native'
  } | null> {
    const state = internal.sessions.get(sessionKey)
    if (!state) return null
    if (!state.sessionFile) return null

    // The SDK binary may still flush the JSONL after handleResult fires
    // setIdle. Retry briefly before bailing — the file usually appears
    // within a few hundred milliseconds of the idle signal.
    if (!fs.existsSync(state.sessionFile)) {
      let found = false
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, 500))
        if (fs.existsSync(state.sessionFile!)) {
          found = true
          break
        }
      }
      if (!found) return null
    }

    const recycleCfg = getConfig().contextManagement?.recycle
    if (recycleCfg?.enabled === false) return null

    // Rate-limit: skip if recycled recently (bypass with force flag
    // for scheduled cleanup sweeps that must prune regardless).
    if (!opts?.force) {
      const minInterval = recycleCfg?.minIntervalMs ?? 300_000
      if (state.lastRecycleAt && Date.now() - state.lastRecycleAt < minInterval) return null
    }

    // Skip when subagents run (interrupting the parent strands them).
    if (recycleCfg?.skipDuringSubagents !== false && state.liveSubagents.size > 0) return null

    // 1. Measure pre-recycle size.
    //    Use the LAST turn's usage (not cumulative sum) — that represents the
    //    actual context fill the model saw on its most recent response.
    const preBytes = fs.statSync(state.sessionFile).size
    const preUsage = latestUsageFromFile(state.sessionFile)
    const preTokens = preUsage.inputTokens + preUsage.cacheRead + preUsage.cacheWrite

    // 2. Interrupt the live query if one exists (graceful — session stays
    //    resumable). Idle sessions (no liveQuery) skip straight to pruning.
    if (state.liveQuery) {
      emitter.emit('chat.status', { sessionKey, status: 'idle' })
      try {
        await state.liveQuery.interrupt()
      } catch {
        // Fall through — hard abort as fallback.
        try {
          state.abortController?.abort()
        } catch {
          /* ignore */
        }
      }

      // 3. Wait for the iterator to complete (the for-await-of loop in
      //    startSessionLoop exits cleanly after interrupt). Cap at 10s so
      //    a stuck iterator never blocks the cleanup endpoint indefinitely.
      if (state.iteratorDone) {
        try {
          await Promise.race([
            state.iteratorDone,
            new Promise((_, reject) => setTimeout(() => reject(new Error('iterator-timeout')), 10_000))
          ])
        } catch {
          // Timed out or errored — force-abort and move on.
          try {
            state.abortController?.abort()
          } catch {
            /* ignore */
          }
        }
      }

      // 4. Reset pump bindings so startSessionLoop can re-create them.
      state.pushUserMessage = undefined
      state.endInput = undefined
      state.abortController = undefined
      state.liveQuery = undefined
    }

    // 4b. Archive the full JSONL BEFORE any pruning modifies it.
    //     The archive preserves the complete, unmodified conversation
    //     history as a write-once snapshot. Pruning only affects the
    //     working JSONL that the SDK reads for context.
    archiveJsonlBeforeRecycle(dataDir, state.backendSessionId, state.sessionFile)

    // 5. Prune the JSONL — try cozempic subprocess, fall back to native.
    let method: 'cozempic' | 'native' = 'native'
    const rx = recycleCfg?.prescription ?? 'standard'

    try {
      const { execFileSync } = await import('node:child_process')
      const cozStdout = execFileSync('cozempic', ['treat', state.backendSessionId, '-rx', rx, '--execute'], {
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8'
      })
      method = 'cozempic'

      // Record context strategy metrics from cozempic output
      if (deps.metrics && cozStdout) {
        const parsed = parseCozempicOutput(cozStdout)
        if (parsed) {
          deps.metrics.recordContextStrategy({
            ts: Date.now(),
            sessionKey,
            backendKind: 'claude-code',
            model: state.model ?? 'unknown',
            ...parsed
          })
        }
      }
    } catch {
      // Cozempic unavailable or failed — native fallback: truncate old
      // tool_result blocks in the JSONL directly.
      try {
        nativePruneJsonl(state.sessionFile)
      } catch (e) {
        console.warn('[context-recycle] native prune failed:', e)
      }
    }

    // 6. Measure post-recycle size.
    //    Usage entries in the JSONL still record pre-prune API values (pruning
    //    truncates tool_result content, not usage fields). Estimate post-prune
    //    tokens proportionally from the byte reduction.
    const postBytes = fs.existsSync(state.sessionFile) ? fs.statSync(state.sessionFile).size : 0
    const postTokens = preBytes > 0 ? Math.round(preTokens * (postBytes / preBytes)) : 0

    // 7. Reset filter dedup state and stamp the recycle time.
    state.contextFilter?.reset()
    state.lastRecycleAt = Date.now()
    state.recycleCount = (state.recycleCount ?? 0) + 1
    state.lastUsage = undefined

    // 8. Resume the session — the next sendMessage triggers
    //    startSessionLoop which sees the existing sessionFile and
    //    passes `resume: backendSessionId` to the SDK.
    persistState(state)

    const result = {
      preTokens,
      postTokens,
      reclaimedTokens: preTokens - postTokens,
      reclaimedBytes: preBytes - postBytes,
      method
    }

    // Record compaction metric
    if (deps.metrics) {
      deps.metrics.recordCompaction({
        ts: Date.now(),
        sessionKey,
        backendKind: 'claude-code',
        model: state.model ?? 'unknown',
        preTokens,
        postTokens,
        tokensReclaimed: preTokens - postTokens,
        method: opts?.metricsMethod ?? 'recycle',
        isSubagent: !!state.parentSessionKey
      })
    }

    emitter.emit('chat.status', { sessionKey, status: 'idle' })
    return result
  }

  /**
   * Native JSONL pruner — strips large tool_result content blocks from old
   * entries. Operates line-by-line; replaces tool_result text content over
   * 1KB with a short stub. Used as a fallback when cozempic isn't available.
   */
  function nativePruneJsonl(filePath: string): void {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n')
    const totalLines = lines.length
    // Keep the last 30% of entries untouched (recent context).
    const pruneUpTo = Math.floor(totalLines * 0.7)
    let changed = false

    for (let i = 0; i < pruneUpTo; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (pruneEntryToolResults(entry)) {
          lines[i] = JSON.stringify(entry)
          changed = true
        }
      } catch {
        // Not valid JSON — skip.
      }
    }

    if (changed) {
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
    }
  }

  /** Mutates a JSONL entry: replaces large tool_result text with stubs.
   *  Returns true if any replacement happened. */
  function pruneEntryToolResults(entry: Record<string, unknown>): boolean {
    let changed = false
    const content = entry.content
    if (!Array.isArray(content)) return false
    for (let i = 0; i < content.length; i++) {
      const block = content[i]
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_result') continue
      const inner = b.content
      if (typeof inner === 'string' && inner.length > 1024) {
        b.content = `[pruned — ${inner.length} chars removed by context recycle]`
        changed = true
      } else if (Array.isArray(inner)) {
        for (let j = 0; j < inner.length; j++) {
          const tb = inner[j]
          if (typeof tb === 'object' && tb !== null && (tb as Record<string, unknown>).type === 'text') {
            const text = (tb as Record<string, string>).text
            if (typeof text === 'string' && text.length > 1024) {
              ;(tb as Record<string, string>).text = `[pruned — ${text.length} chars removed by context recycle]`
              changed = true
            }
          }
        }
      }
    }
    return changed
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
    getArchivedHistory,
    on: emitter.on,
    off: emitter.off,
    capabilities,
    listSessions,
    listSubagents,
    getSessionMeta,
    getContextManagementStatus,
    setSessionModel,
    listAvailableModels,
    setSessionEffort,
    setSessionContextWindow,
    listAvailableEfforts,
    getContextBudget,
    recycleSession,
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
