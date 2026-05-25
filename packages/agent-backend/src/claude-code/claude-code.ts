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
  SessionKind,
  SessionMeta,
  SessionSummary,
  SpawnSubagentOptions,
  SubagentSummary,
  WorkItem
} from '@sovereign/core'

import { createBackendEmitter } from '@sovereign/primitives'
import {
  parseClaudeCodeTurns,
  readAllClaudeCodeMessages,
  readRecentClaudeCodeMessages,
  computeUsageFromFile,
  findSessionFile
} from './history.js'
import { dispatchSdkMessage } from './events.js'
import { defaultAgentDir, projectsDirForCwd, sessionJsonlPath } from './path-encoding.js'
import { ensureDefaultSubagentFile, ensureLayeredContextFile, ensurePersonalityFile } from './personality.js'
import type { ClaudeAdapterInternal, ClaudeCodeConfig, ClaudeSessionState, ToolPolicy } from './types.js'
import type { DeviceInfo } from '@sovereign/core'

const KIND: AgentBackendKind = 'claude-code'

const DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'LS']
const DEFAULT_MODEL_FALLBACK = 'opus'
const KNOWN_MODELS = ['opus', 'sonnet', 'haiku', 'opusplan']

const SUBAGENT_SESSION_PREFIX = 'agent:main:subagent:'

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
    } | null
  }
  /**
   * Per-session/per-org PreToolUse policy. Defaults to permit-all when omitted.
   * Returning `{ decision: 'deny', reason }` blocks the tool call and surfaces
   * `reason` to the agent as the tool_result.
   */
  toolPolicy?: ToolPolicy
  /** Override sdkQuery for tests; defaults to the SDK's query(). */
  sdkQuery?: typeof sdkQuery
}

export function createClaudeCodeBackend(config: ClaudeCodeConfig, deps: ClaudeCodeBackendDeps = {}): ClaudeCodeBackend {
  const emitter = createBackendEmitter(KIND)
  const internal: ClaudeAdapterInternal = {
    connectionStatus: 'disconnected',
    sessions: new Map(),
    subagentToParent: new Map()
  }

  const home = process.env.HOME ?? ''
  const agentDir = config.agentDir ?? defaultAgentDir(home)
  const cwd = config.cwd ?? process.cwd()
  const defaultTools = config.defaultTools ?? DEFAULT_TOOLS
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL_FALLBACK
  const query = deps.sdkQuery ?? sdkQuery
  const mcpServers: Record<string, any> = { ...config.mcpServers }
  if (deps.sovereignMcpServer) mcpServers.sovereign = deps.sovereignMcpServer

  // Personality files — best-effort, never fatal.
  try {
    fs.mkdirSync(cwd, { recursive: true })
    ensurePersonalityFile(cwd)
    ensureLayeredContextFile(cwd)
    ensureDefaultSubagentFile(cwd)
  } catch {
    /* user may have a read-only cwd in tests */
  }

  let activeSessionKey: string | undefined

  function setStatus(status: BackendConnectionStatus, reason?: string) {
    internal.connectionStatus = status
    emitter.emit('backend.status', { status, reason })
  }

  function canonicalSessionKey(opts: { kind?: SessionKind; threadKey?: string; backendSessionId: string }): string {
    if (opts.kind === 'subagent') return `${SUBAGENT_SESSION_PREFIX}${opts.backendSessionId}`
    if (opts.threadKey) {
      if (opts.threadKey === 'main') return 'agent:main:main'
      if (opts.threadKey.startsWith('agent:')) return opts.threadKey
      return `agent:main:thread:${opts.threadKey}`
    }
    return `agent:main:thread:${opts.backendSessionId}`
  }

  function ensureSessionState(opts: {
    sessionKey: string
    backendSessionId: string
    cwd?: string
    model?: string
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
      model: state.model ?? undefined
    })
  }

  function lookupSessionOrgId(sessionKey: string): string | undefined {
    const existing = deps.registry?.lookupSession?.(sessionKey)
    return existing?.orgId
  }

  function buildHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const onSessionStart = async (input: HookInput) => {
      if (input.hook_event_name !== 'SessionStart') return { continue: true }
      const sessionKey = activeSessionKey
      if (sessionKey) emitter.emit('chat.status', { sessionKey, status: 'idle' })
      return { continue: true }
    }
    const onUserPromptSubmit = async (_input: HookInput) => {
      // Acknowledge — no-op. Logged elsewhere via chat.message.sent on the bus.
      return { continue: true }
    }
    const onPreToolUse = async (input: HookInput) => {
      if (input.hook_event_name !== 'PreToolUse') return { continue: true }
      const inp = input as Extract<HookInput, { hook_event_name: 'PreToolUse' }>

      // Redirect SDK built-in scheduling tools to Sovereign equivalents.
      // Runs before the toolPolicy check so the redirect applies regardless
      // of per-org allowlists and even when no session/policy is bound.
      // Includes the current session's threadKey in the reason so the agent
      // doesn't have to guess it (mcp__sovereign__cron_create requires it).
      if (WAKEUP_TOOLS.has(inp.tool_name)) {
        const target = WAKEUP_REDIRECT[inp.tool_name]
        const sk = activeSessionKey ?? ''
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

      const sessionKey = activeSessionKey
      const policy = deps.toolPolicy
      if (!sessionKey || !policy) return { continue: true }
      const orgId = lookupSessionOrgId(sessionKey)
      const decision = await policy({
        sessionKey,
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
    const onPostToolUse = async (input: HookInput) => {
      const sessionKey = activeSessionKey
      if (!sessionKey || input.hook_event_name !== 'PostToolUse') return { continue: true }
      const state = internal.sessions.get(sessionKey)
      if (!state) return { continue: true }
      const inp = input as Extract<HookInput, { hook_event_name: 'PostToolUse' }>

      const outputStr =
        typeof inp.tool_response === 'string' ? inp.tool_response : JSON.stringify(inp.tool_response ?? '')
      emitter.emit('chat.work', {
        sessionKey,
        work: {
          type: 'tool_result',
          name: inp.tool_name,
          output: outputStr,
          toolCallId: inp.tool_use_id,
          timestamp: Date.now()
        } as WorkItem
      })
      return { continue: true }
    }
    const onPostToolUseFailure = async (input: HookInput) => {
      const sessionKey = activeSessionKey
      if (!sessionKey || input.hook_event_name !== 'PostToolUseFailure') return { continue: true }
      const inp = input as any
      emitter.emit('chat.work', {
        sessionKey,
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
      const parentKey = activeSessionKey
      if (!parentKey) return { continue: true }
      const inp = input as Extract<HookInput, { hook_event_name: 'SubagentStart' }>
      const childKey = `${SUBAGENT_SESSION_PREFIX}${inp.agent_id}`
      internal.subagentToParent.set(inp.agent_id, parentKey)
      ensureSessionState({
        sessionKey: childKey,
        backendSessionId: inp.agent_id,
        parentSessionKey: parentKey,
        label: inp.agent_type
      })
      deps.registry?.upsertSession({
        sessionKey: childKey,
        backendSessionId: inp.agent_id,
        threadKey: childKey,
        parentSessionKey: parentKey,
        label: inp.agent_type
      })
      emitter.emit('subagent.spawned', {
        parentKey,
        childKey,
        task: inp.agent_type,
        label: inp.agent_type
      })
      const parent = internal.sessions.get(parentKey)
      parent?.liveSubagents.add(inp.agent_id)
      return { continue: true }
    }
    const onSubagentStop = async (input: HookInput) => {
      if (input.hook_event_name !== 'SubagentStop') return { continue: true }
      const inp = input as Extract<HookInput, { hook_event_name: 'SubagentStop' }>
      const parentKey = internal.subagentToParent.get(inp.agent_id) ?? activeSessionKey
      if (!parentKey) return { continue: true }
      const childKey = `${SUBAGENT_SESSION_PREFIX}${inp.agent_id}`
      const parent = internal.sessions.get(parentKey)
      parent?.liveSubagents.delete(inp.agent_id)
      emitter.emit('subagent.completed', {
        parentKey,
        childKey,
        result: inp.last_assistant_message ?? ''
      })
      internal.subagentToParent.delete(inp.agent_id)
      return { continue: true }
    }
    const onPreCompact = async (input: HookInput) => {
      const sessionKey = activeSessionKey
      if (!sessionKey || input.hook_event_name !== 'PreCompact') return { continue: true }
      emitter.emit('chat.compacting', { sessionKey, active: true })
      return { continue: true }
    }
    const onPostCompact = async (input: HookInput) => {
      const sessionKey = activeSessionKey
      if (!sessionKey || input.hook_event_name !== 'PostCompact') return { continue: true }
      emitter.emit('chat.compacting', { sessionKey, active: false })
      return { continue: true }
    }
    const onStop = async (input: HookInput) => {
      const sessionKey = activeSessionKey
      if (!sessionKey || input.hook_event_name !== 'Stop') return { continue: true }
      const state = internal.sessions.get(sessionKey)
      if (state && state.agentStatus !== 'idle') {
        state.agentStatus = 'idle'
        emitter.emit('chat.status', { sessionKey, status: 'idle' })
      }
      return { continue: true }
    }
    const onNotification = async (_input: HookInput) => ({ continue: true })
    const onSessionEnd = async (input: HookInput) => {
      if (input.hook_event_name !== 'SessionEnd') return { continue: true }
      const sessionKey = activeSessionKey
      if (sessionKey) emitter.emit('chat.status', { sessionKey, status: 'idle' })
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
    const sdkOptions: SdkOptions = {
      cwd: state.cwd,
      ...(resumeExisting ? { resume: state.backendSessionId } : { sessionId: state.backendSessionId }),
      abortController: abort,
      model: state.model ?? undefined,
      allowedTools: defaultTools,
      mcpServers,
      hooks: buildHooks(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: false,
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
          activeSessionKey = state.sessionKey
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
      label,
      parentSessionKey: opts?.parentSessionKey
    })
    persistRegistry(state, opts?.threadKey ?? sessionKey, opts?.orgId)
    // Seed the per-cwd personality files if this session uses a different cwd
    // than the adapter default — gives per-org workspaces their own CLAUDE.md
    // walk-up content without overwriting anything the user already wrote.
    if (opts?.cwd && opts.cwd !== cwd) {
      try {
        ensurePersonalityFile(opts.cwd)
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
        label: existing?.label,
        parentSessionKey: existing?.parentSessionKey
      })
      // If we just minted a fresh UUID for an unbound thread, persist the
      // binding immediately so cold restart + history endpoints can find
      // the session JSONL without needing to call sendMessage first.
      if (!existing) {
        const threadKey = sessionKey.startsWith('agent:main:thread:')
          ? sessionKey.slice('agent:main:thread:'.length)
          : sessionKey
        persistRegistry(state, threadKey)
      }
    }
    getOrStartSession(state)
    activeSessionKey = sessionKey
    state.streamLastLength = 0
    state.thinkingAccum = ''
    state.agentStatus = 'working'
    emitter.emit('chat.status', { sessionKey, status: 'working' })
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
    activeSessionKey = sessionKey
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

  function sessionFilePath(sessionKey: string): string | null {
    const state = internal.sessions.get(sessionKey)
    if (state?.sessionFile) return state.sessionFile
    if (state?.backendSessionId) {
      return findSessionFile(projectsDirForCwd(agentDir, state.cwd), state.backendSessionId)
    }
    // Cold-resume path: no in-memory state yet (post-restart, history fetched
    // before any sendMessage). Fall back to the persisted registry record.
    const existing = deps.registry?.lookupSession?.(sessionKey)
    if (existing?.backendSessionFile) return existing.backendSessionFile
    if (existing?.backendSessionId) {
      const sessionCwd = existing.cwd ?? cwd
      return findSessionFile(projectsDirForCwd(agentDir, sessionCwd), existing.backendSessionId)
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
      const kind = state.sessionKey.includes(':subagent:')
        ? 'subagent'
        : state.sessionKey.endsWith(':main')
          ? 'main'
          : 'thread'
      if (filter?.kind && filter.kind !== kind) continue
      if (filter?.parentKey && state.parentSessionKey !== filter.parentKey) continue
      out.push({
        key: state.sessionKey,
        backendSessionId: state.backendSessionId,
        kind,
        label: state.label,
        lastActivity: Date.now(),
        agentStatus: state.agentStatus,
        parentKey: state.parentSessionKey
      })
    }
    return out
  }

  async function listSubagents(parentKey?: string): Promise<SubagentSummary[]> {
    const out: SubagentSummary[] = []
    for (const state of internal.sessions.values()) {
      if (!state.parentSessionKey) continue
      if (parentKey && state.parentSessionKey !== parentKey) continue
      out.push({
        sessionKey: state.sessionKey,
        label: state.label ?? state.backendSessionId.slice(0, 8),
        status: state.agentStatus,
        lastActivity: Date.now()
      })
    }
    return out
  }

  async function getSessionMeta(sessionKey: string): Promise<SessionMeta | null> {
    const state = internal.sessions.get(sessionKey)
    if (!state) return null
    return {
      sessionKey,
      model: state.model,
      modelProvider: 'anthropic',
      contextTokens: state.lastUsage?.inputTokens ?? null,
      totalTokens: (state.lastUsage?.inputTokens ?? 0) + (state.lastUsage?.outputTokens ?? 0),
      inputTokens: state.lastUsage?.inputTokens ?? 0,
      outputTokens: state.lastUsage?.outputTokens ?? 0,
      compactionCount: 0,
      thinkingLevel: null,
      task: null,
      label: state.label ?? null,
      parentKey: state.parentSessionKey ?? null
    }
  }

  async function setSessionModel(sessionKey: string, provider: string, model: string) {
    if (provider !== 'anthropic') throw new Error(`claude-code: only anthropic provider is supported (got ${provider})`)
    const state = internal.sessions.get(sessionKey)
    if (!state) return
    state.model = model
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
        await state.liveQuery.setModel(model)
      } catch {
        /* SDK may not support setModel in this build; the change still takes
           effect when a new session loop starts. */
      }
    }
  }

  async function listAvailableModels() {
    return { models: KNOWN_MODELS, defaultModel }
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
    activeSessionKey = parentSessionKey
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
    getContextBudget,
    spawnSubagent,
    getSessionFilePath,
    getDeviceInfo,
    setActiveSession(sessionKey) {
      activeSessionKey = sessionKey
    },
    getActiveSessionKey() {
      return activeSessionKey
    }
  }

  return backend
}
