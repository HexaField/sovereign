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
import { SOVEREIGN_TOOL_SCHEMAS, EMBEDDINGS_TOOL_SCHEMAS, createSovereignToolExecutor } from './tools/sovereign.js'
import type { SovereignToolsDeps } from './tools/sovereign.js'
import { SEMBLE_TOOL_SCHEMAS, createSembleToolExecutor } from './tools/semble.js'
import { createMcpBridge } from './tools/mcp-bridge.js'
import type { McpBridge, McpBridgeConfig } from './tools/mcp-bridge.js'
import { toolSearchSchema, createToolSearchRegistry } from './tools/tool-search.js'
import type { ToolSearchRegistry } from './tools/tool-search.js'
import { runToolLoop } from './tool-loop.js'
import type { ChatMessage, ToolLoopDeps } from './tool-loop.js'
import { runContextStrategies } from '../context-strategies/index.js'
import { archiveMessagesBeforeStrategies } from '../history-archive.js'

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
  /** Shared metrics accumulator. Optional — when absent, no metrics emitted. */
  metrics?: import('../metrics.js').MetricsAccumulator
}

function defaultSystemPrompt(
  cwd: string,
  hasSovereignTools: boolean,
  hasSemble: boolean,
  hasEmbeddings: boolean,
  mcpBridgeNames: string[],
  deferredToolCount?: number
): string {
  // Extra capabilities available via ToolSearch — listed in the system prompt
  // so the model knows they exist and how to access them.
  const extraCapabilities: string[] = []
  if (hasSovereignTools)
    extraCapabilities.push('Sovereign (cron, sessions, browser, agents, notifications, planning, WebFetch)')
  if (hasEmbeddings) extraCapabilities.push('embeddings (semantic search and indexing)')
  if (hasSemble) extraCapabilities.push('semble (semantic code search)')
  if (mcpBridgeNames.length > 0) extraCapabilities.push(`external services (${mcpBridgeNames.join(', ')})`)

  const hasDeferred = extraCapabilities.length > 0

  return [
    'You are a helpful assistant with access to a local filesystem and shell through core tools (Read, Write, Edit, Bash, Grep, Glob, LS).',
    '',
    'Rules:',
    '- Read a file before you Write or Edit it.',
    '- Prefer Edit for small, targeted changes; use Write only for new files or full rewrites.',
    '- Use Grep and Glob to find things instead of guessing paths.',
    '- Keep Bash commands short and check their output before proceeding.',
    '- Only call a tool when it is actually needed to answer. Otherwise, answer directly and concisely.',
    ...(hasDeferred
      ? [
          '',
          '## Additional tools',
          '',
          `You also have access to ${deferredToolCount ?? 'many'} additional tools via the ToolSearch function.`,
          'Call ToolSearch with a keyword query to discover and load tools for:',
          ...extraCapabilities.map((c) => `- ${c}`),
          '',
          'Example: to fetch a web page, call ToolSearch(query: "web fetch"). The matching tools will be returned and become available for subsequent calls.',
          'Only search for tools when you actually need a capability beyond the core set.'
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
    // System messages in the persisted transcript come from compaction
    // summaries. Pass them through so parseTurns renders them as visible
    // system turns in the history (the fallback at parseTurns:262 handles
    // unknown roles by extracting text into a system ParsedTurn).
    if (m.role === 'system') {
      out.push({ role: 'system', content: typeof m.content === 'string' ? m.content : '', timestamp: m.timestamp })
      continue
    }
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
  /** Last server-reported prompt token count from inference — used for
   *  compaction threshold checks instead of the inaccurate char estimate.
   *  Updated after each tool-loop completion. */
  lastPromptTokens?: number
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
  compactionCount?: number
  systemPrompt: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  lastPromptTokens?: number
}

export function createLocalLlmBackend(
  configOrGetter: LocalLlmConfig | (() => LocalLlmConfig),
  deps: LocalLlmBackendDeps
): LocalLlmBackend {
  const getConfig = typeof configOrGetter === 'function' ? configOrGetter : () => configOrGetter
  const emitter = createBackendEmitter(KIND)
  const sessions = new Map<string, LocalLlmSessionState>()
  // Parent→child tracking — mirrors claude-code's subagentToParent index.
  const subagentParents = new Map<string, string>() // childKey → parentKey
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

  // ── Progressive tool disclosure ────────────────────────────────────
  // Core tools (Read/Write/Edit/Bash/Grep/Glob/LS) go on every request.
  // Everything else (sovereign, semble, embeddings, MCP bridges) sits in
  // a searchable registry — the model calls ToolSearch to discover and
  // load them on demand. This keeps the per-request schema payload small
  // (~7 tools instead of 98+) and avoids blowing the context window.
  const hasEmbeddings = !!deps.sovereignTools?.embeddings

  /** Schemas sent on every completion call — small, always available. */
  const coreSchemas: ToolSchema[] = [...CORE_TOOL_SCHEMAS, toolSearchSchema]

  /** Schemas available via ToolSearch — NOT sent on the wire until loaded. */
  const deferredSchemas: ToolSchema[] = [
    ...(deps.sovereignTools ? SOVEREIGN_TOOL_SCHEMAS : []),
    ...(hasEmbeddings ? EMBEDDINGS_TOOL_SCHEMAS : []),
    ...(sembleEnabled ? SEMBLE_TOOL_SCHEMAS : [])
  ]

  // The registry holds deferred schemas and tracks which ones the model
  // has loaded via ToolSearch. Per-session registries allow different
  // sessions to have different active tool sets.
  let toolSearchRegistry: ToolSearchRegistry = createToolSearchRegistry(deferredSchemas)

  // Legacy flat list — kept for back-compat with callers that read
  // allToolSchemas directly (e.g. getSessionMeta tool count).
  let allToolSchemas: ToolSchema[] = [...coreSchemas, ...deferredSchemas]

  // Kick off MCP bridge discovery (non-blocking) — discovered tools go
  // into the ToolSearch registry, not the core set.
  if (mcpBridges.length > 0) {
    Promise.allSettled(
      mcpBridges.map(async (bridge) => {
        const schemas = await bridge.getSchemas()
        if (schemas.length > 0) {
          toolSearchRegistry.addSchemas(schemas)
          allToolSchemas = [...coreSchemas, ...deferredSchemas, ...mcpBridges.flatMap((b) => b.getCachedSchemas())]
          console.log(
            `[local-llm] MCP bridge "${bridge.name}" added ${schemas.length} tools to ToolSearch registry (total searchable: ${toolSearchRegistry.totalAvailable()})`
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

  // ── Compaction prompt ─────────────────────────────────────────────
  // Structured format adapted from Claude Code's conversation-summarization
  // prompt and Hermes' handoff-oriented compaction. Local models need explicit
  // section headers — they don't infer structure as reliably as frontier models.
  //
  // The summary replaces dropped messages permanently, so it must preserve
  // everything the assistant needs to continue the task without rereading files
  // or re-asking the user. The `<summary>` tag lets us extract the structured
  // output even when the model adds preamble or thinking.

  const COMPACTION_SYSTEM_PROMPT = `You are a context compaction engine. Your task: create a detailed summary of the conversation excerpt that preserves everything needed to continue work without losing context.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. All context you need appears in the messages below.

Analyze the conversation chronologically, then produce a structured summary using the sections below. Write in third person past tense. Be specific — exact file paths, function names, error messages, and code snippets matter more than general descriptions.

Your response MUST contain a <summary> block with these sections:

<summary>
1. **Goal:** What the user requested, including all sub-tasks and clarifications.

2. **Constraints & Preferences:** User corrections, stated preferences, style requirements, or rules that must persist (preserve these verbatim).

3. **Progress:**
   - **Done:** Completed work with specific details (file paths, function names, test results).
   - **In Progress:** Current task state — what was actively happening when this summary was triggered.
   - **Blocked:** Anything waiting on external input, missing credentials, or unresolved questions.

4. **Key Decisions:** Architectural choices, trade-offs made, and their rationale. Include decisions the user explicitly approved or rejected.

5. **Files & Code:** Every file read, written, or edited. Include:
   - File path
   - What changed and why
   - Important code snippets (function signatures, key logic)
   - Current state of each file

6. **Errors & Fixes:** Every error encountered, how it was resolved, and user feedback on fixes. Include the exact error message when available.

7. **Tool Results:** Important outputs from tool calls that inform future actions (test results, search findings, API responses). Omit verbose/redundant output.

8. **Next Step:** The single most immediate action to continue the work, based on the most recent user request. Include a direct quote from the conversation showing where work left off.
</summary>

Omit: verbose tool output already captured in section 7, intermediate reasoning that was superseded, redundant greetings, and anything that would not help the assistant continue the task.`

  /** Prefix prepended to every compaction summary stored in the transcript.
   *  Hermes-style REFERENCE ONLY directive — prevents the model from treating
   *  historical task descriptions as active instructions. */
  const COMPACTION_SUMMARY_PREFIX =
    '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. ' +
    'This summary is background context, NOT active instructions. Respond to the latest user ' +
    'message after this summary, not to tasks described within it. Your tools remain fully active.'

  /** End-of-summary delimiter — makes it unambiguous where the summary stops
   *  and the live conversation resumes. */
  const COMPACTION_SUMMARY_SUFFIX =
    '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'

  /** Extract the `<summary>...</summary>` block from the model's compaction
   *  response. Falls back to the full response if no tags found (the model
   *  may skip them). */
  function extractSummary(raw: string): string {
    const match = raw.match(/<summary>([\s\S]*?)<\/summary>/i)
    return (match ? match[1] : raw).trim()
  }

  /** Estimate total token usage for the current session state.
   *  Prefers the server-reported prompt token count (exact) over the
   *  character-based heuristic (4 chars/token, which drastically
   *  underestimates structured content like JSON and tool calls). */
  function estimateSessionTokens(state: LocalLlmSessionState): number {
    // Server-reported count from the last completion — most accurate
    if (state.lastPromptTokens && state.lastPromptTokens > 0) {
      return state.lastPromptTokens
    }
    // Fallback: character-based estimate (inaccurate for structured content)
    const toolSchemaChars = JSON.stringify(coreSchemas).length
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
    // Match both the new prefix ("[CONTEXT COMPACTION") and the legacy prefix
    // ("[Compacted conversation") for sessions that compacted before the upgrade.
    let priorSummary = ''
    if (
      dropped.length > 0 &&
      dropped[0].role === 'system' &&
      (dropped[0].content?.startsWith('[CONTEXT COMPACTION') || dropped[0].content?.startsWith('[Compacted'))
    ) {
      priorSummary = dropped[0].content
      dropped.shift()
    }

    const transcript = buildCompactionTranscript(dropped)
    let summaryContent: string

    try {
      // Use the session's model to generate a proper structured summary.
      // When a prior compaction summary exists, instruct the model to UPDATE
      // it (Hermes-style iterative summaries) rather than re-summarize from
      // scratch — this preserves information across multiple compactions.
      const summariseMessages: WireChatMessage[] = [
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        ...(priorSummary
          ? [
              {
                role: 'user' as const,
                content:
                  'A previous compaction summary exists. UPDATE it with new information from the ' +
                  'conversation excerpt below — move completed items to "Done", update "In Progress", ' +
                  'and revise "Next Step". Do not discard prior context that remains relevant.\n\n' +
                  `Previous summary:\n\n${priorSummary}`
              }
            ]
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
        const extracted = extractSummary(rawSummary)
        summaryContent = [COMPACTION_SUMMARY_PREFIX, '', extracted, '', COMPACTION_SUMMARY_SUFFIX].join('\n')
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

    // Record compaction metric
    if (deps.metrics) {
      deps.metrics.recordCompaction({
        ts: Date.now(),
        sessionKey: state.sessionKey,
        backendKind: 'local-llm',
        model: state.model,
        preTokens: estimatedTokens,
        postTokens,
        tokensReclaimed: estimatedTokens - postTokens,
        method: 'compaction',
        isSubagent: !!state.parentSessionKey
      })
    }

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
      compactionCount: state.compactionCount,
      systemPrompt: state.systemPrompt,
      messages: state.messages,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      lastPromptTokens: state.lastPromptTokens
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
        compactionCount: value.compactionCount ?? 0,
        systemPrompt:
          value.systemPrompt ||
          defaultSystemPrompt(
            cwd,
            !!deps.sovereignTools,
            sembleEnabled,
            hasEmbeddings,
            mcpBridges.map((b) => b.name),
            toolSearchRegistry.totalAvailable()
          ),
        messages: value.messages ?? [],
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        lastPromptTokens: value.lastPromptTokens,
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
          hasEmbeddings,
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

  async function runTurn(
    state: LocalLlmSessionState,
    text: string,
    attachments?: Buffer[]
  ): Promise<{ outcome: 'ok' | 'aborted' | 'error'; errorMessage: string }> {
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
          hasEmbeddings,
          mcpBridges.map((b) => b.name)
        )
      )
      state.systemPrompt = parts.join('\n\n')
    }

    // Refresh MCP bridge tool schemas — newly connected bridges get added
    // to the ToolSearch registry (not the core set sent on every request).
    if (mcpBridges.length > 0) {
      const cachedMcpSchemas = mcpBridges.flatMap((b) => b.getCachedSchemas())
      if (cachedMcpSchemas.length > 0) {
        toolSearchRegistry.addSchemas(cachedMcpSchemas)
        allToolSchemas = [...coreSchemas, ...deferredSchemas, ...cachedMcpSchemas]
      }
    }

    // ── Context strategies (Cozempic-inspired progressive pruning) ────
    // Run the strategy pipeline BEFORE compaction — it shrinks messages
    // without information loss (age-decay stubs, dedup, stale-read prune).
    // Compaction runs on the leaner result and produces a better summary.
    if (state.messages.length > 20) {
      // Archive the full message array BEFORE strategies mutate it.
      // The archive preserves the complete, unmodified conversation history.
      archiveMessagesBeforeStrategies(deps.dataDir, state.sessionKey, state.messages)

      const pipelineResult = runContextStrategies(
        state.messages as import('../context-strategies/types.js').GenericMessage[]
      )
      if (pipelineResult.totalPrunedChars > 0 || pipelineResult.totalRemoved > 0) {
        console.log(
          `[local-llm] context strategies pruned ${(pipelineResult.totalPrunedChars / 1024).toFixed(0)}KB, ` +
            `removed ${pipelineResult.totalRemoved}, replaced ${pipelineResult.totalReplaced} ` +
            `(${pipelineResult.durationMs.toFixed(0)}ms) for ${state.sessionKey}`
        )
        persist(state)

        // Record context strategy metrics
        if (deps.metrics) {
          deps.metrics.recordContextStrategy({
            ts: Date.now(),
            sessionKey: state.sessionKey,
            backendKind: KIND,
            model: state.model,
            strategies: pipelineResult.strategies.map((r) => ({
              name: r.strategyName,
              charsSaved: r.prunedChars,
              messagesAffected: r.messagesAffected,
              messagesRemoved: r.messagesRemoved,
              messagesReplaced: r.messagesReplaced
            })),
            originalChars: pipelineResult.totalOriginalChars,
            prunedChars: pipelineResult.totalPrunedChars,
            messagesRemoved: pipelineResult.totalRemoved,
            messagesReplaced: pipelineResult.totalReplaced,
            durationMs: pipelineResult.durationMs
          })
        }
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
    //
    // Compaction summaries stored in state.messages use role:'system'.
    // Many model templates (Qwen3, Llama 3.x) reject multiple system
    // messages — merge any system-role messages from the transcript into
    // the single leading system message.
    const inlineSystemMsgs = state.messages.filter((m) => m.role === 'system')
    const conversationMsgs =
      inlineSystemMsgs.length > 0 ? state.messages.filter((m) => m.role !== 'system') : state.messages
    const systemContent =
      inlineSystemMsgs.length > 0
        ? [state.systemPrompt, ...inlineSystemMsgs.map((m) => m.content).filter(Boolean)].join('\n\n')
        : state.systemPrompt

    const transcript: ChatMessage[] = [
      { role: 'system', content: systemContent, timestamp: state.createdAt },
      ...conversationMsgs
    ]
    const beforeLen = transcript.length

    // Resolve tool executor — routes tool calls to the correct handler:
    //   0. ToolSearch → progressive tool disclosure (returns schemas, expands active set)
    //   1. sovereign_ prefix or WebFetch → sovereign executor
    //   2. semble_ prefix → semble CLI executor
    //   3. MCP bridge prefix match → MCP bridge proxy
    //   4. everything else → core tool executor (Read/Write/Edit/Bash/Grep/Glob/LS)
    const executeTool = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
      // ToolSearch — progressive disclosure meta-tool
      if (name === 'ToolSearch') {
        return toolSearchRegistry.execute(input)
      }
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

    // Wrap executeTool with metrics timing + char measurement
    const metricsExecuteTool: typeof executeTool = async (name, input) => {
      const startTime = Date.now()
      const inputChars = JSON.stringify(input).length
      const result = await executeTool(name, input)
      const outputChars = (result.content?.length ?? 0) + (result.error?.length ?? 0)
      if (deps.metrics) {
        deps.metrics.recordToolCall({
          ts: Date.now(),
          sessionKey: state.sessionKey,
          backendKind: 'local-llm',
          model: state.model,
          toolName: name,
          inputChars,
          outputChars,
          outputTrimmedChars: 0,
          durationMs: Date.now() - startTime,
          isSubagent: !!state.parentSessionKey
        })
      }
      return result
    }

    // Track whether mid-loop compaction modified the transcript. When it
    // does, the post-loop reconciliation must replace state.messages
    // entirely rather than appending a suffix.
    let midLoopCompacted = false
    let midLoopCompactionSummary: string | null = null

    const loopDeps: ToolLoopDeps = {
      complete: (msgs, opts) =>
        state.client.complete(toWireMessages(msgs), { tools: opts?.tools, signal: opts?.signal }),
      executeTool: metricsExecuteTool,
      emit: emitter.emit,
      toolSchemas: coreSchemas,
      // Progressive tool disclosure: each iteration sends core schemas +
      // any schemas the model has loaded via ToolSearch this session.
      getActiveSchemas: () => [...coreSchemas, ...toolSearchRegistry.getLoadedSchemas()],
      maxIterations: DEFAULT_MAX_ITERATIONS,
      // Mid-loop compaction: keeps single-turn tool loops from overflowing
      // the context window without triggering compaction.
      onIterationEnd: async (promptTokens, loopMessages) => {
        state.lastPromptTokens = promptTokens
        const ctxWin = state.contextWindow ?? getConfig().contextWindow
        const threshold = Math.floor(ctxWin * COMPACT_THRESHOLD_RATIO)
        if (promptTokens < threshold) return
        // loopMessages[0] = system message; conversation starts at [1].
        const conversationLen = loopMessages.length - 1
        if (conversationLen <= COMPACT_KEEP_RECENT + 2) return

        const conversation = loopMessages.slice(1)
        const dropCount = findSafeDropCount(conversation, COMPACT_KEEP_RECENT)
        if (dropCount <= 0) return

        // Emit compaction activity to the UI
        emitter.emit('chat.work', {
          sessionKey: state.sessionKey,
          work: {
            type: 'tool_call',
            toolCallId: `mid-compact-${Date.now()}`,
            name: '_compaction',
            input: `Mid-loop compaction: ${dropCount} messages (${promptTokens} prompt tokens, threshold ${threshold})`,
            timestamp: Date.now()
          } as any
        })

        // Splice out old conversation messages (keep system at [0])
        const dropped = loopMessages.splice(1, dropCount)

        // Check for prior compaction summary at the start of dropped segment
        let priorSummary = ''
        if (
          dropped.length > 0 &&
          dropped[0].role === 'system' &&
          (dropped[0].content?.startsWith('[CONTEXT COMPACTION') || dropped[0].content?.startsWith('[Compacted'))
        ) {
          priorSummary = dropped[0].content
          dropped.shift()
        }

        // Generate summary
        const transcript = buildCompactionTranscript(dropped)
        let summaryContent: string

        try {
          const summariseMessages: WireChatMessage[] = [
            { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
            ...(priorSummary
              ? [
                  {
                    role: 'user' as const,
                    content:
                      'A previous compaction summary exists. UPDATE it with new information from the ' +
                      'conversation excerpt below — move completed items to "Done", update "In Progress", ' +
                      'and revise "Next Step". Do not discard prior context that remains relevant.\n\n' +
                      `Previous summary:\n\n${priorSummary}`
                  }
                ]
              : []),
            { role: 'user', content: `Summarize this conversation excerpt:\n\n${transcript}` }
          ]
          const response = await state.client.complete(summariseMessages, {
            signal: AbortSignal.timeout(COMPACT_SUMMARY_TIMEOUT_MS)
          })
          const rawSummary = response.choices?.[0]?.message?.content?.trim()
          if (rawSummary && rawSummary.length > 50) {
            summaryContent = [
              COMPACTION_SUMMARY_PREFIX,
              '',
              extractSummary(rawSummary),
              '',
              COMPACTION_SUMMARY_SUFFIX
            ].join('\n')
          } else {
            summaryContent = buildHeuristicSummary(dropped)
          }
        } catch (err) {
          console.error(
            `[local-llm] mid-loop compaction summary failed for ${state.sessionKey}: ${(err as Error).message}`
          )
          summaryContent = buildHeuristicSummary(dropped)
        }

        // Merge summary into the leading system message to avoid
        // multi-system-message issues with model templates.
        loopMessages[0] = {
          ...loopMessages[0],
          content: loopMessages[0].content + '\n\n' + summaryContent
        }

        // Capture the summary so post-loop reconciliation can restore it
        // (transcript[0] gets dropped by slice(1) below).
        midLoopCompactionSummary = summaryContent

        state.compactionCount = (state.compactionCount ?? 0) + 1
        midLoopCompacted = true

        emitter.emit('chat.work', {
          sessionKey: state.sessionKey,
          work: {
            type: 'tool_result',
            toolCallId: `mid-compact-${Date.now()}`,
            name: '_compaction',
            output: `Mid-loop compacted ${dropped.length} messages into summary. Compaction #${state.compactionCount}.`,
            timestamp: Date.now()
          } as any
        })

        if (deps.metrics) {
          const postTokens = promptTokens - estimateTokens(dropped.reduce((n, m) => n + (m.content?.length ?? 0), 0))
          deps.metrics.recordCompaction({
            ts: Date.now(),
            sessionKey: state.sessionKey,
            backendKind: 'local-llm',
            model: state.model,
            preTokens: promptTokens,
            postTokens: Math.max(postTokens, 0),
            tokensReclaimed: Math.max(promptTokens - postTokens, 0),
            method: 'compaction',
            isSubagent: !!state.parentSessionKey
          })
        }
      },

      // Emergency compaction — triggered when the server rejects a request
      // because context exceeds n_ctx. Forces compaction regardless of the
      // threshold estimate (which may have underestimated).
      onContextOverflow: async (loopMessages) => {
        const conversationLen = loopMessages.length - 1
        if (conversationLen <= COMPACT_KEEP_RECENT + 2) return false

        const conversation = loopMessages.slice(1)
        const dropCount = findSafeDropCount(conversation, COMPACT_KEEP_RECENT)
        if (dropCount <= 0) return false

        console.warn(
          `[local-llm] emergency compaction: dropping ${dropCount} messages after context overflow for ${state.sessionKey}`
        )

        // Emit compaction activity
        emitter.emit('chat.work', {
          sessionKey: state.sessionKey,
          work: {
            type: 'tool_call',
            toolCallId: `overflow-compact-${Date.now()}`,
            name: '_compaction',
            input: `Emergency compaction: context overflow, dropping ${dropCount} messages`,
            timestamp: Date.now()
          } as any
        })

        const dropped = conversation.splice(0, dropCount)
        loopMessages.length = 1 // keep system message
        loopMessages.push(...conversation)

        // Check for prior compaction summary
        let priorSummary = ''
        if (
          dropped.length > 0 &&
          dropped[0].role === 'system' &&
          (dropped[0].content?.startsWith('[CONTEXT COMPACTION') || dropped[0].content?.startsWith('[Compacted'))
        ) {
          priorSummary = dropped[0].content!
          dropped.shift()
        }

        const transcript = buildCompactionTranscript(dropped)
        let summaryContent: string

        try {
          const summariseMessages: WireChatMessage[] = [
            { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
            ...(priorSummary
              ? [
                  {
                    role: 'user' as const,
                    content:
                      'A previous compaction summary exists. UPDATE it with new information from the ' +
                      'conversation excerpt below — move completed items to "Done", update "In Progress", ' +
                      'and revise "Next Step". Do not discard prior context that remains relevant.\n\n' +
                      `Previous summary:\n\n${priorSummary}`
                  }
                ]
              : []),
            { role: 'user', content: `Summarize this conversation excerpt:\n\n${transcript}` }
          ]
          const response = await state.client.complete(summariseMessages, {
            signal: AbortSignal.timeout(COMPACT_SUMMARY_TIMEOUT_MS)
          })
          const rawSummary = response.choices?.[0]?.message?.content?.trim()
          if (rawSummary && rawSummary.length > 50) {
            const extracted = extractSummary(rawSummary)
            summaryContent = [COMPACTION_SUMMARY_PREFIX, '', extracted, '', COMPACTION_SUMMARY_SUFFIX].join('\n')
          } else {
            summaryContent = buildHeuristicSummary(dropped)
          }
        } catch (err) {
          console.error(
            `[local-llm] emergency compaction summary failed for ${state.sessionKey}: ${(err as Error).message}`
          )
          summaryContent = buildHeuristicSummary(dropped)
        }

        // Merge summary into the leading system message (same approach as mid-loop)
        loopMessages[0] = {
          ...loopMessages[0],
          content: loopMessages[0].content + '\n\n' + summaryContent
        }

        // Capture the summary so post-loop reconciliation can restore it.
        midLoopCompactionSummary = summaryContent

        state.compactionCount = (state.compactionCount ?? 0) + 1
        midLoopCompacted = true

        emitter.emit('chat.work', {
          sessionKey: state.sessionKey,
          work: {
            type: 'tool_result',
            toolCallId: `overflow-compact-${Date.now()}`,
            name: '_compaction',
            output: `Emergency compacted ${dropped.length} messages into summary. Compaction #${state.compactionCount}.`,
            timestamp: Date.now()
          } as any
        })

        if (deps.metrics) {
          deps.metrics.recordCompaction({
            ts: Date.now(),
            sessionKey: state.sessionKey,
            backendKind: 'local-llm',
            model: state.model,
            preTokens: state.lastPromptTokens ?? 0,
            postTokens: 0, // unknown until next inference
            tokensReclaimed: 0,
            method: 'compaction',
            isSubagent: !!state.parentSessionKey
          })
        }

        persist(state)
        return true
      }
    }

    let finalContent = ''
    let toolCallCount = 0
    let outcome: 'ok' | 'aborted' | 'error' = 'ok'
    let errorMessage = ''

    try {
      const result = await runToolLoop(state.sessionKey, transcript, loopDeps, controller.signal)
      finalContent = result.finalContent
      toolCallCount = result.toolCallCount
      // Record server-reported prompt tokens for accurate compaction checks
      if (result.lastPromptTokens) {
        state.lastPromptTokens = result.lastPromptTokens
      }
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
      if (midLoopCompacted) {
        // Mid-loop compaction spliced the transcript — beforeLen is stale.
        // Replace state.messages with the full conversation from the
        // transcript (everything after the leading system message).
        state.messages = transcript.slice(1)
        // Preserve compaction summary for future turns — without this, the
        // summary merged into transcript[0] (system message) gets dropped
        // by slice(1) and the model loses all pre-compaction context.
        if (midLoopCompactionSummary) {
          state.messages.unshift({
            role: 'system',
            content: midLoopCompactionSummary,
            timestamp: Date.now()
          })
        }
      } else {
        state.messages.push(...transcript.slice(beforeLen))
      }
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

    // Record context snapshot after each turn
    if (deps.metrics) {
      const contextWindow = state.contextWindow ?? getConfig().contextWindow
      const totalTokens = estimateSessionTokens(state)
      deps.metrics.recordContextSnapshot({
        ts: Date.now(),
        sessionKey: state.sessionKey,
        backendKind: 'local-llm',
        model: state.model,
        totalTokens,
        contextWindow,
        fillPercent: contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0
      })
    }

    persist(state)
    return { outcome, errorMessage }
  }

  async function drainQueue(state: LocalLlmSessionState): Promise<void> {
    state.processing = true
    try {
      let lastResult: { outcome: 'ok' | 'aborted' | 'error'; errorMessage: string } = {
        outcome: 'ok',
        errorMessage: ''
      }
      while (state.pendingQueue.length > 0) {
        const next = state.pendingQueue.shift()!
        lastResult = await runTurn(state, next.text, next.attachments)
      }
      // Emit lifecycle event when a subagent session finishes its queue.
      const parentKey = subagentParents.get(state.sessionKey)
      if (parentKey) {
        if (lastResult.outcome === 'error') {
          emitter.emit('subagent.failed', {
            parentKey,
            childKey: state.sessionKey,
            error: lastResult.errorMessage
          })
        } else {
          const lastAssistant = [...state.messages].reverse().find((m) => m.role === 'assistant')
          const result = lastAssistant?.content
            ? typeof lastAssistant.content === 'string'
              ? lastAssistant.content
              : JSON.stringify(lastAssistant.content)
            : ''
          emitter.emit('subagent.completed', {
            parentKey,
            childKey: state.sessionKey,
            result
          })
        }
        subagentParents.delete(state.sessionKey)
      }
    } catch (err) {
      // Safety net — in case a future change makes runTurn throw again.
      const parentKey = subagentParents.get(state.sessionKey)
      if (parentKey) {
        emitter.emit('subagent.failed', {
          parentKey,
          childKey: state.sessionKey,
          error: String(err)
        })
        subagentParents.delete(state.sessionKey)
      }
      throw err
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
    // Fire-and-forget — matches Claude Code's async semantics. The tool
    // loop runs asynchronously; chat.status/chat.turn/chat.error events
    // drive the UI lifecycle. Blocking here caused user messages to
    // "disappear": pumpQueue's synthetic user turn only fires after
    // sendMessage resolves, but drainQueue blocks until the full tool
    // loop completes, so the assistant response arrived before the user
    // message was visible in the turn list.
    void drainQueue(state).catch((err) => {
      console.error(`[local-llm] drainQueue error for ${sessionKey}:`, err)
      emitter.emit('chat.error', { sessionKey, error: String(err) })
    })
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

    // Track parent→child relationship for lifecycle events.
    subagentParents.set(childKey, parentSessionKey)

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

    emitter.emit('subagent.spawned', {
      parentKey: parentSessionKey,
      childKey,
      task: opts.task,
      label: opts.label ?? opts.task
    })

    // Fire-and-forget — matches claude-code's async subagent semantics.
    // The parent doesn't block on the child completing.
    sendMessage(childKey, opts.task).catch((err) => {
      emitter.emit('chat.error', { sessionKey: childKey, error: String(err) })
      emitter.emit('subagent.failed', {
        parentKey: parentSessionKey,
        childKey,
        error: String(err)
      })
      subagentParents.delete(childKey)
    })

    return childKey
  }

  async function getHistory(
    sessionKey: string,
    opts?: { before?: number; limit?: number }
  ): Promise<{ turns: ParsedTurn[]; hasMore: boolean; oldestTimestamp?: number }> {
    const state = sessions.get(sessionKey)
    if (!state) return { turns: [], hasMore: false }
    const allTurns = parseTurns(toGenericMessages(state.messages))

    // Apply cursor filter
    let filtered = allTurns
    if (opts?.before) {
      filtered = allTurns.filter((t) => t.timestamp < opts.before!)
    }

    // Apply limit
    const limit = opts?.limit ?? (opts?.before ? 50 : HISTORY_LIMIT)
    const hasMore = filtered.length > limit
    const page = filtered.length > limit ? filtered.slice(-limit) : filtered
    const oldestTimestamp = page.length > 0 ? page[0].timestamp : undefined

    return { turns: page, hasMore, oldestTimestamp }
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
    // Use the SAME estimator that drives compaction decisions — single source
    // of truth. The old formula (systemPrompt.length + JSON.stringify(messages).length)
    // inflated the count by ~30-50% from JSON envelope overhead (keys, braces,
    // escape sequences) and omitted tool schemas, causing the UI to show more
    // tokens than the compaction engine tracked.
    const estimatedTokens = estimateSessionTokens(state)
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
    // Use estimateSessionTokens — the same single source of truth that
    // drives compaction and getSessionMeta.
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
      session: { contextTokens: estimateSessionTokens(state) },
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

    const preTokens = estimateSessionTokens(state)

    // Archive the full message array BEFORE truncation modifies it.
    archiveMessagesBeforeStrategies(deps.dataDir, sessionKey, state.messages)

    const keepFromIndex = Math.max(0, state.messages.length - RECYCLE_KEEP_RECENT_MESSAGES)
    let changed = false
    for (let i = 0; i < keepFromIndex; i++) {
      const m = state.messages[i]
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > RECYCLE_TRUNCATE_THRESHOLD_CHARS) {
        m.content = `[pruned — ${m.content.length} chars removed by context recycle]`
        changed = true
      }
    }

    const postTokens = estimateSessionTokens(state)
    state.lastRecycleAt = Date.now()
    if (changed) persist(state)

    // Record recycle metric
    if (deps.metrics) {
      deps.metrics.recordCompaction({
        ts: Date.now(),
        sessionKey,
        backendKind: 'local-llm',
        model: state.model,
        preTokens,
        postTokens,
        tokensReclaimed: preTokens - postTokens,
        method: 'recycle',
        isSubagent: !!state.parentSessionKey
      })
    }

    return {
      preTokens,
      postTokens,
      reclaimedTokens: preTokens - postTokens,
      reclaimedBytes: (preTokens - postTokens) * CHARS_PER_TOKEN_ESTIMATE,
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

  /** Query MCP bridge connection status. */
  async function getMcpStatus(): Promise<import('@sovereign/core').McpServerStatus[]> {
    return mcpBridges.map((bridge) => ({
      name: bridge.name,
      status: bridge.connected ? ('connected' as const) : ('disconnected' as const),
      ...(bridge.error ? { error: bridge.error } : {})
    }))
  }

  /** Reconnect all MCP bridges. */
  async function reconnectMcp(): Promise<{ reconnected: string[]; failed: string[] }> {
    const reconnected: string[] = []
    const failed: string[] = []
    for (const bridge of mcpBridges) {
      try {
        await bridge.reconnect()
        reconnected.push(bridge.name)
      } catch (err: any) {
        console.warn(`[local-llm] MCP bridge "${bridge.name}" reconnect failed:`, err?.message)
        failed.push(bridge.name)
      }
    }
    return { reconnected, failed }
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
    getMcpStatus,
    reconnectMcp,
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
