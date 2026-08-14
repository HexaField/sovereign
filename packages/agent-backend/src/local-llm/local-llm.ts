// Local LLM Agent Backend — connects to any OpenAI-compatible API
// (llama.cpp, ollama, vLLM) with built-in tool execution (Read, Write,
// Edit, Bash, Grep, Glob, LS). Every session keeps its own conversation
// transcript, tool executor (sandboxed to `config.sandbox.allowedCwds`),
// and inference client (so per-session model switches never race each
// other on a shared client) — see `ensureSession`/`rehydrate` below.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AgentBackend,
  AgentBackendKind,
  AgentStatus,
  BackendCapabilities,
  BackendConnectionStatus,
  ContextBudget,
  CreateSessionOptions,
  DeviceInfo,
  ParsedTurn,
  SessionKind,
  SessionMeta,
  SessionSummary,
  ModelCatalogEntry,
  SpawnSubagentOptions,
  SubagentSummary
} from '@sovereign/core'
import { createBackendEmitter, createWriteThroughStore, parseTurns } from '@sovereign/primitives'
import type { WriteThroughStore } from '@sovereign/primitives'
import type { LocalLlmConfig } from './config.js'
import { createInferenceClient } from './inference.js'
import type { ChatMessage as WireChatMessage, InferenceClient } from './inference.js'
import { createToolExecutor } from './tools/index.js'
import type { ToolResult } from './tools/index.js'
import { CORE_TOOL_SCHEMAS } from './tools/schemas.js'
import type { ToolSchema } from './tools/schemas.js'
import { SOVEREIGN_TOOL_SCHEMAS, createSovereignToolExecutor } from './tools/sovereign.js'
import type { SovereignToolsDeps } from './tools/sovereign.js'
import { SEMBLE_TOOL_SCHEMAS, createSembleToolExecutor } from './tools/semble.js'
import { createMcpBridge } from './tools/mcp-bridge.js'
import type { McpBridge, McpBridgeConfig } from './tools/mcp-bridge.js'
import { runToolLoop } from './tool-loop.js'
import type { ChatMessage, ToolLoopDeps } from './tool-loop.js'

const KIND: AgentBackendKind = 'local-llm'
const PROVIDER = 'local-llm'
const SESSION_STATE_SCHEMA_VERSION = 1
const HISTORY_LIMIT = 1000
const DEFAULT_MAX_ITERATIONS = 20
const RECYCLE_KEEP_RECENT_MESSAGES = 20
const RECYCLE_TRUNCATE_THRESHOLD_CHARS = 2000
const RECYCLE_MIN_INTERVAL_MS = 300_000
/** Rough chars-per-token heuristic — no local tokenizer is bundled, so token
 *  counts reported by this backend (getSessionMeta/getContextBudget) are
 *  estimates, not exact. Good enough for a usage bar. */
const CHARS_PER_TOKEN_ESTIMATE = 4

export interface LocalLlmBackend extends AgentBackend {
  /** Synchronously flush all file-backed session state. Call on shutdown. */
  flushState(): void
}

export interface LocalLlmBackendDeps {
  /** Sovereign data dir. Session state persists under `{dataDir}/agent-backend/local-llm-state/`. */
  dataDir: string
  /** Override the inference client used by every session (tests). Defaults to a real HTTP client per session. */
  inferenceClient?: InferenceClient
  /** Optional shared sessions registry — mirrors session bindings into the
   *  Sovereign-wide registry so the routing layer resolves local-llm sessions. */
  registry?: {
    upsertSession(record: Record<string, unknown>): void
    lookupSession(sessionKey: string): unknown | null
  }
  /** Optional resolver that returns extra context to prepend to the system
   *  prompt — membrane CONTEXT.md, presence files, etc. Called fresh each
   *  turn so file changes take effect without a session restart. */
  resolveSystemPromptAppend?: (sessionKey: string) => string | undefined
  /** Path to a subagent prompt file (e.g. SUBAGENT.md). When set, its contents
   *  are prepended to the system prompt for subagent sessions — compact guardrails
   *  without the full personality/membrane bulk. Read once at spawn time. */
  subagentPromptFile?: string
  /** Path to the global personality file (e.g. ~/.claude/CLAUDE.md). Read each
   *  turn and prepended to the system prompt — gives local models the same
   *  identity/context as Claude Code. */
  globalPersonalityFile?: string
  /** Sovereign-native tool deps (cron, sessions, browser, agents, etc.).
   *  When provided, Sovereign tools + WebFetch register as native tools
   *  alongside the core 7. */
  sovereignTools?: SovereignToolsDeps
  /** Enable semble code search tools (semble_search, semble_find_related).
   *  Default: true when the semble binary exists on PATH. */
  enableSemble?: boolean
  /** External MCP servers to bridge — auto-discovers tools and proxies calls.
   *  Each entry becomes a set of tools with the `name` as prefix. */
  mcpBridges?: McpBridgeConfig[]
}

function defaultSystemPrompt(
  cwd: string,
  hasSovereignTools: boolean,
  hasSemble: boolean,
  mcpBridgeNames: string[]
): string {
  const toolSections: string[] = ['core tools (Read, Write, Edit, Bash, Grep, Glob, LS)']
  if (hasSovereignTools)
    toolSections.push('Sovereign tools (cron, sessions, browser, agents, notifications, planning, WebFetch)')
  if (hasSemble) toolSections.push('semble code search (semble_search, semble_find_related)')
  if (mcpBridgeNames.length > 0) toolSections.push(`external services (${mcpBridgeNames.join(', ')})`)

  return [
    `You are a helpful assistant with access to a local filesystem, shell, and services through ${toolSections.join(', ')}.`,
    '',
    'Rules:',
    '- Read a file before you Write or Edit it.',
    '- Prefer Edit for small, targeted changes; use Write only for new files or full rewrites.',
    '- Use Grep and Glob to find things instead of guessing paths.',
    '- Keep Bash commands short and check their output before proceeding.',
    '- Only call a tool when it is actually needed to answer. Otherwise, answer directly and concisely.',
    ...(hasSovereignTools
      ? [
          '',
          'Sovereign tools use the `sovereign_` prefix (e.g. sovereign_cron_create, sovereign_browser_open).',
          'WebFetch fetches content from URLs — use it for HTTP requests.'
        ]
      : []),
    ...(hasSemble
      ? [
          '',
          'Semble tools provide semantic code search. Use semble_search for finding code by natural language or symbol name.',
          'Use semble_find_related to discover similar code given a file and line number.',
          'Prefer semble over Grep for exploratory searches. Grep remains better for literal string sweeps.'
        ]
      : []),
    ...(mcpBridgeNames.length > 0
      ? [
          '',
          `External MCP tools use their service name as prefix (e.g. ${mcpBridgeNames.map((n) => `${n}_*`).join(', ')}).`
        ]
      : []),
    '',
    `Your current working directory is: ${cwd}`
  ].join('\n')
}

/** Walk from `startDir` up to the filesystem root looking for CLAUDE.md or
 *  AGENTS.md — the repo-level context file. Returns the first match found. */
function findRepoContext(startDir: string): string | null {
  let dir = startDir
  const visited = new Set<string>()
  while (true) {
    if (visited.has(dir)) break
    visited.add(dir)
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const p = path.join(dir, name)
      try {
        const txt = fs.readFileSync(p, 'utf-8').trim()
        if (txt) return txt
      } catch {
        /* not found — keep walking */
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
}

/** Local models overwhelmingly lack multimodal wiring across llama.cpp /
 *  ollama / vLLM, and the shared wire `ChatMessage.content` is `string |
 *  null` (no content-part array) — so attachments are surfaced as a note
 *  rather than true image content. Never silently drop them. */
function buildUserContent(text: string, attachments?: Buffer[]): string {
  if (!attachments || attachments.length === 0) return text
  const note = `[${attachments.length} attachment(s) included — this backend does not forward images to the model.]`
  return text ? `${text}\n\n${note}` : note
}

/** Strip the local-only `timestamp` field before sending a message array over the wire. */
function toWireMessages(messages: ChatMessage[]): WireChatMessage[] {
  return messages.map(({ timestamp: _timestamp, ...rest }) => rest)
}

/**
 * Project the backend's OpenAI-shaped `ChatMessage[]` into the generic
 * message shape `@sovereign/primitives`' `parseTurns` expects — content
 * blocks with `type: 'text' | 'toolCall'` for assistant messages, and a
 * `role: 'toolResult'` entry (not OpenAI's `role: 'tool'`) for results.
 * Reusing `parseTurns` here is what lets local-llm assemble ParsedTurn[]
 * with the exact same tool-call/tool-result pairing and round-collapsing
 * behaviour every other backend uses, instead of a bespoke implementation.
 */
function toGenericMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : '', timestamp: m.timestamp })
      continue
    }
    if (m.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = []
      if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: 'toolCall',
          id: tc.id,
          name: tc.function?.name ?? 'tool',
          arguments: tc.function?.arguments ?? '{}'
        })
      }
      out.push({ role: 'assistant', content: blocks, timestamp: m.timestamp })
      continue
    }
    if (m.role === 'tool') {
      out.push({
        role: 'toolResult',
        toolName: m.name,
        content: typeof m.content === 'string' ? m.content : '',
        toolCallId: m.tool_call_id,
        timestamp: m.timestamp
      })
      continue
    }
    // 'system' — never appears in a persisted session transcript (the system
    // prompt is kept out-of-band and prepended only for the wire request —
    // see `runTurn`), but skip defensively if one ever sneaks in.
  }
  return out
}

/** Live, in-memory state for one session. Transient fields (client, tool
 *  executor, abort controller, queue) are re-created by `rehydrate`/
 *  `ensureSession` and never persisted. */
interface LocalLlmSessionState {
  sessionKey: string
  backendSessionId: string
  cwd: string
  model: string
  label?: string
  parentSessionKey?: string
  agentStatus: AgentStatus
  contextWindow?: number
  systemPrompt: string
  /** Pure conversation transcript — user/assistant/tool only, no system prompt. */
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  /** Messages waiting for the current turn to finish — sendMessage never drops input. */
  pendingQueue: Array<{ text: string; attachments?: Buffer[] }>
  /** True while a turn is actively running for this session. */
  processing: boolean
  abortController?: AbortController
  lastRecycleAt?: number
  compactionCount?: number
  /** Files Read this session — Write/Edit refuse to touch unread files. Reset on restart. */
  filesRead: Set<string>
  toolExecutor: ReturnType<typeof createToolExecutor>
  /** Bound to this session's own model — never shared across sessions, so a
   *  setSessionModel on one session can't race a concurrent request on another. */
  client: InferenceClient
}

/** Persisted subset of `LocalLlmSessionState` — everything serialisable. */
interface PersistedLocalLlmSession {
  sessionKey: string
  backendSessionId: string
  cwd: string
  model: string
  label?: string
  parentSessionKey?: string
  contextWindow?: number
  systemPrompt: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export function createLocalLlmBackend(
  configOrGetter: LocalLlmConfig | (() => LocalLlmConfig),
  deps: LocalLlmBackendDeps
): LocalLlmBackend {
  const getConfig = typeof configOrGetter === 'function' ? configOrGetter : () => configOrGetter
  const emitter = createBackendEmitter(KIND)
  const sessions = new Map<string, LocalLlmSessionState>()
  let connectionStatus: BackendConnectionStatus = 'disconnected'

  const sessionStore: WriteThroughStore<PersistedLocalLlmSession> = createWriteThroughStore({
    dirPath: path.join(deps.dataDir, 'agent-backend', 'local-llm-state'),
    version: SESSION_STATE_SCHEMA_VERSION,
    debounceMs: 250,
    label: 'local-llm-state'
  })

  function makeClient(model: string): InferenceClient {
    if (deps.inferenceClient) return deps.inferenceClient
    const cfg = getConfig()
    return createInferenceClient({
      baseUrl: cfg.baseUrl,
      model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.timeoutMs,
      thinking: cfg.thinking
    })
  }

  // ── Tool schemas + executors ──────────────────────────────────────
  const sovereignExecutor = deps.sovereignTools ? createSovereignToolExecutor(deps.sovereignTools) : null

  // Semble code search — enabled by default when the binary exists
  const sembleEnabled = deps.enableSemble !== false
  const sembleExecutor = sembleEnabled ? createSembleToolExecutor() : null

  // External MCP bridges (e.g. AD4M) — lazy-connect on first tool call
  const mcpBridges: McpBridge[] = (deps.mcpBridges ?? []).map(createMcpBridge)

  // Assemble tool schemas: core + sovereign + semble + MCP bridges.
  // MCP bridge schemas load asynchronously (tool discovery), so the schema
  // list starts with the statically-known tools and gets extended when
  // bridges connect. This keeps the first turn fast.
  const staticSchemas: ToolSchema[] = [
    ...CORE_TOOL_SCHEMAS,
    ...(deps.sovereignTools ? SOVEREIGN_TOOL_SCHEMAS : []),
    ...(sembleEnabled ? SEMBLE_TOOL_SCHEMAS : [])
  ]
  let allToolSchemas: ToolSchema[] = [...staticSchemas]

  // Kick off MCP bridge discovery (non-blocking)
  if (mcpBridges.length > 0) {
    Promise.allSettled(
      mcpBridges.map(async (bridge) => {
        const schemas = await bridge.getSchemas()
        if (schemas.length > 0) {
          allToolSchemas = [...staticSchemas, ...mcpBridges.flatMap((b) => b.getCachedSchemas())]
          console.log(
            `[local-llm] MCP bridge "${bridge.name}" added ${schemas.length} tools (total: ${allToolSchemas.length})`
          )
        }
      })
    )
  }

  // ── On-demand compaction ──────────────────────────────────────────
  // Production-grade context management. Uses the session's own model to
  // generate a summary of dropped messages. Falls back to heuristic
  // summary when the model call fails. Respects round boundaries so
  // tool_call/tool_result pairs never split.
  const COMPACT_THRESHOLD_RATIO = 0.75
  const COMPACT_KEEP_RECENT = 10
  /** Max chars of dropped content fed into the summarisation prompt. */
  const COMPACT_SUMMARY_INPUT_CHARS = 40_000
  /** Timeout for the summarisation inference call. */
  const COMPACT_SUMMARY_TIMEOUT_MS = 60_000

  const COMPACTION_SYSTEM_PROMPT =
    'You are a context compaction engine. Summarize the conversation excerpt below into a concise ' +
    'briefing for the assistant who will continue the conversation. Preserve:\n' +
    '- Key decisions made and their rationale\n' +
    '- File paths read, written, or edited\n' +
    '- Current task state and progress\n' +
    '- Important tool results that inform future actions\n' +
    '- User preferences or corrections expressed\n' +
    '- Error states or blockers encountered\n\n' +
    'Omit: verbose tool output, intermediate reasoning, failed attempts that were superseded, ' +
    'redundant greetings, and any content that would not help the assistant continue the task.\n\n' +
    'Write in third person past tense. Be concise but thorough — this summary replaces the ' +
    'original messages permanently.'

  /** Estimate total token usage for the current session state. Accounts for
   *  system prompt, tool schemas, and all messages. */
  function estimateSessionTokens(state: LocalLlmSessionState): number {
    const toolSchemaChars = JSON.stringify(allToolSchemas).length
    const systemChars = state.systemPrompt.length
    const messageChars = state.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
    return estimateTokens(systemChars + toolSchemaChars + messageChars)
  }

  /** Find the boundary index where we can safely split messages into
   *  "drop" and "keep" segments without breaking tool_call/tool_result
   *  pairs. Returns the number of messages to drop. Walks backwards from
   *  the desired split point to ensure the kept segment starts at a round
   *  boundary (a user message or a system message). */
  function findSafeDropCount(messages: ChatMessage[], desiredKeep: number): number {
    if (messages.length <= desiredKeep) return 0
    let splitIdx = messages.length - desiredKeep

    // Walk forward from the split point to find a safe boundary — the
    // kept segment should start with a user or system message (never an
    // assistant or tool mid-round).
    while (splitIdx < messages.length) {
      const msg = messages[splitIdx]
      if (msg.role === 'user' || msg.role === 'system') break
      splitIdx++
    }
    // If we walked all the way to the end, fall back to the original split
    if (splitIdx >= messages.length) splitIdx = messages.length - desiredKeep
    return splitIdx
  }

  /** Build a serialised transcript of dropped messages for the
   *  summarisation model. Truncates to COMPACT_SUMMARY_INPUT_CHARS. */
  function buildCompactionTranscript(dropped: ChatMessage[]): string {
    const parts: string[] = []
    let totalChars = 0
    for (const msg of dropped) {
      const role = msg.role === 'tool' ? `tool(${msg.name ?? '?'})` : msg.role
      const content = msg.content ?? ''
      // Truncate individual messages to avoid one giant tool result
      // consuming the entire budget
      const maxPerMsg = 2000
      const truncated = content.length > maxPerMsg ? content.slice(0, maxPerMsg) + ' [truncated]' : content
      const line = `[${role}]: ${truncated}`
      if (totalChars + line.length > COMPACT_SUMMARY_INPUT_CHARS) {
        parts.push(`[...${dropped.length - parts.length} earlier messages omitted for brevity...]`)
        break
      }
      parts.push(line)
      totalChars += line.length
    }
    return parts.join('\n\n')
  }

  /** Heuristic fallback summary — used when the model call fails. */
  function buildHeuristicSummary(dropped: ChatMessage[]): string {
    const lines: string[] = ['[Earlier conversation compacted — model summary unavailable.]']
    let userCount = 0
    let assistantCount = 0
    let toolCount = 0
    const toolNames = new Set<string>()
    const filePaths = new Set<string>()
    for (const msg of dropped) {
      if (msg.role === 'user') userCount++
      else if (msg.role === 'assistant') assistantCount++
      else if (msg.role === 'tool') {
        toolCount++
        if (msg.name) toolNames.add(msg.name)
      }
      // Extract file paths mentioned in content
      const content = msg.content ?? ''
      const pathMatches = content.match(/\/[\w./-]+\.\w+/g)
      if (pathMatches) pathMatches.slice(0, 20).forEach((p) => filePaths.add(p))
    }
    lines.push(
      `Dropped ${dropped.length} messages: ${userCount} user, ${assistantCount} assistant, ${toolCount} tool results.`
    )
    if (toolNames.size > 0) lines.push(`Tools used: ${[...toolNames].join(', ')}.`)
    if (filePaths.size > 0) lines.push(`Files referenced: ${[...filePaths].slice(0, 15).join(', ')}.`)

    // Keep the last few user messages and assistant responses as context
    const recentPairs: string[] = []
    for (let i = dropped.length - 1; i >= 0 && recentPairs.length < 4; i--) {
      const msg = dropped[i]
      if (msg.role === 'user' && msg.content) {
        recentPairs.unshift(`User: ${msg.content.slice(0, 300).replace(/\n/g, ' ')}`)
      } else if (msg.role === 'assistant' && msg.content) {
        recentPairs.unshift(`Assistant: ${msg.content.slice(0, 300).replace(/\n/g, ' ')}`)
      }
    }
    if (recentPairs.length > 0) {
      lines.push('', 'Last exchanges before compaction:')
      lines.push(...recentPairs)
    }
    return lines.join('\n')
  }

  async function maybeCompact(state: LocalLlmSessionState, contextWindow: number): Promise<void> {
    const estimatedTokens = estimateSessionTokens(state)
    const threshold = Math.floor(contextWindow * COMPACT_THRESHOLD_RATIO)
    if (estimatedTokens < threshold) return
    if (state.messages.length <= COMPACT_KEEP_RECENT + 2) return

    const dropCount = findSafeDropCount(state.messages, COMPACT_KEEP_RECENT)
    if (dropCount <= 0) return

    // Emit a work item so the UI shows compaction activity
    emitter.emit('chat.work', {
      sessionKey: state.sessionKey,
      work: {
        type: 'tool_call',
        toolCallId: `compaction-${Date.now()}`,
        name: '_compaction',
        input: `Compacting ${dropCount} messages (${estimateTokens(state.messages.slice(0, dropCount).reduce((n, m) => n + (m.content?.length ?? 0), 0))} est. tokens)`,
        timestamp: Date.now()
      } as any
    })

    const dropped = state.messages.splice(0, dropCount)

    // Check for an existing compaction summary — include it in the prompt
    // so accumulated context carries forward across multiple compactions.
    let priorSummary = ''
    if (dropped.length > 0 && dropped[0].role === 'system' && dropped[0].content?.startsWith('[Compacted')) {
      priorSummary = dropped[0].content
      dropped.shift()
    }

    const transcript = buildCompactionTranscript(dropped)
    let summaryContent: string

    try {
      // Use the session's model to generate a proper summary
      const summariseMessages: WireChatMessage[] = [
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        ...(priorSummary
          ? [{ role: 'user' as const, content: `Previous compaction summary:\n\n${priorSummary}` }]
          : []),
        {
          role: 'user',
          content: `Summarize this conversation excerpt:\n\n${transcript}`
        }
      ]
      const response = await state.client.complete(summariseMessages, {
        signal: AbortSignal.timeout(COMPACT_SUMMARY_TIMEOUT_MS)
      })

      const rawSummary = response.choices?.[0]?.message?.content?.trim()
      if (rawSummary && rawSummary.length > 50) {
        summaryContent = `[Compacted conversation — summary generated by ${state.model}]\n\n${rawSummary}`
      } else {
        // Model returned too little — fall back
        summaryContent = buildHeuristicSummary(dropped)
      }
    } catch (err) {
      console.error(`[local-llm] compaction summary failed for ${state.sessionKey}: ${(err as Error).message}`)
      summaryContent = buildHeuristicSummary(dropped)
    }

    state.messages.unshift({
      role: 'system',
      content: summaryContent,
      timestamp: Date.now()
    })

    state.compactionCount = (state.compactionCount ?? 0) + 1

    // If still over budget after compaction (e.g. massive system prompt
    // or very long recent messages), log a warning but don't recurse —
    // the model will get a truncated context on this turn.
    const postTokens = estimateSessionTokens(state)
    if (postTokens > contextWindow) {
      console.warn(
        `[local-llm] post-compaction tokens (${postTokens}) still exceed context window (${contextWindow}) for ${state.sessionKey}`
      )
    }

    emitter.emit('chat.work', {
      sessionKey: state.sessionKey,
      work: {
        type: 'tool_result',
        toolCallId: `compaction-${Date.now()}`,
        name: '_compaction',
        output: `Compacted ${dropped.length} messages into summary (${summaryContent.length} chars). Compaction #${state.compactionCount}.`,
        timestamp: Date.now()
      } as any
    })

    persist(state)
  }

  // Used only for connect()'s reachability probe — never bound to a session.
  const probeClient = makeClient(getConfig().model)

  function persist(state: LocalLlmSessionState): void {
    state.updatedAt = Date.now()
    sessionStore.set(state.sessionKey, {
      sessionKey: state.sessionKey,
      backendSessionId: state.backendSessionId,
      cwd: state.cwd,
      model: state.model,
      label: state.label,
      parentSessionKey: state.parentSessionKey,
      contextWindow: state.contextWindow,
      systemPrompt: state.systemPrompt,
      messages: state.messages,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt
    })
  }

  function rehydrate(): void {
    const cfg = getConfig()
    for (const { key, value } of sessionStore.entries()) {
      const cwd = value.cwd || cfg.sandbox.allowedCwds[0] || process.cwd()
      const model = value.model || cfg.model
      const filesRead = new Set<string>() // nothing survives the process boundary
      sessions.set(key, {
        sessionKey: value.sessionKey,
        backendSessionId: value.backendSessionId,
        cwd,
        model,
        label: value.label,
        parentSessionKey: value.parentSessionKey,
        agentStatus: 'idle', // reset any non-idle status on restart — nothing is actually running
        contextWindow: value.contextWindow,
        systemPrompt:
          value.systemPrompt ||
          defaultSystemPrompt(
            cwd,
            !!deps.sovereignTools,
            sembleEnabled,
            mcpBridges.map((b) => b.name)
          ),
        messages: value.messages ?? [],
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        pendingQueue: [],
        processing: false,
        filesRead,
        toolExecutor: createToolExecutor({
          allowedCwds: cfg.sandbox.allowedCwds,
          bashTimeout: cfg.sandbox.bashTimeout,
          filesRead,
          cwd
        }),
        client: makeClient(model)
      })
    }
  }
  rehydrate()

  function setConnectionStatus(status: BackendConnectionStatus, reason?: string): void {
    connectionStatus = status
    emitter.emit('backend.status', { status, reason })
  }

  function ensureSession(
    sessionKey: string,
    opts?: {
      cwd?: string
      model?: string
      label?: string
      parentSessionKey?: string
      contextWindow?: number
      systemPromptOverride?: string
    }
  ): LocalLlmSessionState {
    const existing = sessions.get(sessionKey)
    if (existing) return existing

    const now = Date.now()
    const cfg = getConfig()
    const cwd = path.resolve(opts?.cwd?.trim() || cfg.sandbox.allowedCwds[0] || process.cwd())
    const model = opts?.model?.trim() || cfg.model
    const filesRead = new Set<string>()
    const state: LocalLlmSessionState = {
      sessionKey,
      backendSessionId: randomUUID(),
      cwd,
      model,
      label: opts?.label,
      parentSessionKey: opts?.parentSessionKey,
      agentStatus: 'idle',
      contextWindow: opts?.contextWindow,
      systemPrompt:
        opts?.systemPromptOverride?.trim() ||
        defaultSystemPrompt(
          cwd,
          !!deps.sovereignTools,
          sembleEnabled,
          mcpBridges.map((b) => b.name)
        ),
      messages: [],
      createdAt: now,
      updatedAt: now,
      pendingQueue: [],
      processing: false,
      filesRead,
      toolExecutor: createToolExecutor({
        allowedCwds: cfg.sandbox.allowedCwds,
        bashTimeout: cfg.sandbox.bashTimeout,
        filesRead,
        cwd
      }),
      client: makeClient(model)
    }
    sessions.set(sessionKey, state)
    persist(state)
    return state
  }

  /** Resolve the on-disk path for a session's state file. Must match
   *  write-through-store.ts's own `pathFor` key encoding exactly. */
  function sessionFilePath(sessionKey: string): string {
    return path.join(deps.dataDir, 'agent-backend', 'local-llm-state', `${encodeURIComponent(sessionKey)}.json`)
  }

  // ── The actual agentic turn ─────────────────────────────────────────

  async function runTurn(state: LocalLlmSessionState, text: string, attachments?: Buffer[]): Promise<void> {
    state.agentStatus = 'working'
    emitter.emit('chat.status', { sessionKey: state.sessionKey, status: 'working' })

    const userMsg: ChatMessage = { role: 'user', content: buildUserContent(text, attachments), timestamp: Date.now() }
    state.messages.push(userMsg)
    persist(state)

    const controller = new AbortController()
    state.abortController = controller

    // Refresh the system prompt each turn — reads live files (personality,
    // membrane CONTEXT.md, repo AGENTS.md/CLAUDE.md) that change between turns.
    // Skip for subagent sessions — they keep their lean task-focused prompt.
    if (!state.parentSessionKey) {
      const parts: string[] = []
      // 1. Global personality (~/.claude/CLAUDE.md)
      if (deps.globalPersonalityFile) {
        try {
          const txt = fs.readFileSync(deps.globalPersonalityFile, 'utf-8').trim()
          if (txt) parts.push(txt)
        } catch {
          /* missing — skip */
        }
      }
      // 2. Membrane context (per-thread CONTEXT.md, presence files, etc.)
      if (deps.resolveSystemPromptAppend) {
        const append = deps.resolveSystemPromptAppend(state.sessionKey)
        if (append) parts.push(append)
      }
      // 3. Repo context (walk up from cwd for CLAUDE.md / AGENTS.md)
      const repoCtx = findRepoContext(state.cwd)
      if (repoCtx) parts.push(repoCtx)
      // 4. Base tool/rules prompt
      parts.push(
        defaultSystemPrompt(
          state.cwd,
          !!deps.sovereignTools,
          sembleEnabled,
          mcpBridges.map((b) => b.name)
        )
      )
      state.systemPrompt = parts.join('\n\n')
    }

    // Refresh MCP bridge tool schemas — they may have connected since startup
    if (mcpBridges.length > 0) {
      const cachedMcpSchemas = mcpBridges.flatMap((b) => b.getCachedSchemas())
      if (cachedMcpSchemas.length > 0 || allToolSchemas.length === staticSchemas.length) {
        allToolSchemas = [...staticSchemas, ...cachedMcpSchemas]
      }
    }

    // ── On-demand compaction ──────────────────────────────────────────
    // Before sending to the model, check whether the conversation exceeds
    // the context budget. If so, compact older messages into a summary.
    const contextWindow = state.contextWindow ?? getConfig().contextWindow
    await maybeCompact(state, contextWindow)

    // The system prompt is prepended fresh for the wire request only — it is
    // never stored in `state.messages`, so getHistory/getContextBudget never
    // need to filter it back out.
    const transcript: ChatMessage[] = [
      { role: 'system', content: state.systemPrompt, timestamp: state.createdAt },
      ...state.messages
    ]
    const beforeLen = transcript.length

    // Resolve tool executor — routes tool calls to the correct handler:
    //   1. sovereign_ prefix or WebFetch → sovereign executor
    //   2. semble_ prefix → semble CLI executor
    //   3. MCP bridge prefix match → MCP bridge proxy
    //   4. everything else → core tool executor (Read/Write/Edit/Bash/Grep/Glob/LS)
    const executeTool = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
      // Sovereign tools
      if (sovereignExecutor && (name.startsWith('sovereign_') || name === 'WebFetch')) {
        return sovereignExecutor(name, input)
      }
      // Semble code search
      if (sembleExecutor && name.startsWith('semble_')) {
        return sembleExecutor(name, input)
      }
      // MCP bridges — check each bridge for ownership
      for (const bridge of mcpBridges) {
        if (bridge.owns(name)) {
          return bridge.execute(name, input)
        }
      }
      // Core tools
      return state.toolExecutor.execute(name, input)
    }

    const loopDeps: ToolLoopDeps = {
      complete: (msgs, opts) =>
        state.client.complete(toWireMessages(msgs), { tools: opts?.tools, signal: opts?.signal }),
      executeTool,
      emit: emitter.emit,
      toolSchemas: allToolSchemas,
      maxIterations: DEFAULT_MAX_ITERATIONS
    }

    let finalContent = ''
    let toolCallCount = 0
    let outcome: 'ok' | 'aborted' | 'error' = 'ok'
    let errorMessage = ''

    try {
      const result = await runToolLoop(state.sessionKey, transcript, loopDeps, controller.signal)
      finalContent = result.finalContent
      toolCallCount = result.toolCallCount
    } catch (err) {
      const isAbort = (err as { name?: string } | undefined)?.name === 'AbortError'
      outcome = isAbort ? 'aborted' : 'error'
      if (!isAbort) {
        errorMessage = (err as Error)?.message ?? String(err)
        emitter.emit('chat.error', { sessionKey: state.sessionKey, error: errorMessage })
      }
    } finally {
      // Whatever the loop appended — on success, on abort, or before a
      // failure — is real conversation state (e.g. a tool call that
      // actually ran) and belongs in the persisted transcript either way.
      state.messages.push(...transcript.slice(beforeLen))
      state.abortController = undefined
    }

    const trimmed = finalContent.trim()
    const hadActivity = trimmed.length > 0 || toolCallCount > 0
    if (outcome === 'error' || hadActivity) {
      const content =
        outcome === 'error'
          ? `⚠️ ${errorMessage}`
          : trimmed || (outcome === 'aborted' ? '(stopped)' : '(no response from model)')
      const turn: ParsedTurn = {
        role: 'assistant',
        content,
        timestamp: Date.now(),
        workItems: [],
        thinkingBlocks: [],
        ...(outcome === 'error' ? { sendFailed: true } : {})
      }
      emitter.emit('chat.turn', { sessionKey: state.sessionKey, turn })
    }

    state.agentStatus = 'idle'
    emitter.emit('chat.status', { sessionKey: state.sessionKey, status: 'idle' })
    persist(state)
  }

  async function drainQueue(state: LocalLlmSessionState): Promise<void> {
    state.processing = true
    try {
      while (state.pendingQueue.length > 0) {
        const next = state.pendingQueue.shift()!
        await runTurn(state, next.text, next.attachments)
      }
    } finally {
      state.processing = false
    }
  }

  // ── AgentBackend methods ─────────────────────────────────────────────

  async function connect(): Promise<void> {
    setConnectionStatus('connecting')
    const reachable = await probeClient.healthCheck()
    if (reachable) setConnectionStatus('connected')
    else setConnectionStatus('error', `Could not reach inference server at ${getConfig().baseUrl}`)
  }

  async function disconnect(): Promise<void> {
    for (const state of sessions.values()) {
      state.pendingQueue = []
      state.abortController?.abort()
    }
    setConnectionStatus('disconnected')
  }

  function status(): BackendConnectionStatus {
    return connectionStatus
  }

  async function sendMessage(sessionKey: string, text: string, attachments?: Buffer[]): Promise<void> {
    const state = ensureSession(sessionKey)
    state.pendingQueue.push({ text, attachments })
    if (state.processing) return // already draining — the new message will be picked up in order
    await drainQueue(state)
  }

  async function abort(sessionKey: string): Promise<void> {
    const state = sessions.get(sessionKey)
    if (!state) return
    state.pendingQueue = [] // drop anything queued but not yet started
    state.abortController?.abort()
  }

  async function switchSession(_sessionKey: string): Promise<void> {
    // No server-side "active session" concept for local-llm — every session
    // is independently addressable by key on every call. Explicit no-op
    // (rather than omitting the method) to document that intentionally.
  }

  async function createSession(label?: string, opts?: CreateSessionOptions): Promise<string> {
    const sessionKey = opts?.threadKey?.trim() || randomUUID()
    ensureSession(sessionKey, {
      cwd: opts?.cwd,
      model: opts?.model?.model,
      label,
      parentSessionKey: opts?.parentSessionKey,
      contextWindow: opts?.contextWindow,
      systemPromptOverride: opts?.systemPromptOverride
    })
    // Mirror the session binding into the shared registry so the routing
    // layer resolves this session to local-llm on future lookups.
    deps.registry?.upsertSession({
      sessionKey,
      threadKey: opts?.threadKey ?? sessionKey,
      backendKind: KIND,
      label,
      cwd: opts?.cwd,
      model: opts?.model?.model,
      parentSessionKey: opts?.parentSessionKey
    })
    const history = await getFullHistory(sessionKey)
    emitter.emit('session.info', { sessionKey, label, history })
    return sessionKey
  }

  async function spawnSubagent(parentSessionKey: string, opts: SpawnSubagentOptions): Promise<string> {
    const childKey = `agent:main:subagent:${randomUUID()}`
    const parentState = sessions.get(parentSessionKey)

    // Build the subagent system prompt: guardrails (SUBAGENT.md) + task.
    let systemPrompt: string | undefined
    if (opts.task) {
      const parts: string[] = []
      if (deps.subagentPromptFile) {
        try {
          const rules = fs.readFileSync(deps.subagentPromptFile, 'utf-8').trim()
          if (rules) parts.push(rules)
        } catch {
          /* missing file — proceed without guardrails */
        }
      }
      parts.push(`# Task\n\nComplete the following task and return a concise result.\n\n${opts.task}`)
      systemPrompt = parts.join('\n\n')
    }

    await createSession(opts.label, {
      threadKey: childKey,
      parentSessionKey,
      cwd: parentState?.cwd,
      model: opts.model ? { provider: PROVIDER, model: opts.model.model } : undefined,
      systemPromptOverride: systemPrompt
    })

    // Fire-and-forget — matches claude-code's async subagent semantics.
    // The parent doesn't block on the child completing.
    sendMessage(childKey, opts.task).catch((err) => {
      emitter.emit('chat.error', { sessionKey: childKey, error: String(err) })
    })

    return childKey
  }

  async function getHistory(sessionKey: string): Promise<{ turns: ParsedTurn[]; hasMore: boolean }> {
    const state = sessions.get(sessionKey)
    if (!state) return { turns: [], hasMore: false }
    const hasMore = state.messages.length > HISTORY_LIMIT
    const windowed = hasMore ? state.messages.slice(-HISTORY_LIMIT) : state.messages
    return { turns: parseTurns(toGenericMessages(windowed)), hasMore }
  }

  async function getFullHistory(sessionKey: string): Promise<ParsedTurn[]> {
    const state = sessions.get(sessionKey)
    if (!state) return []
    return parseTurns(toGenericMessages(state.messages))
  }

  function capabilities(): BackendCapabilities {
    return {
      subagents: 'sovereign-orchestrated',
      cron: 'sovereign-managed',
      steering: false,
      followUp: false,
      compaction: 'on-demand',
      toolStreaming: true,
      deviceIdentity: false,
      multiProvider: true
    }
  }

  async function listSessions(filter?: { kind?: SessionKind; parentKey?: string }): Promise<SessionSummary[]> {
    const out: SessionSummary[] = []
    for (const state of sessions.values()) {
      const kind: SessionKind = state.parentSessionKey ? 'subagent' : 'thread'
      if (filter?.kind && filter.kind !== kind) continue
      if (filter?.parentKey && state.parentSessionKey !== filter.parentKey) continue
      out.push({
        key: state.sessionKey,
        backendSessionId: state.backendSessionId,
        kind,
        label: state.label,
        lastActivity: state.updatedAt,
        agentStatus: state.agentStatus,
        parentKey: state.parentSessionKey
      })
    }
    return out
  }

  async function listSubagents(parentKey?: string): Promise<SubagentSummary[]> {
    const out: SubagentSummary[] = []
    for (const state of sessions.values()) {
      if (!state.parentSessionKey) continue
      if (parentKey && state.parentSessionKey !== parentKey) continue
      // Extract task from the first user message if available.
      const firstUserMsg = state.messages.find((m) => m.role === 'user')
      out.push({
        sessionKey: state.sessionKey,
        label: state.label ?? state.sessionKey,
        status: state.agentStatus,
        lastActivity: state.updatedAt,
        task: firstUserMsg ? String(firstUserMsg.content) : undefined
      })
    }
    return out
  }

  async function getSessionMeta(sessionKey: string): Promise<SessionMeta | null> {
    const state = sessions.get(sessionKey)
    if (!state) return null
    const totalChars = state.systemPrompt.length + JSON.stringify(state.messages).length
    const estimatedTokens = estimateTokens(totalChars)
    return {
      sessionKey,
      model: state.model,
      modelProvider: PROVIDER,
      contextTokens: state.contextWindow ?? getConfig().contextWindow,
      totalTokens: estimatedTokens,
      inputTokens: estimatedTokens,
      outputTokens: null,
      compactionCount: state.compactionCount ?? 0,
      thinkingLevel: null,
      reasoningEffort: null,
      task: null,
      label: state.label ?? null,
      parentKey: state.parentSessionKey ?? null,
      backendSessionId: state.backendSessionId,
      backendSessionFile: sessionFilePath(sessionKey),
      lastRecycleAt: state.lastRecycleAt ?? null,
      backendKind: KIND
    }
  }

  async function setSessionModel(sessionKey: string, provider: string, model: string): Promise<void> {
    const effectiveProvider = provider || PROVIDER
    if (effectiveProvider !== PROVIDER) {
      throw new Error(`local-llm: only the "${PROVIDER}" provider is supported (got "${provider}")`)
    }
    const state = sessions.get(sessionKey)
    if (!state) return
    state.model = model
    // Safe to hot-swap in place — this client is exclusively this session's,
    // never shared, so there's no race with a concurrent request on another session.
    state.client.updateConfig({ model })
    persist(state)
  }

  async function listAvailableModels(): Promise<{
    models: string[]
    defaultModel: string | null
    catalog?: ModelCatalogEntry[]
  }> {
    const cfg = getConfig()

    // ── 1. Read on-disk model registry (e.g. llama.cpp models.json) ──────
    // The registry holds all installed models — the running inference server
    // only reports the single currently-loaded model via /v1/models.
    if (cfg.modelsRegistry) {
      try {
        const raw = JSON.parse(fs.readFileSync(cfg.modelsRegistry, 'utf-8')) as {
          models?: Record<
            string,
            { label?: string; arch?: string; active_params?: string; total_params?: string; quant?: string }
          >
          active?: string
        }
        if (raw.models && Object.keys(raw.models).length > 0) {
          const ids = Object.keys(raw.models)
          const catalog: ModelCatalogEntry[] = ids.map((key) => {
            const entry = raw.models![key]
            return {
              id: key,
              provider: PROVIDER,
              family: key,
              familyLabel: entry.label ?? key,
              version: entry.quant ?? null,
              versionLabel: entry.quant ?? 'default'
            }
          })
          const activeKey = raw.active ?? cfg.model
          const defaultModel = ids.includes(activeKey) ? activeKey : ids[0]
          return { models: ids, defaultModel, catalog }
        }
      } catch {
        // Registry unreadable or malformed — fall through to server probe.
      }
    }

    // ── 2. Fallback: query the running inference server ──────────────────
    try {
      const url = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/models`
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const data = (await res.json()) as { data?: Array<{ id?: unknown }> }
      const ids = Array.isArray(data.data)
        ? data.data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
        : []
      if (ids.length === 0) throw new Error('inference server returned no models')
      return { models: ids, defaultModel: ids.includes(cfg.model) ? cfg.model : ids[0] }
    } catch {
      return { models: [cfg.model], defaultModel: cfg.model }
    }
  }

  async function setSessionContextWindow(sessionKey: string, contextWindow: number | undefined): Promise<void> {
    const state = sessions.get(sessionKey)
    if (!state) return
    state.contextWindow = contextWindow
    persist(state)
  }

  async function getContextBudget(sessionKey: string): Promise<ContextBudget | null> {
    const state = sessions.get(sessionKey)
    if (!state) return null
    const sessionChars = JSON.stringify(state.messages).length
    return {
      source: 'sovereign',
      generatedAt: Date.now(),
      provider: PROVIDER,
      model: state.model,
      workspaceDir: state.cwd,
      systemPrompt: { chars: state.systemPrompt.length },
      tools: {
        listChars: allToolSchemas.map((t) => t.function.name).join(', ').length,
        schemaChars: JSON.stringify(allToolSchemas).length,
        entries: allToolSchemas.map((t) => ({ name: t.function.name, chars: JSON.stringify(t).length }))
      },
      session: { contextTokens: estimateTokens(state.systemPrompt.length + sessionChars) },
      disabledTools: [],
      disabledSkills: []
    }
  }

  /** Layer-2-style context recycle: truncate old tool-result content beyond
   *  the most recent N messages. No live query to interrupt (local-llm is
   *  stateless-per-request), so this is just a transcript prune + persist. */
  async function recycleSession(
    sessionKey: string,
    opts?: { force?: boolean }
  ): Promise<{
    preTokens: number
    postTokens: number
    reclaimedTokens: number
    reclaimedBytes: number
    method: 'cozempic' | 'native'
  } | null> {
    const state = sessions.get(sessionKey)
    if (!state) return null
    if (state.processing && !opts?.force) return null
    if (!opts?.force && state.lastRecycleAt && Date.now() - state.lastRecycleAt < RECYCLE_MIN_INTERVAL_MS) return null

    const preChars = state.systemPrompt.length + JSON.stringify(state.messages).length
    const preTokens = estimateTokens(preChars)

    const keepFromIndex = Math.max(0, state.messages.length - RECYCLE_KEEP_RECENT_MESSAGES)
    let changed = false
    for (let i = 0; i < keepFromIndex; i++) {
      const m = state.messages[i]
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > RECYCLE_TRUNCATE_THRESHOLD_CHARS) {
        m.content = `[pruned — ${m.content.length} chars removed by context recycle]`
        changed = true
      }
    }

    const postChars = state.systemPrompt.length + JSON.stringify(state.messages).length
    const postTokens = estimateTokens(postChars)
    state.lastRecycleAt = Date.now()
    if (changed) persist(state)

    return {
      preTokens,
      postTokens,
      reclaimedTokens: preTokens - postTokens,
      reclaimedBytes: preChars - postChars,
      method: 'native'
    }
  }

  function getDeviceInfo(): DeviceInfo {
    return {
      backendKind: KIND,
      deviceId: `local-llm@${getConfig().baseUrl}`,
      connectionStatus
    }
  }

  function getSessionFilePath(sessionKey: string): string | null {
    return sessions.has(sessionKey) ? sessionFilePath(sessionKey) : null
  }

  /** sessionKey → ms timestamp of last activity. Cheap and IO-free — every
   *  session's `updatedAt` is already held in memory. */
  async function getActivityMap(): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    for (const state of sessions.values()) {
      map.set(state.sessionKey, state.updatedAt)
    }
    return map
  }

  const backend: LocalLlmBackend = {
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
    spawnSubagent,
    getSessionMeta,
    setSessionModel,
    listAvailableModels,
    setSessionContextWindow,
    getContextBudget,
    recycleSession,
    getSessionFilePath,
    getActivityMap,
    getDeviceInfo,
    flushState() {
      sessionStore.flush()
    }
  }

  return backend
}
