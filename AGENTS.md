# AGENTS.md

Read [PRINCIPLES.md](./PRINCIPLES.md) before making any architectural or implementation decisions. Every contribution must align with these principles — if it doesn't, fix the design, not the principles.

## Setup — ad4m submodule

The `@coasys/ad4m` SDK lives in a git submodule at `vendor/coasys/ad4m` (pinned to `coasys/ad4m` `dev`); `pnpm-workspace.yaml` resolves `@coasys/ad4m` from its `core/`. Check it out **before** `pnpm install`, or workspace resolution fails on the missing package.

```bash
git clone --recurse-submodules <repo>          # fresh clone
git submodule update --init --recursive        # existing clone
pnpm install && pnpm run build                  # build:vendor compiles core first
```

To move the pin: `cd vendor/coasys/ad4m && git fetch && git checkout <commit>`, then commit the updated gitlink in the superproject.

### A new git worktree of this repo

A fresh `git worktree add` lacks three untracked pieces that the build and tests need:

- **The submodule.** `git submodule update --init --reference <main-checkout>/.git/modules/vendor/coasys/ad4m vendor/coasys/ad4m` borrows objects from the main checkout instead of cloning ad4m.
- **Dev TLS certs.** `ln -s <main-checkout>/.certs .certs` — the client build reads `.certs/localhost.key`.
- **node-pty's native binary.** pnpm 10 skips install scripts, so copy `node_modules/.pnpm/node-pty@*/node_modules/node-pty/build/` from the main checkout. Without it the terminal tests and every test that imports `bootstrapServer` fail on `pty.node`.

Then `pnpm install && pnpm run build`.

## Service lifecycle

Sovereign runs under a supervisor (a systemd user unit, `sovereign.service`, on Linux). `bin/sovereign` drives it: `build`, `status`, `start`, `stop`, `restart`, `logs`, `health`. Production serves the compiled `packages/server/dist/index.js`, so source edits change nothing until `bin/sovereign build` runs.

Never signal the server pid directly. Use `bin/sovereign restart` or the supervisor's own restart command — a direct kill leaves the supervisor's view of the process stale, which is the first step of the failure below.

### Shutdown must call `process.exit()`

`packages/server/src/index.ts` handles SIGINT and SIGTERM. Registering those listeners overrides Node's default terminate-on-signal, so the handler **must** exit explicitly. Sovereign always holds open handles (agent-backend subprocesses, websockets, intervals), so without an explicit exit the process cleans up and then keeps running.

The observed failure chain, if that exit is missing:

1. The supervisor sends SIGINT; the process shuts down but survives.
2. The supervisor loses track of it; the process re-parents to init while still holding `.sovereign.lock` and the server port.
3. Each replacement start correctly refuses to boot on the held lock.
4. With unlimited restarts, this loops silently and indefinitely (observed 2026-08-01: 41,901 restarts across 58 hours).

### Required supervisor directives

- **A start rate limit** (`StartLimitIntervalSec` + `StartLimitBurst`). Without it, a persistent start failure retries forever and stays invisible. With it, the unit lands in `failed`, where a status check surfaces it immediately.
- **`KillSignal=SIGINT`** — the server's graceful path.
- **`TimeoutStopSec`** of ~30s. Shutdown only flushes to disk and closes streams. In-flight LLM turns are severed deliberately; the resume orchestrator picks them up on the next boot.
- **`Restart=on-failure`**, paired with the start rate limit above.

### Single-instance lock

`packages/server/src/lockfile.ts` holds the policy; `.sovereign.lock` lives in the data dir. Two invariants, both covered by `lockfile.test.ts`:

- A live lock holder that is **not** a Sovereign process never blocks a boot. Pids get recycled, and a false positive wedges the service permanently.
- `release()` only unlinks a lock the calling process owns. An instance that loses the race and exits must not disarm the guard for the winner.

The lock is a diagnostic aid, not the only guard — the port bind fails independently if two instances ever race. The server also re-checks lock ownership every 30s and logs loudly if the lock vanishes or changes hands, because a disarmed guard is otherwise completely silent.

### Only one unit may manage the service

`bin/sovereign` drives the **user-scope** unit (`systemctl --user`). A system-scope unit of the same name is a duplicate, and duplicates are destructive here: on 2026-08-01 a leftover `/etc/systemd/system/sovereign.service` was still `enabled`, crash-looping every ~11s on `EADDRINUSE`, and carried

    ExecStartPre=/bin/rm -f .../.sovereign.lock

so it deleted the healthy instance's lock roughly five times a minute. Never write an `ExecStartPre` that removes the lock — that defeats the guard by design, and it converts a clean "refusing to boot" into an instance race.

To audit both scopes:

    systemctl --user status sovereign.service
    systemctl status sovereign.service        # must not exist / must be disabled

## Rebuild semantics

A rebuild severs in-flight agent turns rather than draining them. Draining deadlocks whenever the rebuild is triggered from inside an in-flight session, which is the common case. Recovery is `packages/agent-backend/src/resume.ts`, which runs at boot over `active-sessions.json`:

- **Tier 1** — replay the in-flight message-queue head.
- **Tier 2** — drop the entry when the assistant turn actually completed before shutdown; invalidate when the backend session file has gone.
- **Tier 3** — synthesize a continuation message, quoting the in-flight prompt. Always-on: the backend's session resume rehydrates a transcript and then waits for input, so a mid-turn session otherwise sits idle forever.
- **tool-await** — a `PreToolUse` hook was holding the backend open (currently `AskUserQuestion`). The backend re-fires the tool on resume, so synthesizing a continuation here would duplicate it. Short-circuit instead.

## Holonic task system (`packages/tasks/`)

Cross-thread task coordination via a holonic DAG. Tasks form many-to-many parent/child relationships (a holon acts as both whole and part). Stored in-memory at runtime; AD4M `hex-tasks` perspective bootstraps in the background for schema registration.

### Architecture

```
TaskStore (interface)
  ├── createInMemoryTaskStore()   — runtime, tests
  └── createAd4mTaskStore()       — AD4M persistence (future primary)
       ↓
TaskService (business logic)
  ├── CRUD + validation
  ├── DAG link management + BFS cycle detection
  ├── Bus event emission (task.created, task.state_changed, ...)
  └── Operational summary (inFlight / recentlyCompleted / unassigned)
       ↓
TaskDigest (replaces PresenceDigest)
  ├── Listens on task.* bus events
  ├── Formats structured entries (no text extraction)
  └── Sole operational-context source for internal thread
```

### MCP tools

Eight Sovereign tools: `task_create`, `task_update`, `task_get`, `task_list`, `task_link`, `task_unlink`, `task_subscribe`, `task_summary`. Registered in `packages/agent-backend/src/claude-code/mcp-server.ts` via `TaskMcpDeps`.

### Task states

`pending` → `in_progress` → `completed` | `cancelled`

### Digest migration (Wave 4 — complete)

TaskDigest replaced PresenceDigest as the sole operational-context injection. The PresenceDigest's `chat.turn.completed` listener gets disposed at bootstrap. WatchStore and its MCP tools (`presence_watch`, `presence_unwatch`, `presence_watched`) have been fully removed.

A debounced proactive-wake listener (`task.state_changed`, `task.created`) forwards a trigger message to the internal thread so TaskDigest entries surface immediately — not deferred until the next external event.

## Presence system

Two long-lived threads form the presence system (`packages/presence/`). They pair but stay independent — each has its own session, history, and context window. They communicate via explicit tool calls, not by sharing context.

### Thread roles

- **`presence`** (`ThreadInfo.presence = 'gateway'`) — the user's primary interface. Voice input, text conversations, and direct work happen here (or in subagents spawned from here). A normal Claude Code thread. Carries only PRESENCE_KNOWLEDGE.md in its session prompt.
- **`presence-internal`** (`ThreadInfo.presence = 'internal'`) — the agent's peripheral awareness. Processes **external and ambient signals only**: AD4M mentions, webhook events, task digests, and context forwarded from the gateway. The agent speaks externally only via `presence_reply_*` tool calls; silence counts as valid. Carries PRESENCE.md + PRESENCE_MEMORY.md + PRESENCE_KNOWLEDGE.md in its session prompt.

The internal thread does NOT handle direct work. It observes the periphery — things that happen outside Sovereign (external integrations) and task activity across other threads (task digest). It surfaces noteworthy items to the gateway via `presence_reply_text`.

### Prompt layers

`makePresenceAwareAppendResolver` in `packages/agent-backend/src/wiring.ts` controls injection. The internal thread receives personality + memory + knowledge; the gateway thread receives knowledge only; all other threads receive nothing from the presence layer.

### Knowledge graph (AD4M perspective)

Both presence threads maintain a shared knowledge graph in a private AD4M perspective named `hex-knowledge`. The schema, tools, and patterns live in `PRESENCE_KNOWLEDGE.md` (injected into both sessions). Two subject classes:

- **Entity** (`hex://Entity`) — durable nodes (person, project, concept, system)
- **Note** (`hex://Note`) — timestamped knowledge units (observation, decision, fact, preference, insight)

Relationships between entities use raw AD4M links under `hex://` predicates. The agent bootstraps the perspective + models on first session activation via `mcp__ad4m__*` tools.

## Tests

`pnpm test` runs `vitest run` at the repo root — the real gate. The root `vitest.config.ts` collects `packages/*/src/**/*.test.ts`. A package without its own vitest config runs its tests through that root config (`"test": "vitest run --root ../.. packages/<pkg>/"`), so `pnpm --filter <pkg> test` runs exactly that package's tests. A new package needs the same script — a bare `vitest run` from the package directory matches no files.

### Rebuild dist after touching a shared package's runtime code

Workspace packages resolve each other through the `exports` map (`types`/`development` conditions point at `src/*.ts`; `default` points at `dist/*.js`). Vitest's default resolution picks the `default` condition, so a change to a runtime function in one package (e.g. `@sovereign/core`, `@sovereign/primitives`, `@sovereign/chat`) stays invisible to any other package's tests until that package's `dist/` gets rebuilt (`cd packages/<name> && npx tsdown`). `tsc --noEmit` never catches this gap — it type-checks against `src/` regardless of the `exports` condition. Symptom: a test asserting the new behavior fails, returning the old output, even though the source edit looks correct. Type-only edits (new interface fields, etc.) need no rebuild; only edits to functions/values that cross a package boundary at runtime do.

### solid-js resolves to its SSR build under vitest — `createEffect` never fires

`vitest.config.ts` sets no `test.environment` (defaults to Node) and adds no resolve conditions, so Node's built-in `"node"` export condition wins solid-js's `package.json` `exports` map — every test import of `solid-js` resolves to `dist/server.js` (the SSR build), never the reactive client build (`dist/dev.js`/`dist/solid.js`), regardless of `NODE_ENV`. That build keeps `createSignal`/`createRoot` working normally, but `createEffect` callbacks never run — not on creation, not on a tracked signal write. Any store using `initPresence`'s pattern (`createEffect(() => { const key = threadKey(); ... })`) consequently resists direct testing as written; this went uncaught because no existing test exercises `initPresence` or any other `createEffect`-based store directly. Two ways around it, depending on what the store needs:

- Prefer a plain polled watcher (`setInterval` comparing the accessor's current value against a `lastSeen` local) over `createEffect` for App-level "react to signal X with an async side effect" stores. This keeps the store a plain function, testable with real timers/`vi.useFakeTimers()`, with no dependency on which solid-js build the resolver picks. See `packages/client/src/features/chat/summary-store.ts`.
- A store that genuinely needs `createEffect` still won't run its callback body inside a vitest run — treat that code as covered only by manual/browser verification, never by unit assertions.

This artifact belongs to test resolution only — the client's real Vite/browser build always resolves the proper reactive build, so production behavior stays unaffected.

## Wind tunnel (`wind-tunnel/`)

End-to-end regression tests against a Dockerised Sovereign instance with a mock Anthropic API. Scenarios (`wind-tunnel/src/scenarios/`) cover thread CRUD, chat roundtrip (full SDK → mock LLM → WS response), presence threads, thread-to-thread forwarding, scheduler jobs, WebSocket event propagation, config/membranes, context management, backend mixing, and LLM benchmarking.

### Isolation (HARD RULE — NON-NEGOTIABLE)

The wind tunnel runs **only inside Docker containers**. No `--native` mode exists — it was removed. The runner hard-refuses any `--sovereign-url` pointing at port 5801 (production). Scenarios must NEVER interact with the live production Sovereign instance. This rule applies to all agents, all sessions, no exceptions.

### Quick start

```bash
# Builds images, runs scenarios, tears down
./wind-tunnel/run.sh

# Single scenario
./wind-tunnel/run.sh --scenario s3

# LLM benchmark (prompt via env, runs against mock in Docker)
SWT_BENCHMARK_PROMPT="your prompt" ./wind-tunnel/run.sh --scenario s18
```

To judge a dependency or refactor, run the suite on the change **and** on its parent commit (a `git worktree add --detach` checkout; fill the ad4m submodule with `git submodule update --init --reference <main checkout>/vendor/coasys/ad4m vendor/coasys/ad4m`). Only a failure absent from the parent counts as a regression. Remove the worktree with `git worktree remove --force` (submodules block a plain remove). `--no-build` reuses whichever checkout built the image last, so rebuild before trusting it.

### Writing scenarios — traps

- **Wait on the thread, not the stream.** Use `waitForThreadIdle(client, threadId, ms)` from `src/wait.ts`. An unfiltered `chat.status` wait ends on any thread's idle. Filter `chat.turn` waits on `threadId` and `turn.role` as well: a sent message's own user turn arrives first. Chat announces one idle per quiet spell, whichever order the backend uses — Claude Code idles just before its final assistant turn, the local LLM just after (`idleAnnounced` in `chat.ts`). A second idle for the same turn would end the next turn's wait at once. The mock LLM only produces the local-LLM order, so a unit test in `chat.test.ts` covers the Claude Code order.
- **The mock resets before every scenario** (`POST /mock/reset`: scripts, log, canned transcript). Sovereign-side state (threads, voice devices, config) still carries over, so a scenario must clean up what it creates.
- **`mockLlmUrl` holds the runner's host-side address.** Never hand it to Sovereign: the container reaches the mock at `http://mock-llm:8900`, set in `docker/config.json`.
- **WS delivery:** a message consumed by a live `waitForWs` never enters the buffer, and `waitForWs('')` matches any type, buffered or live.
- **Token counts drive local-llm compaction.** The backend trusts server-reported `prompt_tokens` (streamed when `stream_options.include_usage` is set, as with llama.cpp). The mock reports about chars/4 of each request. Compaction also needs more than 12 messages, because the backend always keeps the last 10 verbatim, so fill with many rounds, not a few huge ones.
- **History versus model context.** `threadHistory` (`GET /api/threads/:id/history`) returns the original conversation, which compaction never alters. Compaction summaries live only in the model-context view: `fullHistory` (WS `chat.history.full`, backed by `getFullHistory`).
- **The build context mirrors a fresh checkout** (`.dockerignore`): host `node_modules`, `dist`, and `services/` (Python virtualenvs and training data, tens of GB) stay out.
- **Skips:** s10 (ad4m lane inactive), s18 (`SWT_BENCHMARK_PROMPT` unset), and s31 (`agents_spawn` disabled) report a pass while skipping.

### Architecture

- **Mock LLM** (`wind-tunnel/mock-llm/server.ts`) — implements Anthropic `/v1/messages` (SSE streaming) with scripted response support via `POST /mock/script`.
- **Test client** (`wind-tunnel/src/client.ts`) — HTTP + WebSocket client with `timed()` latency sampling. Unwraps Sovereign's response wrappers (`{ threads: [...] }`, `{ thread: {...} }`, etc.).
- **Scenarios** (`wind-tunnel/src/scenarios/`) — TypeScript modules implementing the `Scenario` interface.

### API response shapes (gotcha)

Sovereign wraps most REST responses. The wind tunnel client unwraps them:

| Endpoint               | Wire shape                         | Client method returns |
| ---------------------- | ---------------------------------- | --------------------- |
| `GET /api/threads`     | `{ threads: [...] }`               | `any[]`               |
| `POST /api/threads`    | `{ thread: {...} }`                | `any` (thread object) |
| `GET /api/threads/:id` | `{ thread: {...}, events: [...] }` | `any` (thread object) |
| `GET /api/crons`       | `{ crons: [...] }`                 | `any[]`               |
| `GET /api/membranes`   | `{ membranes: [...] }`             | `any[]`               |
| `GET /api/jobs`        | `[...]`                            | `any[]` (bare array)  |

Thread deletion sets `archived: true` (soft delete). `listThreads()` passes `?active=true` by default to exclude archived threads.

### Docker config

Sovereign runs on port 5801 inside Docker, exposed as 5811 on the host (avoids conflict with the live service). TLS disabled. Personality off. `ANTHROPIC_BASE_URL` points at the mock LLM container.

## LiteLLM proxy (local inference routing)

`services/litellm/` contains the LiteLLM proxy that routes non-Claude model sessions to local inference backends.

### How it works

Sovereign's claude-code backend detects non-Claude models via `familyForModel()`. When a session uses an unrecognised model (e.g. `qwen3.8-27b`), it sets `ANTHROPIC_BASE_URL=http://localhost:4000` and `ANTHROPIC_API_KEY=litellm` in the Claude Code CLI subprocess env. The Claude Code CLI then sends all Anthropic SDK calls to LiteLLM at `:4000` instead of `api.anthropic.com`. Claude sessions bypass the proxy entirely.

### Session handling for LiteLLM threads

Non-Claude threads always start a **fresh session** (`--session-id`) regardless of existing JSONL files. The SDK ignores `env` when resuming a subprocess — a fresh subprocess is required to pick up the `ANTHROPIC_BASE_URL` env injection. History is preserved via the shared history-log system.

`effort` (extended thinking budget) is set to `undefined` for non-Claude sessions — local models do not accept Anthropic thinking parameters.

### LiteLLM config (`services/litellm/litellm.yaml`)

Critical settings:

- `use_chat_completions_url_for_anthropic_messages: true` — forces chat/completions routing for all providers including `openai/*`. Without this, LiteLLM routes `openai/*` models (like `openai/qwen3.8-27b`) through the Responses API, which translates `thinking.budget_tokens` → `reasoning_effort: "high"`. llama-server's Jinja template only accepts `xhigh`/`medium`/`low` → 500 error.
- `drop_params: true` — drops unsupported Anthropic-specific params cleanly.
- `model_info.supports_extended_thinking: false` — signals the model does not support extended thinking.

### Service setup (Arcadia — primary machine)

```bash
# Start the proxy
systemctl --user start litellm
# or manually:
litellm --config services/litellm/litellm.yaml --port 4000 --host 127.0.0.1

# Verify routing
curl -s -X POST http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: litellm" \
  -d '{"model":"qwen3.8-27b","max_tokens":50,"messages":[{"role":"user","content":"Say: LITELLM_WORKS"}]}'
```

### Known gotcha — mid-turn system message injection (patched in LiteLLM)

**Symptom:** `POST /v1/messages?beta=true` → 500 "Jinja Exception: System message must be at the beginning." on every request from a qwen/LiteLLM session.

**Root cause:** Claude Code CLI injects MCP Server Instructions as a `{"role": "system"}` entry within the Anthropic `messages` array on every API call (not just the first). LiteLLM's `translate_anthropic_messages_to_openai` appended this at its original position via `_translate_midturn_system_message_to_openai`. After `_add_system_message_to_messages` placed the main system prompt at position 0, the resulting OpenAI-format message array had structure `[system, user, system]`. llama-server's Jinja template rejects any system message after position 0.

**Fix — LiteLLM patch (applied to installed package):**

File: `$UV_TOOLS_DIR/litellm/lib/python3.12/site-packages/litellm/llms/anthropic/experimental_pass_through/adapters/transformation.py`

In `translate_anthropic_to_openai`, after the call to `_add_system_message_to_messages` (around line 1090), insert:

```python
## CONSOLIDATE SYSTEM MESSAGES
# Some SDK clients (e.g. Claude Code CLI) inject mid-turn system messages
# within the messages array (e.g. MCP server instructions, system-reminders).
# OpenAI-compat backends that use Jinja chat templates (llama-server) require
# ALL system content to appear in a single message at position 0 — a system
# message at any later index raises "System message must be at the beginning."
# Fix: collect all system messages, merge their content into the leading system
# entry, and remove the duplicates from the sequence.
system_msgs = [m for m in new_messages if isinstance(m, dict) and m.get("role") == "system"]
if len(system_msgs) > 1:
    non_system_msgs = [m for m in new_messages if not (isinstance(m, dict) and m.get("role") == "system")]
    merged_content: list = []
    for sm in system_msgs:
        content = sm.get("content", "")
        if isinstance(content, str):
            merged_content.append({"type": "text", "text": content})
        elif isinstance(content, list):
            merged_content.extend(content)
    new_messages = [{"role": "system", "content": merged_content}] + non_system_msgs
```

**⚠️ Upgrade warning:** Running `uv tool upgrade litellm` overwrites the patch. Re-apply after every upgrade:

```bash
python3 services/litellm/patch-litellm.py          # apply (idempotent)
python3 services/litellm/patch-litellm.py --check  # verify
systemctl --user restart litellm
```

The fix lives on the fork at [HexaField/litellm — fix/consolidate-mid-turn-system-messages](https://github.com/HexaField/litellm/tree/fix/consolidate-mid-turn-system-messages). The patch script (`services/litellm/patch-litellm.py`) applies the same fix idempotently to the installed package regardless of version.

## Post-rebuild session-conflict recovery

After a Sovereign rebuild, old Claude CLI subprocesses survive as orphans (reparented to init) and continue holding their session IDs. When the new Sovereign tries to resume the same session, the CLI reports "Session ID already in use" on stderr and exits with code 1. Before dfedbef this caused `initializationResult` to reject before `setMcpServers` ran, leaving MCP tools uninitialised for the session.

**Fix (dfedbef):** The `stderr` callback now sets a `sessionConflict` flag on that message. `initializationResult.catch` scans `/proc` for a subprocess holding the session ID and sends SIGTERM. The `iteratorDone` catch suppresses the generic `chat.error` emission. The session resets to idle; the next `sendMessage` retries cleanly after the orphan exits.

**Betas removed:** The `context-1m-2025-08-07` beta was previously passed for sessions with context windows > 200 k, but Sovereign uses Claude.ai OAuth exclusively, which does not support custom betas. The CLI ignored it and logged a warning on every session start. betas is now always empty.

## POST /api/threads model field (7314d20)

`POST /api/threads` previously ignored the `model` field in the request body. Any thread created with an explicit model (e.g. `model: "qwen3.8-27b"`) silently fell through to `DEFAULT_MODEL_FALLBACK` ("claude-opus-4-6"), making LiteLLM routing untestable via the REST API.

**Fix:** Three-part change in `packages/threads/src/`:

- `threads.ts create()` — added `model?: string` to opts and included it in the constructed `ThreadInfo`.
- `threads.ts projectToV2()` — added `model` to the schema-load whitelist so the field survives a restart.
- `routes.ts POST /api/threads` — extracts `model` from `req.body`, normalises it (strips a `provider/` prefix if present), passes the bare id to `threadManager.create()` and to `createSession()` as `{ provider: 'anthropic', model: bareId }`.

The `PATCH /api/threads/:key/model` route and `update()` were already correct — only `create()` and the POST route needed fixing.

## Claude Agent SDK + model catalog

- **Default model precedence.** A session's model resolves as: explicit thread/session model → `agentBackend.claudeCode.defaultModel` in `config.json` → `DEFAULT_MODEL_FALLBACK` in `claude-code.ts`. An install whose `config.json` sets `defaultModel` ignores a changed code default. Change the live value through `PATCH /api/config`: the store deep-merges, validates, persists, and the next new session reads it with no restart. A hand edit to `config.json` takes effect only after a restart. Existing sessions keep the model persisted in their state file.
- **Adding a model id.** Before listing an id in `MODEL_CATALOG`, run the platform binary shipped in `@anthropic-ai/claude-agent-sdk-<platform>` (under `node_modules/.pnpm/`) with `--model <id> -p "Reply with one word: ok"`. Id shapes vary by generation, so never extrapolate one. A new family name also needs adding to the `familyForModel` prefix regex.
- **`@anthropic-ai/sdk` rides as a peer.** Bumping `@anthropic-ai/claude-agent-sdk` leaves `@anthropic-ai/sdk` on any version that satisfies the peer range. Model access does not depend on it: the SDK spawns a native `claude` binary with its own API client.
- **Built-in task tools on newer models.** From SDK 0.3.268, `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` load by default only on models older than Opus 4.8. Sessions on newer models lose them unless listed explicitly. Sovereign's `mcp__sovereign__task_*` tools cover task tracking, and the client never renders the SDK task tools.
- **Moving existing threads to a new model.** A session freezes its model at creation, so a new default reaches only new threads. Move the others one by one with `PATCH /api/threads/:key/model` (body `{"model": "anthropic/<id>"}`). It updates the thread and its live session, and it persists the session state that `rehydrate()` reads on restart.
- **MCP servers every session gets** (`claude-code/config.ts`): `ad4m` (HTTP, when a token exists), `semble` and `codegraph` (stdio, each with an `<NAME>_MCP=off` opt-out and an `<NAME>_MCP_CMD` launch override that allows quoted arguments), `code` (stdio, Sovereign's own symbol editor — see Code edit below; `CODE_EDIT_MCP=off` opts out), plus `sovereign` (HTTP) added per session in `claude-code.ts`.
- **Subagents.** `agents_spawn` stays disabled (`6041e3e`), so the SDK's built-in `Agent` tool is the only subagent path the routing prompt offers. Nothing may strip it. Its subagents run on Claude whatever a thread's subagent routing says; that routing governs only `agents_spawn`, and the prompt tells the model so. Wind-tunnel s26 checks that the thread gets the tool and that its prompt names it. Agent definitions come from `~/.claude/agents/*.md`: sessions load `settingSources: ['user', 'local']`, so the project-level template `ensureDefaultSubagentFile` seeds never loads. In-process subagents use the parent's API endpoint, so a definition whose `model:` names a non-Claude model fails every call with HTTP 404 under a Claude parent; the backend warns about such files at startup (`findUnreachableAgentModels`).

## Edits go through the edit tools, not the shell

Shell edits (sed -i, heredoc rewrites, Python read-modify-write) fail silently and skip the diff review, so Sovereign closes both ends:

- **No bash-first steer.** In bypass and auto permission modes the bundled Claude CLI adds a reminder telling the model to edit files with sed, heredocs or scripts. Every session's `env` sets `BASH_FIRST_OFF_ENV` (`CLAUDE_CODE_THRIFTY_SONIC=0`, an internal CLI flag) in `claude-code.ts`. `bash-first-steer.test.ts` runs the real CLI against a stub API and fails if an SDK upgrade renames the flag; wind-tunnel s36 forces the flag on in the container and checks the override wins.
- **Shell edit guard.** The PreToolUse hook denies Bash commands that edit files (`shell-edit-guard.ts`): `sed`/`perl`/`ruby -i` and `awk -i inplace` (also behind `sudo`, `xargs`, `env`, a full path, or `bash -c`); `cat`/`echo`/`printf` redirected to a path; `tee` fed by a heredoc, here-string or `cat`/`echo`/`printf`; Python (`-c`, heredoc)/Node/Bun/Ruby (`-e`)/`deno eval` code that writes a file, unless every target is a literal `/tmp` path. The deny message points to `mcp__code__edit`/`edit_files`. The command is tokenised with `shell-quote` after a quote-aware pass (newlines → `;`, heredoc bodies lifted out, `$((…))` dropped), so quoted text such as a commit message is never read as syntax. Output redirects of other commands (`pnpm test > log`, `cmd | tee log`), `/tmp`, `/dev` and `$TMPDIR` targets stay allowed.
- **Limits:** a script written to `/tmp` and then run (`node /tmp/x.mjs`), or a file built in `/tmp` and moved in with `cp`/`mv`, is not inspected. The rule in the user's instructions covers intent; the guard catches the habitual idioms.

## Turns cut short ("[Request interrupted by user]")

Two server mechanisms interrupt a Claude Code turn; the transcript shows the same marker as a user Stop.

- **Stuck-status watchdog** (`packages/chat/src/chat.ts`). It aborts a thread that stays non-idle with **no backend events** for 30 minutes (`lastActivityAt`; subagent lifecycle events count through `parentKey`). It measures silence, not turn age. A foreground subagent's own messages never reach the parent's stream, so the backend's `PreToolUse` hook re-emits the parent's busy `chat.status` (at most once a minute) whenever a subagent calls a tool.
- **Context recycle** (`claude-code.ts`: `recycleSession` → `recycleNow`). A recycle interrupts the live query, prunes the JSONL and resumes. `maybeAutoRecycle` only sets `recycleDue` after a turn's `result`; `sendMessage` runs the recycle before pushing the next message. A `result` marks a session idle even when the SDK already holds the next queued message, so recycling at `result` time cut that turn off.
  - The automatic recycle and the scheduled size sweep (`force`) skip a busy session: not idle, or background tasks reported by the last Stop (`backgroundTaskCount`). Only a user-requested recycle may cut a turn short.
  - The automatic recycle emits no `chat.status`, and the session loop suppresses its teardown idle while a recycle runs (`recycleDone`): the chat layer takes an idle as the end of the message being sent and would release its queue gate early.
  - A send waits for a recycle in progress (`recycleDone`), so no turn starts on a transcript being pruned.
  - A recycle of an idle session ends the query's input instead of calling `interrupt()`: with no turn to interrupt, the iterator stays open until the 10 s timeout, which would hold the next message.
- **Scheduled cleanup sweep.** A cron job that has never run counts from its `createdAt` (`scheduler.ts` tick). Before, `isDue` measured from 1970, so the cleanup job, re-created on every boot, force-recycled every session over the size limit right after each restart.
- **Wind tunnel s16** reproduces the race: it sends on idle (before turn 1's `result`) with the mock holding the reply 4 s. The parent code kills that turn; the scenario passes only when it completes and the recycle runs before the following message.
- **Thread context window.** `POST`/`PATCH /api/threads` pass `contextWindow` to the session (`applyContextWindow`), also before the first message. Before, it reached the session only with an explicit `backend` on create or via `PATCH …/context-window`.
- **Context window default.** With no per-thread or configured window, `contextWindowFor` uses the model's native window: 1M from Opus/Sonnet 4.6 on and for any `[1m]` id, 200K for Haiku, older models and non-Claude models. The old flat 200K default made 1M sessions look several times full and recycle on every cooldown.

## PDF export (`packages/server/src/routes/export-pdf.ts`)

`POST /api/export/pdf` takes `{ markdown }`, renders it with `marked` and prints it through `BrowserService.printPdf`: a fresh headless Chrome per call, JavaScript off, every request except `data:` URLs blocked, so remote images in a message never load. No Chrome → 503 (`BrowserUnavailableError`). The chat's thread and message export menus call it (`packages/client/src/features/chat/export.ts`).

## CI watch (`packages/server/src/ci-watch/`)

MCP tools `ci_watch` / `ci_watch_list` / `ci_unwatch` let a thread watch the GitHub checks of a PR, branch or commit. The server polls; the thread gets one message (cron envelope `[Cron: CI <target> @ <time>]`) through the chat queue, so it never interrupts a turn.

- **Sources:** check runs (GitHub Actions and Apps) and commit statuses (CircleCI on coasys repos posts statuses only), one state per name, check runs first.
- **Ending:** red: the first poll that sees a failed check ends the watch. Green: every watched check finished, and still so on the next poll (`settleMs`, 10 s). CircleCI posts a job's dependants about a second after the job passes, so one all-finished poll can be partial.
- **Cadence:** one loop every 10 s polls every watch in parallel (`CI_POLL.pollMs`); only a watch whose polls fail backs off (20 s doubling to 5 min). Requests carry the last ETag; unchanged answers are 304s, which do not count against the rate limit. Token from `gh auth token`, so any repo the `gh` account can read works (public coasys repos included); no webhook needed.
- **Follow:** a PR or branch watch moves to the new head after a push (default); `follow: false` stays on the commit.
- **Limits:** 12 h default timeout; no check after 20 min ends the watch. Watches persist in `<dataDir>/ci-watch/watches.json` and resume after a restart.

## API traps

- **Thread history** (`GET /api/threads/:threadId/history`) comes from the chat routes, which mount before the threads routes. Its 5 s response cache drops a thread's entry on every `chat.turn` and `chat.message.sent`, so readers without an SSE stream still see new turns.
- **Crons:** `GET /api/crons` renders each payload as `{kind: 'agentTurn', message, text}`, while the store keeps `{kind: 'sovereign.userMessage', threadKey, prompt, label}`. `PATCH /api/crons/:id` accepts either shape and rejects any other payload, so a read-modify-write round trip stays safe.

## File watcher (`packages/files/src/watcher.ts`)

- **One kernel watch per directory, none per file.** On Linux the watcher walks every org root and puts an `fs.watch` on each directory. A directory watch reports changes to its entries by name. Kernel cost scales with directory count: about 6.3k for the live roots, where chokidar used about 228k. chokidar watched every file and exhausted `fs.inotify.max_user_watches` (65,536 by default), which starved every other watcher on the host. Do not reintroduce a per-file watcher. macOS and Windows use Node's native recursive watch instead.
- **Ignored names** (`isIgnoredName`) prune a subtree before any watch goes on it: dependencies, build output, `.git`, caches, `data`, `results`, `training_data`/`training_output`, and every `.venv*`. When a project adds a large generated tree, add its name there.
- A path settles for 150 ms before its event goes out, which coalesces write bursts and atomic saves. A vanished path is reported only if the watcher saw it exist, so editor temp files stay silent.
- **A watch follows an inode, not a path.** Each watched directory records its inode. A directory deleted and recreated, renamed over, or rebuilt by a git checkout inside the settle window shows a different inode, so the watcher re-watches it. Without that check the path would stay unwatched, and a renamed directory's old watch would keep reporting under the old path.
- **Deleting or moving a directory reports every entry it held**, as a per-file watcher would. Consumers matching on an exact path (the file panel's open file) depend on this. The file panel also treats a deleted parent directory as deleting the open file (`panels/file-events.ts`), which covers macOS, where the recursive watch reports only the directory.
- **Known limit:** the kernel queues at most `fs.inotify.max_queued_events` (16,384 by default) unread events and drops the rest silently. A burst of tens of thousands of changes, such as a huge checkout, can lose individual events. The file panel refreshes the whole root tree on any event, so its tree still converges.
- On `ENOSPC` the watcher logs once with the current limit and once more with how many directories it left unwatched. It does not log per path.

## Code index (`packages/code-index/`)

Keeps every codegraph index under the org roots in step with the files on disk. Agents trust `codegraph_explore` output as already-read source, so a stale index misleads them.

- **Trigger.** The files watcher's `file.changed` / `file.deleted` events. A burst of changes runs one `codegraph sync -q <checkout>` for the deepest indexed checkout that holds the path: 250 ms after the last change, or at most 3 s under continuous writes. `sync` reconciles the whole index against the filesystem (stat, then hash), so commits, checkouts, pulls and rebases land too, and a lost event heals at the next one. A full pass runs every 10 minutes as a backstop.
- **Which checkouts.** Directories up to two levels below an org root that hold `.codegraph/codegraph.db`, plus the linked worktrees of those repos (`git worktree list`). A worktree without an index gets `codegraph init` automatically. Test for `codegraph.db`, never for `.codegraph/` alone: ad4m and WE commit `.codegraph/.gitignore`, so every checkout of them has the directory. Discovery reruns on `worktree.*`, `project.*` and `org.*` events, on any change up to two levels below an org root that falls outside every indexed checkout (a pass takes about 20 ms), and every 5 minutes. A new index inside an existing repo sits under the ignored `.codegraph` name, so it waits for the 5-minute pass. An org path that runs through a symlink works: discovery tracks real paths, and watcher paths map onto them.
- **The CLI, not the library.** Each job spawns the installed `codegraph` (about 0.1 s when nothing changed). That keeps codegraph's bundled Node, its native kernel and its `--liftoff-only` WASM flag, follows `codegraph upgrade` with no Sovereign rebuild, and keeps a crash out of the server process. At most two jobs run, never two on one checkout, and change-driven jobs go before catch-up.
- **Only org roots get events.** A checkout outside every org root gets no file events. Add its parent directory as an org.
- **Surface:** `GET /api/code-index` lists checkouts and state. `POST /api/code-index/sync` with `{ "root"?: string }` forces a pass. The health popover shows a "Code Index" row. `CODEGRAPH_INDEX=off` in the service environment opts out.
- Each session's codegraph MCP server reads the same SQLite database and sees these writes at once. codegraph starts its own watcher only for the project its MCP server opens at launch, and Sovereign launches sessions from the workspace root, so without this module no process refreshes any index.

## Code edit (`packages/code-edit/`)

Sessions edit code by naming a symbol instead of quoting its text: `mcp__code__edit` with ops `replace`, `replace_in`, `replace_all`, `insert`, `remove`, `create`, applied in order; any failure writes nothing. `mcp__code__edit_files` takes `{edits: [{file, ops}]}` for several files at once, all or nothing: every file is planned in memory first, and if a write fails partway the files already written get their old bytes back. `replace_all {find, regex?, code, count, symbol?}` replaces every match (literal, or a JS regex with flags `gm` and `$1` expansion) and **requires `count`**: any other number of matches fails the call and lists the lines. Together they give the batch power of sed or a script without the silent failures. Symbol names match the tail of a codegraph qualified name at a `::` boundary (`.` also works; `name@line` picks between same-named declarations). It never guesses between candidates.

- **One stdio server per session.** `claude-code/config.ts` starts `dist/mcp.js` (resolved as `@sovereign/code-edit/mcp`) on the node running Sovereign, with `--liftoff-only` (as codegraph runs its own grammars: no V8 WASM out-of-memory, and a faster first parse) and `--edit-roots`: the cwd, the config directory and every org's workspace, re-read per session, plus the session's own cwd (`withEditRoot`, applied in `resolveMcpServers`). The cwd and config directory can be the same directory, so the org workspaces are what let it reach repos. Parsing stays out of the server process, and nothing is registered until the package is built.
- **Strict input.** Every op and the top-level input are `z.strictObject`s: a misspelt key is an error. Under zod 4 a plain object drops unknown keys silently, so a mistyped `after` appended at the end of the file and `dry_run` wrote.
- **Layers.** `applyOps` (`apply.ts`) is pure: text in, text out, with an `Analyzer` supplying declarations and syntax verdicts. `analyzer.ts` takes symbols from codegraph's `extractFromSource` and parses with codegraph's own WASM grammars (`codegraph.ts` loads both by path from codegraph's platform package, pinned in `package.json`). For TS/JS, Python, Rust and Go a profile (`languages.ts`) widens each symbol to its whole declaration: attached comments, decorators or attributes, `export`/`pub`, the variable statement around a function value, TS overload signatures. Other languages keep codegraph's spans but still get the syntax check. `editFile` (`edit-file.ts`) adds path guards (roots, `.git`, `node_modules`, secrets, 1 MB, non-UTF-8), BOM and per-line line-ending round-trip, compare-and-swap, an atomic write that keeps the file mode, and, from the codegraph index, callers of a changed signature and the nearest affected tests.
- **The client** renders a call with the report's notes and unified diff (`SymbolEditDetail` in `WorkSection.tsx`), told apart from the built-in Edit by its `ops` input.

Gotchas:

- **Load the file's grammar before extracting** (`Analyzer.prepare`, called by `editFile`). codegraph's native kernel refuses any file it cannot parse, a syntax error or a gap in the grammar alike, and returns no symbols; with the WASM grammar loaded it falls back to an error-tolerant parse and still names them.
- **Grammars have gaps.** tree-sitter-typescript 0.23 reports `import('m').T[]` (an array of an inline import type) as an error, and Sovereign's own code uses it. So the syntax gate blocks only problems an edit _adds_: problems are keyed by their text and their line's text, not their position, and compared as a multiset.
- **Free every tree** (`tree.delete()`): web-tree-sitter trees live in WASM memory and are not garbage-collected.
- **Spans always come from the live text**, never from the index DB, which can lag the file. codegraph columns and tree-sitter offsets are both JS string indices (UTF-16); no byte conversion.
- **Python syntax is also judged by CPython** (`python3 -c ast.parse`): tree-sitter-python accepts bad indentation, such as a `def` with no indented body. That verdict blocks an edit only when the file passed it before. A missing `python3` switches it off; a timeout skips one file.
- **What `replace` keeps:** code that opens with a comment replaces the old comments; code that opens with a decorator replaces the old decorators. Omitted decorators, `export`/`pub` (only in front of code that declares something) and a trailing comment on the declaration's last line stay. A blank line detaches a comment from the declaration below, never a decorator or overload. `remove` and `insert before` treat TS overload signatures as part of the implementation.
- **codegraph is pinned (1.5.0)**, because `codegraph.ts` loads its internals by path. The library reads the index the `codegraph` CLI writes, so upgrade both together: if an index format change goes unread, the "callers to check" lines silently disappear from edit reports.
- **Affected tests** come from `codegraph affected` at depth 1 (direct importers), stepping out to depth 2 only when there are none. The CLI's default depth of 5 lists every test that reaches the file at all.

Tests: `text.test.ts` (pure helpers, resolution), `mcp.test.ts` (the stdio server driven by an MCP client: strict schema, roots, exit on stdin close) and `edit-file.test.ts` (every op across TS, TSX, Python, Go, Rust, Java; grammar gaps; guards; CRLF/BOM; symlinks; the compare-and-swap race; a live codegraph index when the CLI is installed). `eval/` holds an A/B evaluation of the tool on real commits (README, pre-registered hypothesis in RESULTS.md).
