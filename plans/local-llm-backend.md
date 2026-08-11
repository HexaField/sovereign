# Local LLM Backend + Running Summary

Two features that reduce Claude dependency and add ambient intelligence.

## Current State

### Agent Backend Architecture

The multi-backend system already exists:

- `AgentBackendKind = 'pi' | 'claude-code'` — union type, `'pi'` designed but unimplemented
- `RoutingBackend` dispatches per-session to concrete backends via `SessionsRegistry`
- `BackendCapabilities` declares what each backend supports (subagents, cron, streaming, etc.)
- `routingAsBackend()` adapter gives callers a single `AgentBackend` view over multiple backends
- Factory pattern in `wiring.ts` — one entry per backend kind

Adding a new backend = implement `AgentBackend` interface + register a factory. Routing, events, sessions, MCP, cron, resume, and UI all work generically.

### Tool Landscape

**Two categories of tools exist:**

| Category | Count | Source | MCP-compatible? |
| --- | --- | --- | --- |
| Claude Code SDK built-in | ~35 | Baked into `@anthropic-ai/claude-agent-sdk` binary | No — SDK-internal |
| Sovereign MCP tools | 25 (16 core + 9 presence) | `mcp-server.ts` + `mcp-sidecar` | Yes — standard MCP protocol |

**Claude Code SDK built-in tools (the ones we need to reimplement):**

Core (DEFAULT_TOOLS — used every session):

- `Read` — read files (offset, limit, pages for PDF)
- `Write` — write/overwrite files
- `Edit` — surgical string replacement (old_string → new_string)
- `Bash` — shell command execution (timeout, background)
- `Grep` — ripgrep search (regex, glob filter, output modes)
- `Glob` — file pattern matching
- `LS` — directory listing

Extended (available but not in default set):

- `WebFetch` — fetch URL content
- `WebSearch` — web search
- `NotebookEdit` — Jupyter cell editing
- `Agent` / `Task*` — subagent management (Sovereign already has `agents_spawn`)
- `AskUserQuestion` — structured user prompts
- `ScheduleWakeup` / `Cron*` — scheduling (Sovereign already handles via MCP redirect)
- `Monitor` — watch background processes
- `Workflow` — multi-agent orchestration scripts
- `ReportFindings` — code review output

**Sovereign MCP tools (already backend-agnostic):**

All 25 tools follow standard MCP protocol. The sidecar (`packages/mcp-sidecar`) already serves them over Streamable HTTP transport. Any MCP-compatible client can connect. These require zero reimplementation — the local LLM backend just needs to connect as an MCP client.

---

## Feature 1: Local LLM Backend

### Goal

A new `AgentBackendKind = 'local-llm'` that connects to any OpenAI-compatible API (ollama, vllm, llama.cpp server, LM Studio, etc.) with full tool-calling capability. Main use: subagents on local models while main threads stay on Claude for planning and orchestration.

### Architecture

```
┌──────────────────────────────────────────────┐
│ Sovereign Server                              │
│                                               │
│  RoutingBackend                               │
│  ├── claude-code (main threads)               │
│  │   └── Claude Agent SDK → Anthropic API     │
│  │                                            │
│  └── local-llm (subagent threads)             │
│      ├── OpenAI-compat client → ollama/vllm   │
│      ├── Built-in tool executor               │
│      │   ├── Read / Write / Edit              │
│      │   ├── Bash (sandboxed)                 │
│      │   ├── Grep / Glob / LS                 │
│      │   └── WebFetch                         │
│      └── MCP client → Sovereign MCP sidecar   │
│          └── cron, sessions, browser, agents,  │
│              presence, notifications, etc.     │
└──────────────────────────────────────────────┘
```

### Implementation Plan

#### Phase 1: Core backend skeleton

**New package directory:** `packages/agent-backend/src/local-llm/`

Files:

- `local-llm.ts` — `createLocalLlmBackend()` factory, implements `AgentBackend`
- `types.ts` — config types (endpoint URL, model, context window, temperature, etc.)
- `config.ts` — resolve config from `ConfigStore`
- `inference.ts` — OpenAI-compatible chat completion client (streaming SSE)
- `tool-loop.ts` — agentic tool-calling loop (send → receive tool_calls → execute → feed results → repeat)
- `events.ts` — translate inference stream into Sovereign `AgentBackendEvents`
- `index.ts` — public surface

**Type widening:**

- `AgentBackendKind` → add `'local-llm'`
- `ALL_KINDS` in `factory.ts` → add entry
- Config schema → add `'local-llm'` to `enabled`/`default` enums, add `localLlm` section
- Config defaults → sensible defaults (ollama on localhost:11434, qwen2.5-coder:7b)

**Factory registration** in `wiring.ts`:

```typescript
factories: {
  'claude-code': () => createClaudeCodeBackend(...),
  'local-llm': () => createLocalLlmBackend(...)
}
```

**Capabilities declaration:**

```typescript
{
  subagents: 'sovereign-orchestrated',  // Sovereign manages subagent lifecycle
  cron: 'sovereign-managed',            // Use Sovereign's cron service
  steering: false,                       // No mid-turn steering
  followUp: false,                       // No automatic follow-up
  compaction: 'on-demand',               // Manual context management
  toolStreaming: false,                   // Tools complete then return
  deviceIdentity: false,
  multiProvider: true                    // Multiple model endpoints
}
```

#### Phase 2: Built-in tool executor

**New module:** `packages/agent-backend/src/local-llm/tools/`

Reimplement the 7 core tools + WebFetch as standalone functions. Each tool:

- Takes validated input (JSON Schema matches Claude Code's schemas exactly)
- Returns `{ content: string, error?: string }`
- Runs in-process (not spawned)

| Tool | Implementation approach |
| --- | --- |
| `Read` | `fs.readFile` + line numbering + offset/limit. PDF via `pdf-parse`. Images via base64 encoding. |
| `Write` | `fs.writeFile` with directory creation. Safety check: refuse overwrite unless file already read in session. |
| `Edit` | String search + replace. Validate uniqueness of `old_string`. Support `replace_all`. |
| `Bash` | `child_process.spawn` with timeout, cwd tracking, output capture. Sandboxing via cwd restriction (configurable). |
| `Grep` | Shell out to `rg` (ripgrep) with the same flags Claude Code uses. Parse output into structured results. |
| `Glob` | `fast-glob` or shell out to `find`. Return sorted by mtime. |
| `LS` | `fs.readdir` with stat info. |
| `WebFetch` | `fetch()` + html-to-text conversion. Respect robots.txt (optional). |

**Tool schema registry:** A single `TOOL_SCHEMAS` map that holds the JSON Schema for each tool. The tool-calling loop sends these as the `tools` array in the chat completion request. Match Claude Code's schema shapes exactly so model behaviour transfers.

**Security model for Bash:**

- Configurable `allowedCommands` list (default: permissive for subagents, since they run under Sovereign's control)
- Configurable `cwd` restriction (default: workspace root)
- Timeout enforcement (default: 120s, max: 600s)
- No interactive commands (same as Claude Code)

#### Phase 3: MCP tool integration

The local LLM backend connects to Sovereign's MCP tools via the in-process MCP server:

- On `connect()`, establish an MCP client session to `http://127.0.0.1:5801/api/mcp` (the main server)
- Call `tools/list` to discover available tools
- Merge MCP tool schemas into the tool registry alongside built-in tools
- When the model calls an MCP tool, forward via MCP `tools/call` and return the result

This gives the local LLM access to all 25 Sovereign tools (cron, sessions, browser, agents, presence, etc.) without reimplementing any of them.

**External MCP servers** (AD4M, semble, user-configured) connect the same way — the sidecar already proxies them.

#### Phase 4: Tool-calling loop

The core agentic loop in `tool-loop.ts`:

```
1. Assemble messages (system prompt + conversation history)
2. Send chat completion request with tool schemas
3. Stream response tokens → emit chat.stream events
4. If response contains tool_calls:
   a. Emit chat.work events (tool_call)
   b. Execute each tool (built-in or MCP)
   c. Emit chat.work events (tool_result)
   d. Append tool results to messages
   e. Go to step 2
5. If response has no tool_calls → turn complete
   a. Emit chat.turn event
   b. Emit chat.status → idle
```

**Context management:**

- Track token count per message (tiktoken or model-reported)
- When context fills, truncate oldest messages (keep system prompt + last N turns)
- Expose via `getContextBudget()` for the UI

**Abort handling:**

- `AbortController` per inference request
- `abort(sessionKey)` cancels in-flight request + clears pending tool executions

#### Phase 5: System prompt assembly

Reuse the existing `makePresenceAwareAppendResolver` from `wiring.ts`:

- Global personality (`~/.claude/CLAUDE.md`)
- Membrane context (`CONTEXT.md`)
- Presence layers (for presence threads)
- Thread-specific instructions

The resolver already produces a plain string — no SDK dependency. Pass it as the system message in the chat completion request.

#### Phase 6: Session lifecycle

- `createSession()` — allocate a session key, create conversation history store
- `sendMessage()` — push user message, start tool-calling loop
- `getHistory()` / `getFullHistory()` — return conversation history
- `abort()` — cancel in-flight inference
- `switchSession()` — no-op (sessions are independent)
- `listSessions()` — enumerate active sessions
- Persistence: conversation history stored as JSON in `<dataDir>/agent-backend/local-llm-state/<sessionKey>.json`

### Config Shape

```json
{
  "agentBackend": {
    "enabled": ["claude-code", "local-llm"],
    "default": "claude-code",
    "localLlm": {
      "provider": "ollama",
      "baseUrl": "http://localhost:11434",
      "model": "qwen2.5-coder:7b",
      "contextWindow": 32768,
      "temperature": 0.1,
      "maxTokens": 4096,
      "toolCallFormat": "auto",
      "sandbox": {
        "allowedCwds": ["~/workspaces"],
        "bashTimeout": 120000
      }
    }
  }
}
```

`toolCallFormat` handles the variation in how models report tool calls — `"auto"` detects from the response shape, or explicit `"openai"` / `"anthropic"` / `"hermes"` for edge cases.

### Thread-level backend selection

The routing backend already dispatches per-session. To make subagents use local-llm while main threads use Claude:

- Config: `agentBackend.default = "claude-code"` (main threads)
- When spawning a subagent, the orchestrator can specify `backendKind: "local-llm"` in `CreateSessionOptions`
- The `RoutingBackend.bindThread()` records the binding
- Alternatively: a per-membrane or per-thread config override (`thread.backendKind`)

### What We Do NOT Reimplement

These Claude Code SDK features stay Claude-only (not needed for subagents):

- `Agent` / `Workflow` — Sovereign's own `agents_spawn` handles orchestration
- `AskUserQuestion` — subagents do not interact with users directly
- `NotebookEdit` — niche, add later if needed
- `EnterPlanMode` / `ExitPlanMode` — Claude Code UI feature
- `ReportFindings` — code review feature, stays on Claude
- `ScheduleWakeup` — Sovereign's `cron_create` handles scheduling
- `Monitor` — can add later
- `TodoWrite` / `TodoRead` — can add later
- `REPL` — can add later

---

## Feature 2: Running Summary Service

### Goal

A lightweight, always-on summarizer that maintains a rolling description of each thread's activity. Uses a small, fast local model. Runs as a Sovereign module, not as an agent backend.

### Architecture

```
EventBus
  ├── chat.turn (user messages)
  ├── chat.turn (assistant completions)
  ├── subagent.completed
  └── system.resume
         │
         ▼
  ┌─────────────────────┐
  │ SummaryService       │
  │                      │
  │ Listens to bus events│
  │ Debounces per thread │
  │ Calls local model    │
  │ Updates rolling      │
  │ summary per thread   │
  │                      │
  │ Storage:             │
  │ <dataDir>/summaries/ │
  │  <threadKey>.json    │
  └─────────────────────┘
         │
         ▼
  Exposed via:
  - GET /api/threads/:id/summary
  - WS event: thread.summary
  - MCP tool: thread_summary
  - Injected into system prompt (optional)
```

### Implementation

**New package:** `packages/summary/`

#### Core: `createSummaryService(deps)`

```typescript
interface SummaryServiceDeps {
  bus: EventBus
  dataDir: string // <dataDir>/summaries/
  inference: {
    baseUrl: string // ollama endpoint
    model: string // e.g. "qwen2.5:1.5b"
  }
  debounceMs: number // default: 5000 (batch rapid events)
  maxInputTokens: number // default: 2048 (truncate if needed)
  maxSummaryTokens: number // default: 512
}
```

**Event listener pipeline:**

1. Subscribe to `chat.turn` events on the bus
2. Extract: thread ID, role (user/assistant), content text, timestamp
3. Per-thread debounce — accumulate events for `debounceMs`, then fire summarization
4. On fire: read existing summary + new events → call local model → store updated summary

**Prompt template:**

```
You maintain a running summary of a conversation thread. Update the summary to incorporate the new messages below. Keep the summary under 200 words. Focus on: what the user asked for, what the agent did, current status, any pending items.

## Current Summary
{existing_summary}

## New Activity
{new_events}

## Updated Summary
```

**Storage:** One JSON file per thread:

```json
{
  "threadKey": "...",
  "summary": "User asked to fix the session resume bug...",
  "lastEventAt": 1786179204460,
  "eventCount": 42,
  "version": 3
}
```

**Inference client:** Reuse the same OpenAI-compatible client from Feature 1. Non-streaming (summary generation needs no streaming). Fire-and-forget with error logging (never blocks the main event loop).

#### API Surface

- `GET /api/threads/:id/summary` — returns the latest summary
- `WS channel: thread.summary` — pushes summary updates to connected clients
- `MCP tool: thread_summary` — available to agents for cross-thread context

#### Integration Points

- **Thread list UI** — show summary snippet alongside each thread
- **Presence digest** — feed summaries into the presence internal thread's digest instead of (or alongside) raw turn content
- **System prompt injection** (optional) — prepend thread summary to system prompt on session resume, giving the model immediate context without reading the full history
- **Resume orchestrator** — use summary as the continuation marker text (richer than the current fixed string)

### Config Shape

```json
{
  "summary": {
    "enabled": true,
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "qwen2.5:1.5b",
    "debounceMs": 5000,
    "maxSummaryWords": 200
  }
}
```

### Model Selection

Target: under 500ms per summary on the primary host's hardware.

| Model        | Size | Speed (est.) | Quality                                   |
| ------------ | ---- | ------------ | ----------------------------------------- |
| qwen2.5:0.5b | 0.5B | ~100ms       | Adequate for extraction, weak on nuance   |
| qwen2.5:1.5b | 1.5B | ~200ms       | Good balance — recommended starting point |
| phi-3-mini   | 3.8B | ~400ms       | Better quality, still fast enough         |
| gemma-2:2b   | 2B   | ~250ms       | Strong for its size                       |

Start with `qwen2.5:1.5b`. The service should hot-swap models via config without restart.

---

## Implementation Order

1. **Summary service first** — smaller scope, immediate value, validates the ollama integration pattern that Feature 1 reuses
2. **Local LLM backend Phase 1-2** — skeleton + built-in tools (the hard part)
3. **Local LLM backend Phase 3-4** — MCP integration + tool loop (the integration part)
4. **Local LLM backend Phase 5-6** — system prompts + session lifecycle (the polish)

Each phase ships independently and delivers value on its own.

---

## Open Questions (for Josh)

1. **Bash sandboxing** — how locked down should subagent shell access get? Same as Claude Code (permissive within cwd), or tighter (allowlist)?
2. **Model routing granularity** — per-membrane? Per-thread? Per-subagent-depth? Or just default + explicit override?
3. **Summary visibility** — should summaries appear in the thread UI, or stay backend-only (API/system-prompt injection)?
4. **Ollama vs vllm** — ollama runs now and handles tool calling. vllm gives better throughput for batch inference. Preference?
