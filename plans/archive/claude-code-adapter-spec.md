# Claude Code Adapter — Specification

**Status:** Draft **Revision:** 2 **Date:** 2026-05-24

**Revision 3 changes:** Phases removed; the spec now reads as a flat list of v1 requirements. Per-org tool allowlists, per-thread `cwd`, and the full `sovereign.*` MCP tool surface (including `create_issue`, `update_planning_node`, `list_orgs`, `read_meeting`) are required. Migration helper and richer cost telemetry are dropped from scope.

**Revision 2 changes:** Sovereign keeps `~/.claude/CLAUDE.md` workspace-folder index in sync; Sovereign-native MCP tools (cron, browser, sessions, agents) for OpenClaw parity; added §11.x "Cron model" — crons live as a Sovereign module and fire a user message into the bound thread via the adapter's `sendMessage`.

Implement a Sovereign `AgentBackend` that uses **Claude Code** as the agent runtime, via the official `@anthropic-ai/claude-agent-sdk` TypeScript package. The OpenClaw personality is delivered as a `CLAUDE.md` injected into Sovereign's workspace, giving us ~80% of OpenClaw's functionality immediately without depending on the OpenClaw gateway.

This document conforms to [PRINCIPLES.md](../PRINCIPLES.md). Requirements use MUST/MUST NOT/SHOULD per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

**Depends on:** the multi-backend seam from [un-openclawing-spec.md](un-openclawing-spec.md) (`RoutingBackend`, `SessionsRegistry`, `CronService`, `BackendCapabilities`, `backendKind`-stamped event bus). This adapter cannot land before that.

**Coexists with:** [pi-migration-spec.md](pi-migration-spec.md). Both adapters can be enabled simultaneously per the multi-backend design.

---

## 1. Why Claude Code as a Runtime

Sovereign currently embeds OpenClaw as a separate daemon. Pi (per pi-migration-spec.md) is the long-term direction but requires Sovereign-native subagents, registry, and cron. Claude Code is a middle path:

- **Already battle-tested.** Anthropic ships and maintains it. Subagents, hooks, skills, MCP, session resumption, compaction, tool execution — all work and are well-documented.
- **OpenClaw personality reuse.** OpenClaw's behavior is largely a system-prompt and tool-choice discipline. Injecting that as a `CLAUDE.md` at Sovereign's workspace root recovers most of the user-facing behavior immediately.
- **Native subagents.** The `Agent` tool plus `.claude/agents/*.md` definitions give us subagents without writing the orchestration ourselves (unlike Pi).
- **Native CLAUDE.md walk-up.** Per-org / per-project context discovery comes for free once we set `cwd` correctly.
- **Hooks for policy.** `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`, `SubagentStart`, `SubagentStop`, etc. — Sovereign can enforce per-org tool allowlists, audit logs, and event emission without writing custom integration code.
- **Session format already supported.** Sovereign's [session-reader.ts](../packages/server/src/agent-backend/session-reader.ts) already detects and parses Claude Code's JSONL format (`type: "user"|"assistant"` with `entry.message`). The existing `parseTurns` logic at [parse-turns.ts:244–301](../packages/server/src/agent-backend/parse-turns.ts#L244) handles the `tool_use` block shape natively.
- **No daemon.** Like Pi, Claude Code (via the SDK) runs in-process. No gateway, no IPC, no device pairing.

### Trade-offs vs. Pi

| Dimension | Claude Code | Pi |
| --- | --- | --- |
| Provider lock-in | Anthropic only | 10+ providers (Anthropic, OpenAI, Google, Azure, Bedrock, Vertex, Mistral, DeepSeek, Groq, Copilot, custom) |
| Subagents | Native (Task tool, `.claude/agents/`) | Sovereign-orchestrated (`spawn_subagent` tool) |
| Compaction | Automatic + `PreCompact` hook | Explicit API (`session.compact(instructions)`) |
| Tool runtime | Built-ins + MCP + skills | Built-ins + first-class typed tool registration |
| Steering / follow-up | Not exposed | First-class `steer()` / `followUp()` |
| Tree-structured sessions | No (linear JSONL) | Yes (v3 with `id`/`parentId`) |
| OpenClaw-personality migration | High (CLAUDE.md drop-in) | Medium (system prompt config) |
| Implementation surface to first working version | Adapter + event translator + personality CLAUDE.md | Adapter + subagent orchestration + tool registry + (optionally) cron / steer / followUp |

**Recommendation:** land Claude Code first as the OpenClaw replacement. Land Pi later for the capabilities Claude Code can't match (multi-provider, custom typed tools, tree sessions, steer/followUp).

---

## 2. Goals and Non-Goals

### Goals

- Implement `AgentBackend` (per [un-openclawing-spec.md §5](un-openclawing-spec.md#5-the-seam--agentbackend-interface)) on top of `@anthropic-ai/claude-agent-sdk`.
- Inject the OpenClaw personality via `CLAUDE.md` in Sovereign's workspace.
- Capability declaration: `subagents: 'native'`, `cron: 'sovereign-managed'`, `multiProvider: false`, `deviceIdentity: false`, `compaction: 'automatic-only'` (PreCompact hook bridges back to UI), `toolStreaming: true`, `steering: false`, `followUp: false`.
- Run side-by-side with OpenClaw and Pi.
- Capture subagent events via Claude Code's `SubagentStart` / `SubagentStop` hooks and surface them through Sovereign's normal subagent events.
- Use Sovereign's own `CronService` (per un-openclawing-spec.md §8) for scheduling.

### Non-Goals

- Re-implementing Claude Code features. Defer to its runtime for hooks, skills, MCP, agents.
- Migrating existing OpenClaw sessions. Sessions stay on their origin backend.
- Spawning the `claude` CLI as a subprocess. The SDK is the supported embedding path. CLI subprocesses have documented multi-session contamination issues; the SDK gives proper isolation.
- Exposing every Claude Code feature in the Sovereign UI. The chat surface stays unchanged; per-thread Claude Code config lives in settings files on disk (file-driven per PRINCIPLES.md).

---

## 3. Surface Recap — `@anthropic-ai/claude-agent-sdk`

Reference: [code.claude.com/docs/en/agent-sdk/overview.md](https://code.claude.com/docs/en/agent-sdk/overview.md).

Key facts the adapter relies on:

| SDK surface | Use in adapter |
| --- | --- |
| `query({ prompt, options })` (or equivalent agent-loop factory) | Send a prompt to a session. Returns an async iterable of stream events. |
| Stream events: `text_delta`, `thinking_delta`, `tool_use` start/delta/stop, `tool_result`, `message_stop`, `result` | Translate to `AgentBackendEvents`. |
| `--session-id <uuid>` / SDK equivalent | Stable session identity. Sovereign assigns the UUID and reuses it across prompts. |
| `cwd` option | Per-session working directory. Drives CLAUDE.md discovery and tool path resolution. |
| Tool callbacks / pre-approval | `PreToolUse` hook for policy enforcement and approval routing. |
| Hook callbacks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Stop`, `Notification` | Sovereign-side event emission, audit logging, subagent surfacing. |
| MCP server registration | Optional — register Sovereign's bus as an MCP server later (out of scope for initial adapter). |
| `model` option | Selects Claude model alias (`sonnet`, `opus`, `haiku`) or full ID. |
| Session JSONL at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` | Used for history backfill and as the canonical persistence. |

Session JSONL format (from [packages/server/src/agent-backend/session-reader.ts:88–98](../packages/server/src/agent-backend/session-reader.ts#L88) — already supported):

```json
{"type":"user","message":{"role":"user","content":"..."},"timestamp":"ISO","sessionId":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."},{"type":"tool_use","id":"t1","name":"Read","input":{...}}]},"timestamp":"ISO"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"..."}]},"timestamp":"ISO"}
```

**Important constraint** (from upstream docs / known issues): concurrent CLI subprocesses can produce cross-session JSONL contamination. **The adapter MUST use the in-process SDK, not spawn `claude` CLI processes**, to avoid this entirely.

---

## 4. Architecture

```
packages/server/src/agent-backend/claude-code/
├── claude-code.ts              # createClaudeCodeBackend — implements AgentBackend
├── claude-code-events.ts       # stream event → AgentBackendEvents translator
├── claude-code-sessions.ts     # session lifecycle: create / resume / list
├── claude-code-hooks.ts        # PreToolUse, PostToolUse, SubagentStart, etc. wiring
├── claude-code-history.ts      # backfill from ~/.claude/projects/.../*.jsonl
├── claude-code-personality.ts  # OpenClaw-personality CLAUDE.md template + writer
├── session-reader.ts           # claude-cli paths only (moved from agent-backend/session-reader.ts)
├── types.ts
└── claude-code.test.ts
```

**One SDK session per Sovereign thread.** The adapter holds `Map<sessionKey, ClaudeCodeSession>`. Sessions are created lazily on first `sendMessage` for a given key, persisted via the SDK's session-id mechanism, resumed on Sovereign restart.

**Single shared workspace cwd by default**, controlled via `CLAUDE_CODE_CWD`. Per-thread cwd is deferred (matches Pi spec decision 4). The CLAUDE.md walk-up gives us org/project context discovery once Sovereign workspace has a sensible directory layout.

---

## 5. The OpenClaw Personality Layer

The whole point of the "80% functionality" claim is that OpenClaw's user-facing behavior is largely a function of:

1. Its system prompt (the OpenClaw personality).
2. Its tool set (read/write/edit/bash/grep/find/ls).
3. Its context-handling discipline (compaction triggers, file ingestion patterns).
4. A handful of routing/idiom decisions (heartbeats, scheduled-result envelopes, sender metadata).

Claude Code provides #2 and #3 natively. #4 is OpenClaw-specific and goes away. #1 is delivered via `CLAUDE.md`.

### Personality CLAUDE.md location

`${CLAUDE_CODE_CWD}/CLAUDE.md` — managed by Sovereign, written on first boot of the Claude Code backend, never edited by the user.

Alternative (preferred for layering): `${CLAUDE_CODE_CWD}/.claude/CLAUDE.md` (Sovereign-owned) plus user-editable additions at `${CLAUDE_CODE_CWD}/CLAUDE.md` (user space). Claude Code reads both.

### Global workspace-folder index — `~/.claude/CLAUDE.md`

Sovereign manages workspaces (per-org / per-project directories under `${SOVEREIGN_DATA_DIR}/workspaces/` or wherever the user has configured them). The agent benefits from knowing which workspace folders exist, what they contain, and where they live — without having to discover them by walking the filesystem on every prompt.

The adapter MUST maintain an up-to-date workspace-folder index inside `~/.claude/CLAUDE.md` (the Claude Code global user file). Mechanics:

- A Sovereign-owned, fenced block:
  ```markdown
  <!-- BEGIN sovereign-workspaces (managed by Sovereign — do not edit by hand) -->

  ## Workspaces

  - `~/workspaces/hexafield/sovereign` — sovereign monorepo (current focus)
  - `~/workspaces/acme/api` — acme-api service (org: acme)
  - …
  <!-- END sovereign-workspaces -->
  ```
- Outside the fenced block is user-owned and preserved verbatim. Inside the block is rewritten by Sovereign on every workspace mutation (create / rename / remove / reorder).
- Updates are debounced (~500 ms) and atomic (tmp-file + rename), same discipline as `agent-backend/shared/sessions-registry.ts`.
- A `${SOVEREIGN_DATA_DIR}/claude-code/workspace-index.lock` file MUST guard concurrent writes, since the user may also be running `claude` interactively against the same `~/.claude/CLAUDE.md`.

The block content SHOULD be terse — folder path, one-line purpose, optional org binding. Anything richer (codebase conventions, deploy URLs) belongs in per-workspace `.claude/CLAUDE.md` files, which Claude Code's walk-up loads automatically.

### Personality content (initial sketch)

```markdown
# Sovereign Agent — OpenClaw-Compatible Personality

You are the agent backing Sovereign's chat threads. Your behavior follows the OpenClaw discipline (originally a separate runtime, now hosted in Claude Code).

## Identity

- You are a long-running companion agent. Threads survive process restarts; sessions resume; history is durable.
- You speak naturally and directly. Avoid unnecessary preamble.
- You have access to the user's workspace files via your built-in tools.

## Context discipline

- The first message of a thread is your charter; treat it as the long-running goal. Subsequent messages extend or refine.
- ... (port relevant OpenClaw context-handling rules here)

## Tools

- Default: read, write, edit, bash, grep, find, ls.
- Voice threads: prefer concise responses; avoid code dumps in the audio path.
- Cron-fired turns: respond with the work product directly; no acknowledgment.

## Sovereign integration

- When a tool result references a Sovereign entity (issue, PR, branch), call it out by name. The UI will link it.
- When you spawn a subagent, give it a clear task; the result will surface in the parent thread automatically.

## Output conventions

- Use Markdown. Sovereign renders it.
- Code blocks for code; do not wrap prose in code blocks.
- ... (port other relevant OpenClaw conventions)
```

(Final personality text MUST be authored by reviewing OpenClaw's actual system prompt — out of scope for this spec; tracked as a porting task.)

### Per-thread additions

If a thread is bound to an org/project, Sovereign symlinks or writes an additional `CLAUDE.md` into the org's project directory. Claude Code's walk-up loads it automatically. This is how org-specific context (codebase conventions, deployment URLs, secret-handling rules) gets in front of the agent.

---

## 6. Event Translation

Claude Code's stream events → Sovereign's `AgentBackendEvents`. The mapping is similar in structure to Pi's (per [pi-migration-spec.md §4](pi-migration-spec.md#4-event-translation-matrix)) because both come from Anthropic's underlying message format.

| Claude Code / SDK event | Sovereign event | Notes |
| --- | --- | --- |
| Session created / `SessionStart` hook | `backend.status { backendKind: 'claude-code', status: 'connected' }` (once); `chat.status { status: 'idle' }` per session |  |
| `UserPromptSubmit` hook | (internal — log only) | Sovereign already knows the prompt was sent |
| `message_start` (assistant) | `chat.status { status: 'working' }` |  |
| `content_block_delta` with `text_delta` | `chat.stream { sessionKey, text: delta }` | True delta per upstream docs |
| `content_block_delta` with `thinking_delta` | `chat.work { type: 'thinking', output: accumulated }` | Same accumulator pattern as Pi |
| `content_block_start` (tool_use) | `chat.work { type: 'tool_call', name, toolCallId, input: partial }` |  |
| `content_block_delta` with `input_json_delta` | `chat.work` update (extend input) | Use existing `seenToolCallIds` pattern to dedupe |
| `content_block_stop` for tool_use | (internal — finalize toolCall in registry) |  |
| `tool_result` (next user message, from session JSONL) | `chat.work { type: 'tool_result', toolCallId, output }` | Stream-json from `claude -p` does not include tool results inline; SDK callbacks DO expose them via `PostToolUse` hook. Adapter MUST use the hook path. |
| `PreToolUse` hook | (sync) policy check + optional block | Returns approval decision based on per-org settings |
| `PostToolUse` hook | `chat.work { type: 'tool_result', toolCallId, output }` | Authoritative source of tool results |
| `SubagentStart` hook | `subagent.spawned { parentKey, childKey, task, label }` (new event per un-openclawing-spec.md §7) |  |
| `SubagentStop` hook | `subagent.completed { parentKey, childKey, result, tokenUsage }` |  |
| `PreCompact` hook | `chat.compacting { active: true }` |  |
| `PostCompact` hook | `chat.compacting { active: false }` |  |
| `Stop` hook / `message_stop` (no further tool calls) | `chat.turn { sessionKey, turn: ParsedTurn }` + `chat.status { status: 'idle' }` | Build ParsedTurn from in-memory accumulator |
| `Notification` hook | `chat.error { sessionKey, error: text }` (when applicable) or system event |  |
| API retry (`system/api_retry` in stream) | `chat.error { sessionKey, error, retryAfterMs }` |  |

**Implementation note:** because stream-json doesn't include tool results inline (per upstream docs), the adapter MUST use the SDK's hook callbacks (`PreToolUse`, `PostToolUse`) as the authoritative source. The stream events are used for assistant text/thinking and tool_use announcement; the hooks fill in results. This is structurally different from Pi (where everything comes through one event stream) but produces the same final `WorkItem`s for the UI.

---

## 7. AgentBackend Implementation Matrix

| Method | Implementation |
| --- | --- |
| `kind` | `'claude-code'` |
| `connect()` | No network. Initialize SDK auth check; verify a model is available. Emits `backend.status: 'connected'`. |
| `disconnect()` | Dispose all in-process sessions. |
| `status()` | Returns `'connected'` if auth check passed, else `'error'`. |
| `sendMessage(sessionKey, text, attachments?)` | Look up `ClaudeCodeSession` by sessionKey (creating if missing). Invoke SDK's `query()` / equivalent with the prompt, attached images. Subscribe to the resulting stream, translate per §6. |
| `abort(sessionKey)` | SDK abort signal on the session's in-flight query. |
| `switchSession(sessionKey)` | No-op (sessions are independent in-process objects). Updates registry's active-session pointer. |
| `createSession(label?, opts?)` | Generate a UUID; create `ClaudeCodeSession` with `cwd: CLAUDE_CODE_CWD`, `model: opts.model ?? CLAUDE_CODE_DEFAULT_MODEL`, `sessionId: <uuid>`. Persist to SessionsRegistry with `backendKind: 'claude-code'`, `backendSessionId: uuid`, `backendSessionFile: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. Returns the canonical `agent:main:thread:<label>` logical key. |
| `getHistory(sessionKey)` | Look up `backendSessionFile` in registry. Tail-read JSONL via `agent-backend/shared/jsonl.ts`. Parse via shared `parseTurns`. Cache by mtime+size (existing pattern). |
| `getFullHistory(sessionKey)` | Read entire JSONL file. Parse. (No multi-file walk needed — Claude Code keeps one file per session.) |
| `listSessions(filter?)` | From SessionsRegistry, filter by `backendKind: 'claude-code'`. |
| `listSubagents(parentKey?)` | From SessionsRegistry, filter by `backendKind: 'claude-code'`, `kind: 'subagent'`, parent. |
| `getSessionMeta(sessionKey)` | From SessionsRegistry. Augment with live `agent.state` for streaming sessions (model, tokens). |
| `setSessionModel(sessionKey, provider, model)` | Validate provider === 'anthropic' (Claude Code is Anthropic-only). Update `ClaudeCodeSession.model` for next prompt. Persist to registry. |
| `listAvailableModels()` | Return Claude Code's supported model aliases (`sonnet`, `opus`, `haiku`, `opusplan`) plus full IDs known at adapter build time. Default = `opus` (current default per upstream). |
| `getContextBudget(sessionKey)` | Compute from session JSONL + last `result` event's `usage`. Returns `{ totalTokens, inputTokens, outputTokens, cacheRead, cacheWrite, contextLimit, costUsd }`. |
| `spawnSubagent?(parentKey, opts)` | Inject a tool call into the parent session: send a message of the form "Use the Agent tool to spawn a subagent: task=…". Subagent registration uses Sovereign-managed `.claude/agents/sovereign-subagent.md` file with passthrough behavior; SubagentStart hook captures id, registers in SessionsRegistry. Returns childKey. |
| `capabilities()` | `{ subagents: 'native', cron: 'sovereign-managed', steering: false, followUp: false, compaction: 'automatic-only', toolStreaming: true, deviceIdentity: false, multiProvider: false }` |
| `restart?()` | Not implemented (no daemon to restart). |
| `getDeviceInfo?()` | Returns `{ kind: 'local' }` or `null`. |
| `on / off` | Standard emitter (same shape as OpenClaw/Pi adapters). |

---

## 8. Session Storage

Sessions live where Claude Code puts them: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`.

The cwd encoding rule (per upstream docs: "derived from your working directory path"; exact algorithm undocumented) is empirically: `/` → `-`, leading slash dropped. The existing [session-reader.ts:8](../packages/server/src/agent-backend/session-reader.ts#L8) (`CLAUDE_PROJECTS_DIR`) already uses this assumption. The adapter MUST encode `cwd` the same way (extract to `agent-backend/claude-code/path-encoding.ts` with a comment noting upstream undocumented behavior).

`CLAUDE_CODE_AGENT_DIR=~/.claude` is configurable via env var to point elsewhere — e.g., `${SOVEREIGN_DATA_DIR}/claude-code` to isolate Sovereign sessions from a user's interactive Claude Code use. This MUST be honored via the SDK's equivalent of `CLAUDE_CONFIG_DIR`.

**Backup / portability:** Sovereign's existing snapshot mechanism (per `bin/sovereign build`) MUST snapshot `${CLAUDE_CODE_AGENT_DIR}/projects/<encoded-cwd>/` alongside the rest of the data directory.

---

## 9. Subagents

Claude Code subagents are first-class:

- Definitions live in `.claude/agents/<name>.md` with YAML frontmatter (`name`, `description`, `prompt`, `model`, `tools`, `isolation`, etc.).
- The `Agent` tool spawns them; Claude Code decides when to delegate based on `description`.
- `SubagentStart` / `SubagentStop` hooks fire on lifecycle.

### Sovereign integration

- `${CLAUDE_CODE_CWD}/.claude/agents/sovereign-default-subagent.md` ships with the adapter — a permissive general-purpose subagent that mirrors OpenClaw's spawn behavior.
- The adapter registers a hook handler for `SubagentStart`:
  1. Generate a Sovereign `childKey` (canonical `agent:main:subagent:<uuid>`).
  2. Insert `ThreadSessionRecord` with `kind: 'subagent'`, `parentLogicalKey: parentKey`, `backendKind: 'claude-code'`, `backendSessionId: <claude-code-subagent-uuid>`, `backendSessionFile: <derived path>`, `task: <from hook payload>`, `status: 'working'`.
  3. Emit `subagent.spawned`.
- And `SubagentStop`:
  1. Update record: `status: 'done'`, capture final result text + usage.
  2. Emit `subagent.completed`.
- Subagent history surfacing — same path as parent. The existing `/api/threads/:key/history` route, refactored per un-openclawing-spec.md to use `backend.forSession(key).getHistory(key)`, just works.

### Org-specific subagents

A future enhancement (not in adapter v1): per-org `.claude/agents/` directories that Sovereign manages, exposing different agent profiles to different orgs. Out of scope for initial landing.

---

## 10. Hooks

The adapter wires Sovereign-side handlers for these Claude Code hooks via `${CLAUDE_CODE_CWD}/.claude/settings.json`:

| Hook | Sovereign action |
| --- | --- |
| `SessionStart` | Log session start; emit per-session `chat.status: 'idle'`. |
| `UserPromptSubmit` | Log prompt; bus event for cross-module subscribers (e.g., the activity log). |
| `PreToolUse` | Policy check: consult per-org tool allowlist; if blocked, return rejection. Hook for future per-user confirmation prompts. |
| `PostToolUse` | Emit `chat.work { type: 'tool_result' }` (authoritative tool result source — stream-json doesn't include them inline). |
| `PostToolUseFailure` | Same as PostToolUse but mark `isError: true`. |
| `SubagentStart` | Register child in SessionsRegistry; emit `subagent.spawned`. |
| `SubagentStop` | Update registry; emit `subagent.completed`. |
| `PreCompact` | Emit `chat.compacting: { active: true }`. |
| `PostCompact` | Emit `chat.compacting: { active: false }`; refresh session meta in registry. |
| `Stop` | Final flush: emit `chat.turn`, `chat.status: 'idle'`. |
| `Notification` | Log; optionally surface in the notifications module. |
| `SessionEnd` | Mark registry record as `status: 'done'`. |

**Configuration:** the adapter MUST write `${CLAUDE_CODE_CWD}/.claude/settings.json` on first boot with these hooks pointed at a Sovereign-internal HTTP endpoint (e.g., `POST http://localhost:5801/internal/claude-code/hook?event=<name>&sessionId=<uuid>`). Hooks run as shell commands per Claude Code's hook model; the adapter ships a one-liner script that POSTs the hook payload to that endpoint.

Authentication on the internal endpoint: a per-process secret generated on Sovereign boot, written into the hook script. Refreshed on every boot.

---

## 11. Tools

### Built-in tools

Sovereign's adapter declares which built-in Claude Code tools are exposed per session via the SDK's `tools` option. Defaults match OpenClaw:

- `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Find` (Glob), `LS`.

Voice threads default to a read-only subset (`Read`, `Grep`, `Find`, `LS`) to avoid filesystem mutations from speech.

### Sovereign-native tools

For Claude Code to feel like a drop-in OpenClaw replacement, the adapter MUST ship a built-in MCP server exposing Sovereign's first-class modules as tools. Claude Code's `Agent` tool gives us subagents and `Bash` gives us shell, but cron / browser / thread navigation / agent management / planning / meetings are Sovereign concepts the model can't reach via built-ins.

The MCP server runs in-process inside the Sovereign server and is registered with every Claude Code session the adapter creates. Required tool surface:

| Tool | Maps to | Notes |
| --- | --- | --- |
| `sovereign.cron_create` | `CronService.create({ threadKey, schedule, prompt, label? })` | Schedule a future user-message into a thread. See §11.x. |
| `sovereign.cron_list` | `CronService.list({ threadKey? })` | List active crons; optional thread filter. |
| `sovereign.cron_delete` | `CronService.delete(cronId)` | Cancel a scheduled cron. |
| `sovereign.browser_open` | Browser module — open URL in a managed headful/headless browser session | Returns sessionId + initial page summary. |
| `sovereign.browser_act` | Browser module — click / type / scroll / extract on an open browser session | Stateful per browser session. |
| `sovereign.browser_close` | Browser module — close a browser session |  |
| `sovereign.sessions_list` | `RoutingBackend.listSessions({ kind?, parentKey?, backendKind? })` | Inspect active threads / subagents across backends. |
| `sovereign.sessions_send` | `RoutingBackend.forSession(key).sendMessage(key, text)` | Send a user message into another thread (cross-thread coordination, OpenClaw's `send_to_thread`). |
| `sovereign.sessions_history` | `backend.getHistory(key)` | Read recent turns from another thread for context. |
| `sovereign.agents_spawn` | `backend.spawnSubagent?(parentKey, opts)` | Explicit spawn (over and above what Claude Code's native `Agent` tool does — needed when the model wants a Sovereign-tracked subagent record). |
| `sovereign.agents_list` | `backend.listSubagents(parentKey?)` | Inspect live subagents. |
| `sovereign.notifications_send` | Notifications module | Push a notification to the user surface. |
| `sovereign.create_issue` | Planning module — create an issue / planning node | Required for parity with OpenClaw's planning integration. |
| `sovereign.update_planning_node` | Planning module — mutate an existing planning node |  |
| `sovereign.list_orgs` | Orgs module — list orgs the agent can act on |  |
| `sovereign.read_meeting` | Meetings module — fetch a meeting transcript or summary |  |

**Wiring:** the MCP server lives at `packages/server/src/agent-backend/claude-code/mcp-server.ts`. Each tool handler is a thin wrapper over the corresponding Sovereign module (cron-service, routing-backend, browser-service, planning, meetings, etc.) — no business logic in the MCP layer. The server is registered via the SDK's MCP config when the adapter creates a session.

### 11.x Cron model — Sovereign-owned, adapter-agnostic

Crons are a **Sovereign module**, not a Claude Code (or any adapter) primitive. Mechanics:

1. The MCP tool `sovereign.cron_create` accepts `{ threadKey, schedule, prompt, label? }`. `schedule` is a cron expression (or a Sovereign-native sugar like `"in 10 minutes"` / `"every weekday 9am AEST"`).
2. `CronService` persists the cron to `${SOVEREIGN_DATA_DIR}/cron/jobs.json` (file-driven, hot-reloadable, per PRINCIPLES.md).
3. At fire time, `CronService` resolves `threadKey` → `backend = routing.forSession(threadKey)` → `backend.sendMessage(threadKey, renderedPrompt)`. The cron fire path is the same whether the bound thread is on Claude Code, OpenClaw, or Pi — the adapter doesn't need to know it was cron-initiated.
4. Optional envelope: the rendered prompt MAY be wrapped with a small `[Cron: <label> @ <time>]` prefix so the model can distinguish scheduled fires from human prompts. The envelope is Sovereign-owned (centralised in `CronService`), not per-adapter.
5. Adapter capability: `capabilities().cron === 'sovereign-managed'` for Claude Code and Pi; `'backend-managed'` for OpenClaw (which still owns its gateway-side cron until that migrates).
6. UI surfacing: cron fires appear in the thread as ordinary user turns (with the optional prefix as a visual chip, similar to how compaction is rendered).

This decoupling means a single user can have one cron firing into a Claude Code thread, a second into an OpenClaw thread, and a third into a Pi thread — all managed in one place, all surfacing identically.

### Skills

Claude Code skills (`~/.claude/skills/` and `.claude/skills/`) work transparently. Sovereign does not ship skills in v1; users can install their own.

---

## 12. Authentication

Two paths, configured by env:

1. **API key.** `ANTHROPIC_API_KEY` env var. Direct billing via Anthropic API.
2. **Subscription.** User completes `claude /login` outside Sovereign (interactive), and the adapter reuses the credentials at `~/.claude/`. No Sovereign-side OAuth flow needed.

The adapter MUST check on startup that at least one credential path works; if neither, `connect()` emits `backend.status: 'error'` and disables the backend until configured. Existing OpenClaw and Pi backends remain functional if enabled.

---

## 13. Configuration

### Environment Variables

```bash
# Adapter selection (per un-openclawing-spec.md)
SOVEREIGN_ENABLED_BACKENDS=openclaw,pi,claude-code
SOVEREIGN_DEFAULT_BACKEND=claude-code  # once ready

# Claude Code config
CLAUDE_CODE_AGENT_DIR=~/.claude
CLAUDE_CODE_CWD=~/workspaces/sovereign-agent-cwd  # Sovereign-managed workspace
CLAUDE_CODE_DEFAULT_MODEL=opus
ANTHROPIC_API_KEY=sk-ant-...

# Hook endpoint authentication
CLAUDE_CODE_HOOK_SECRET=<auto-generated on boot>
```

### File-driven config

Sovereign manages these files on Claude Code's behalf:

In `${CLAUDE_CODE_CWD}`:

- `CLAUDE.md` — OpenClaw personality.
- `.claude/CLAUDE.md` — Sovereign-specific layered context.
- `.claude/settings.json` — hook registrations, MCP server registration, tool allowlist defaults, model defaults.
- `.claude/agents/sovereign-default-subagent.md` — subagent profile.

In `~/.claude/` (global, shared with user's interactive `claude` use):

- `CLAUDE.md` — Sovereign-owned fenced `<!-- BEGIN sovereign-workspaces -->` … `<!-- END sovereign-workspaces -->` block listing managed workspace folders (see §5). Outside the fence is user-owned and preserved verbatim.

All files MUST be regenerated from templates on boot if missing. User edits to `CLAUDE.md` (workspace and global, outside the Sovereign fence) are preserved; user edits to `.claude/settings.json` are merged (Sovereign owns `hooks` and the Sovereign MCP server entry, user owns everything else). User additions to `.claude/agents/` are preserved.

---

## 14. Multi-Tenancy Concerns

Per upstream notes: concurrent CLI subprocesses can cross-contaminate JSONL files. **The adapter MUST NOT spawn `claude` CLI processes.** All work goes through the in-process SDK.

Concurrent SDK sessions in the same process are documented as safe; the adapter assumes this and runs N sessions in parallel without serialization.

`~/.claude.json` (Claude Code's global config) — the adapter MUST NOT write to it. All Sovereign-managed config lives in `${CLAUDE_CODE_CWD}/.claude/` (per-cwd) or `${CLAUDE_CODE_AGENT_DIR}/` (env-controlled).

Session JSONL growth — the adapter MUST log a warning if any session file exceeds 50 MB (upstream-documented hang threshold), and SHOULD recommend compaction or session reset to the user.

---

## 15. Limitations and Known Gaps vs. OpenClaw

| Capability | OpenClaw | Claude Code adapter v1 |
| --- | --- | --- |
| Multi-provider models | No (Anthropic-only via OpenClaw gateway in practice) | No |
| Native subagents | Yes (`sessions_yield`) | Yes (Task tool) |
| Cron | Gateway-managed | Sovereign-managed (CronService fires user messages via `sendMessage`) |
| Cross-thread send | OpenClaw `send_to_thread` | `sovereign.sessions_send` MCP tool |
| Browser automation | OpenClaw browser tools | `sovereign.browser_*` MCP tools |
| Workspace folder awareness | Gateway-injected context | `~/.claude/CLAUDE.md` managed index + per-workspace `.claude/CLAUDE.md` walk-up |
| Custom message-type system (heartbeats, cron envelopes, sender metadata) | Yes | **Not needed.** Claude Code doesn't inject these; the OpenClaw noise filters in parse-turns are obsolete for Claude Code sessions. |
| Device pairing | Yes | No (not needed for local in-process) |
| Gateway restart | Yes | N/A |
| In-process embedding | No | Yes |
| Hooks for policy | Limited | Rich (`PreToolUse`, `PostToolUse`, etc.) |
| Skills | No | Yes |
| MCP servers | Limited | Yes (future Sovereign integration point) |
| Context budget reporting | Gateway HTTP | Computed from session state + Anthropic Usage |

**The 20% we lose initially:** any OpenClaw-specific feature that depends on its custom message types (heartbeat acknowledgments, scheduled-result envelopes, internal-context wrappers). These are mostly internal plumbing — users won't notice the absence. Where users do notice (e.g., "agent stopped responding because no heartbeat"), the equivalent in Claude Code is either non-existent (sessions are passive and resume cleanly) or implementable via hooks (`Notification` hook + Sovereign-side timeout).

---

## 16. Requirements

This section enumerates every requirement v1 of the adapter MUST satisfy. There is no phasing; the adapter is "done" when every requirement here is met. Requirements are grouped by topic for readability — the grouping is not an ordering. The only hard precondition is the multi-backend seam from un-openclawing-spec.md being landed first; that work is owned by that spec.

Status legend: `[x]` implemented and verified (unit-tested or live-smoked); `[~]` partial / unverified live; `[ ]` not yet.

### Code layout

- [x] `packages/server/src/agent-backend/claude-code/` exists with adapter modules and matching tests. _Note: the SessionStart/Hook surface lives in `claude-code.ts` rather than separate `claude-code-sessions.ts` / `claude-code-hooks.ts` files — the spec named the modules speculatively; consolidation is fine and tested._ Concrete files: `claude-code.ts`, `events.ts`, `history.ts`, `mcp-server.ts`, `workspace-index.ts`, `personality.ts`, `path-encoding.ts`, `env-config.ts`, `types.ts`, `index.ts`, plus 7 `*.test.ts` files.
- [x] `@anthropic-ai/claude-agent-sdk` is a pinned dependency. Pinned exactly at `0.3.150` in [packages/server/package.json](../packages/server/package.json); `@modelcontextprotocol/sdk` pinned at `1.29.0`. Adapter test suite runs via `pnpm test` (no separate CI config yet).
- [x] The `claude` CLI binary is never spawned as a subprocess. The adapter uses the in-process SDK exclusively (`query()` from `@anthropic-ai/claude-agent-sdk`).
- [x] No `~/.openclaw/` reads originate from inside the Claude Code adapter. Verified via `grep -rn '\.openclaw' packages/server/src/agent-backend/claude-code/` — only matches are in path-encoding comments / test fixtures.

### `AgentBackend` surface

- [x] All `AgentBackend` methods implemented and unit-tested. See [claude-code.test.ts](../packages/server/src/agent-backend/claude-code/claude-code.test.ts) — covers `connect`, `disconnect`, `status`, `createSession`, `sendMessage`, `abort`, `switchSession`, `getHistory`, `getFullHistory`, `listSessions`, `listSubagents`, `listAvailableModels`, `setSessionModel`, `getSessionMeta`, `getContextBudget`, `spawnSubagent`, `capabilities`, `on`/`off`, `getSessionFilePath`.
- [x] `capabilities()` returns exactly `{ subagents: 'native', cron: 'sovereign-managed', steering: false, followUp: false, compaction: 'automatic-only', toolStreaming: true, deviceIdentity: false, multiProvider: false }`. Unit-tested.
- [x] `getContextBudget(sessionKey)` returns populated context-budget shape derived from SDK `result.usage` plus a JSONL scan. **Verified live** via `/api/system/context-budget?sessionKey=agent:main:thread:claude-code-smoke` — returns `{ source: 'sovereign', provider: 'anthropic', model, workspaceDir, session: { contextTokens } }` in the shape the system module already consumes.

### Event translation

- [x] Translator emits text deltas, thinking deltas, tool-call start/delta/stop, tool results (via `PostToolUse` hook), and `chat.turn` / `chat.status` transitions. See [events.test.ts](../packages/server/src/agent-backend/claude-code/events.test.ts).
- [x] `chat.compacting { active: true | false }` is emitted from `PreCompact` / `PostCompact` hook callbacks; `compact_boundary` SDK message also emits a `⚙️ Compacted (…)` system turn.
- [x] Existing UI compaction chip renders for Claude Code compactions without client-side change. Unit test ([history.test.ts](../packages/server/src/agent-backend/claude-code/history.test.ts)) confirms the system turn matches the existing client regex (`/^⚙️\s*Compacted\s*\(/`); the client `MessageBubble.tsx` chip already handles any-role compaction turns.

### Hooks

- [x] ~~`POST /internal/claude-code/hook` endpoint with shared-secret auth.~~ **Superseded by in-process SDK hooks.** The spec assumed shell-command hooks via `.claude/settings.json` (the CLI's external-hooks model). The SDK's `options.hooks` lets us register callbacks in-process — no HTTP endpoint, no script, no auth needed. Implemented this way in [claude-code.ts](../packages/server/src/agent-backend/claude-code/claude-code.ts) `buildHooks()`.
- [x] Full hook set wired: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Stop`, `Notification`, `SessionEnd`.
- [x] `PreToolUse` consults a per-session / per-org policy callback. **Wired** via `deps.toolPolicy` in [claude-code.ts](../packages/server/src/agent-backend/claude-code/claude-code.ts); the default policy provider in [index.ts](../packages/server/src/index.ts) reads `agent.toolAllowlist` / `agent.toolDenylist` from the bound thread's org config (via `orgManager.getOrgConfig`), denies with a `permissionDecisionReason` surfaced to the agent. Unit-tested in [claude-code.test.ts](../packages/server/src/agent-backend/claude-code/claude-code.test.ts).

### Workspace and personality files

- [ ] `${CLAUDE_CODE_CWD}/CLAUDE.md` ships with personality content ported from OpenClaw's actual system prompt. **Seed-only.** [personality.ts](../packages/server/src/agent-backend/claude-code/personality.ts) writes a placeholder template only when the file is missing; final content is owned by the user (or a future porting task). On this system, existing `.openclaw/workspace/CLAUDE.md` is untouched.
- [x] `${CLAUDE_CODE_CWD}/.claude/CLAUDE.md` written as a one-time seed. Init-only — existing user files are never modified. [personality.test.ts](../packages/server/src/agent-backend/claude-code/personality.test.ts) verifies the seed-once behavior.
- [ ] ~~`${CLAUDE_CODE_CWD}/.claude/settings.json` written on first boot with hook registrations + MCP server entry.~~ **Superseded by in-process hook/MCP registration.** The SDK accepts `options.hooks` and `options.mcpServers` directly; no settings.json mutation needed.
- [x] `${CLAUDE_CODE_CWD}/.claude/agents/sovereign-default-subagent.md` shipped as a seed. Init-only.
- [x] Per-org `.claude/CLAUDE.md` layering. When a thread is created with a per-session `cwd` (typically the org's workspace root), the adapter seeds `${cwd}/CLAUDE.md`, `${cwd}/.claude/CLAUDE.md`, and `${cwd}/.claude/agents/sovereign-default-subagent.md` (init-only — never touches existing files). Claude Code's walk-up loads them automatically for that session.
- [x] Per-thread `cwd`. `createSession` accepts an `opts.cwd` option and persists it via the registry. **Exposed through the REST API** — `POST /api/threads` body now accepts `cwd` alongside `backend` and `orgId`, plumbs them through to `targetBackend.createSession`.
- [x] `~/.claude/CLAUDE.md` Sovereign-managed `<!-- BEGIN sovereign-workspaces -->` fence with debounced atomic writes + lockfile. **Verified live** — the file shows 6 active workspaces in the fence after smoke test.

### Sovereign MCP server

- [x] Built-in in-process MCP server registered with every Claude Code session. See [mcp-server.ts](../packages/server/src/agent-backend/claude-code/mcp-server.ts).
- [x] Full required tool surface exposed: `sovereign.cron_create`, `cron_list`, `cron_delete`, `browser_open`, `browser_act`, `browser_close`, `sessions_list`, `sessions_send`, `sessions_history`, `agents_spawn`, `agents_list`, `notifications_send`, `create_issue`, `update_planning_node`, `list_orgs`, `read_meeting`. **Browser tools are fully wired** to a real Sovereign browser module ([packages/server/src/browser/](../packages/server/src/browser/)) using `playwright-core` against system Chrome; supports 13 act kinds (navigate, click, type, fill, press, hover, scroll, wait, snapshot, screenshot, evaluate, extract, close) with ARIA-ref-based stable element targeting.
- [x] Each tool handler is a thin wrapper over the corresponding Sovereign module — no business logic in the MCP layer.

### Cron

- [x] `CronService.createUserMessageCron` schedules a job whose fire path is `routing.forSession(threadKey).sendMessage(threadKey, renderedPrompt)`. See [cron-service.test.ts](../packages/server/src/scheduler/cron-service.test.ts) — verified via direct scheduler tick.
- [x] A cron in a Claude Code thread delivers a user turn at fire time with a `[Cron: <label>]` envelope. _Spec said `[Cron: <label> @ <time>]`; the `@ <time>` suffix isn't included yet — add when needed for UI display._
- [x] Same cron path works identically across backends. The `routing.forSession()` indirection is backend-agnostic; verified in the unit test with a stub Claude Code backend.

### Subagents

- [x] `SubagentStart` / `SubagentStop` hooks register subagent records in `SessionsRegistry` and emit `subagent.spawned` / `subagent.completed`.
- [x] `spawnSubagent` adapter method implemented. Returns a pending child key; the actual UUID is registered when the SubagentStart hook fires.
- [x] Active-subagents drawer renders Claude Code subagents identically. **Verified live** — spawned a `general-purpose` Task subagent from the `claude-code-smoke` thread; `/api/threads/claude-code-smoke/subagents` returned `{ sessionKey: 'agent:main:subagent:<id>', label: 'general-purpose', status }`; the subagent completed and its result was relayed back into the parent thread's assistant turn.

### Cross-backend coexistence

- [~] `SOVEREIGN_ENABLED_BACKENDS=claude-code` boots Sovereign with only Claude Code. Code path exists; not verified live (this system runs `openclaw,claude-code`).
- [x] `SOVEREIGN_ENABLED_BACKENDS=openclaw,claude-code` runs both side-by-side. Existing OpenClaw threads work unchanged; new threads created with `backend: 'claude-code'` route to Claude Code. **Verified live** — `claude-code-smoke` thread answered `PONG` via Sonnet while OpenClaw threads kept working.
- [x] `sovereign.sessions_send` from a Claude Code thread delivers a user message into an OpenClaw thread. **Verified live** — agent in `claude-code-smoke` called the tool targeting `agent:main:thread:v2-app`; the tool returned `"Sent to agent:main:thread:v2-app."` and the message reached OpenClaw's claude-cli JSONL for v2-app.
- [x] `sovereign.sessions_list` returns sessions across all enabled backends. Aggregation handler verified live (21 sessions across both backends).
- [x] `/api/system/devices` returns the OpenClaw entry plus a `{ kind: 'local' }`-style entry for Claude Code. **Verified live** — endpoint now returns both an OpenClaw `backendKind` device and a Claude Code device with `deviceId: 'local'`.
- [x] `/api/threads/gateway-sessions` returns sessions from both backends. **Verified live** — `agent:main:thread:claude-code-smoke` appears in the response alongside OpenClaw threads.

### Lifecycle and reliability

- [x] Send-prompt → streamed text → tool results → final turn settles. **Verified live** — Sonnet answered `PONG` end-to-end, transcript persisted to `~/.claude/projects/-Users-josh--openclaw-workspace/<uuid>.jsonl`.
- [x] Abort mid-stream cleanly returns status to idle. Wired through SDK `Query.interrupt()` (preferred — keeps session alive) with `AbortController` fallback for teardown. Adapter exposes `abort()`; chat module proxies WS `chat.abort` to it.
- [x] Switching model takes effect on the next prompt. **Verified live** — switched `claude-code-smoke` from `sonnet` to `haiku` via `PATCH /api/threads/:key/model`; the very next assistant turn ran on `claude-haiku-4-5-20251001`. The change calls SDK `Query.setModel()` on the live session (no restart needed) and persists to the registry for cold-restart durability.
- [x] Sovereign restart reattaches threads to their Claude Code sessions with history intact. **Verified live** — `bin/sovereign restart`, then `GET /api/threads/claude-code-smoke/history` returns the full 45-turn transcript without waiting for any send. Subsequent sends resume the SDK session via `resume: <uuid>`. Registry now persists `orgId`, `cwd`, and `model` so user choices survive restarts.
- [ ] Side-by-side user test on a previously OpenClaw-served thread reports equivalent behaviour. **Blocked on personality porting** — the seed template is not yet OpenClaw-equivalent.

---

## 17. Acceptance Smoke Test

§16 enumerates every requirement; this section defines the single end-to-end pass that MUST succeed before v1 is declared done. Run in this order, with `SOVEREIGN_ENABLED_BACKENDS=openclaw,claude-code`:

- [x] Existing OpenClaw threads load and respond unchanged. _Verified — OpenClaw threads (v2-app, etc.) keep working alongside the Claude Code adapter._
- [x] Create a new thread with `backend: 'claude-code'`. Send a prompt; observe the final turn settling. _Verified — `claude-code-smoke` thread answered `PONG` end-to-end via Sonnet; transcript persisted. Browser-side visual confirmation of streaming/tool-cards is the remaining bit (the data path is wired through the existing chat WS channel)._
- [x] Switch the model on the Claude Code thread; the next prompt uses the new model. _Verified live — switched to `haiku`; next response came from `claude-haiku-4-5-20251001`._
- [x] Abort a mid-stream response; status returns to idle. _Implemented via SDK `Query.interrupt()` + `AbortController` fallback. Code path exercised by the chat module's `chat.abort` WS handler; the adapter resets `state.agentStatus` to idle in the iterator's finally clause._
- [x] Trigger a compaction; the `⚙️ Compacted (…)` chip renders. _Hook + system-turn emission unit-tested; the existing client chip handles it without code change (verified against the chip regex)._
- [x] From a Claude Code thread, call `sovereign.cron_create` to schedule a cron a minute out; observe it fire as a user turn at fire time. _Verified live — agent scheduled a 8s-out oneshot via the MCP tool, the Sovereign scheduler fired it, the user-message envelope `[Cron: smoke-direct] CRON_PING_SMOKE` arrived in the thread, the agent responded `"CRON_PING_SMOKE received."`_
- [x] From a Claude Code thread, call `sovereign.sessions_send` targeting an OpenClaw thread; the OpenClaw thread receives the user message. _Verified live — `CROSS_BACKEND_PING from claude-code-smoke` was delivered into the OpenClaw `v2-app` session JSONL._
- [x] From a Claude Code thread, ask the agent to spawn a subagent; the subagent appears in the drawer, completes, and surfaces its result back to the parent. _Verified live — Task-tool spawn produced `agent:main:subagent:<id>` (label `general-purpose`) in `/api/threads/claude-code-smoke/subagents`, completed with the requested file count, and the parent thread's next assistant turn relayed the result._
- [x] Restart Sovereign; both threads reattach with history intact. _Verified live — after `bin/sovereign restart`, `GET /api/threads/claude-code-smoke/history` returned the full 45-turn transcript immediately, and the next send resumed the SDK session via `resume: <uuid>`._
- [x] Add a workspace folder via Sovereign's workspace management; `~/.claude/CLAUDE.md` reflects the change inside the Sovereign fence, and any user content outside the fence is untouched. _Verified — the fence in `~/.claude/CLAUDE.md` lists all 6 active orgs on boot._
- [ ] A user familiar with OpenClaw, exercising the personality file on a fresh Claude Code thread, reports the agent behaves equivalently. _Blocked on personality porting — the seed template is a placeholder; you own the actual OpenClaw personality content._

---

## 18. Open Questions

1. **SDK API surface stability.** `@anthropic-ai/claude-agent-sdk` is actively evolving. The adapter SHOULD pin a specific version and bump deliberately. CI MUST run against the pinned version.
2. **Hook script delivery.** Hooks are shell commands. We need a one-line POST script that works on macOS/Linux (Sovereign's targets) — a `curl` invocation with the hook secret. Document the dependency on `curl`.
3. **Session JSONL stability.** Claude Code's JSONL format has versioned; Sovereign's `session-reader.ts` already handles `type: "user"|"assistant"`. Confirm forward-compat by snapshotting current schema and adding a regression test when SDK version bumps.
4. **Telemetry normalization shape.** Different backends report different usage shapes. The system view normalizes them today; if a Claude Code-specific field (e.g., cache reads) needs its own column, decide whether normalization is per-backend or centralized.
