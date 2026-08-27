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

## Presence system

Two long-lived threads form the presence system (`packages/presence/`). They pair but stay independent — each has its own session, history, and context window. They communicate via explicit tool calls, not by sharing context.

### Thread roles

- **`presence`** (`ThreadInfo.presence = 'gateway'`) — the user's primary interface. Voice input, text conversations, and direct work happen here (or in subagents spawned from here). A normal Claude Code thread. Carries only PRESENCE_KNOWLEDGE.md in its session prompt.
- **`presence-internal`** (`ThreadInfo.presence = 'internal'`) — the agent's peripheral awareness. Processes **external and ambient signals only**: AD4M mentions, webhook events, watched-thread digests, and context forwarded from the gateway. The agent speaks externally only via `presence_reply_*` tool calls; silence counts as valid. Carries PRESENCE.md + PRESENCE_MEMORY.md + PRESENCE_KNOWLEDGE.md in its session prompt.

The internal thread does NOT handle direct work. It observes the periphery — things that happen outside Sovereign (external integrations) and activity across other threads (watch digests). It surfaces noteworthy items to the gateway via `presence_reply_text`.

### Prompt layers

`makePresenceAwareAppendResolver` in `packages/agent-backend/src/wiring.ts` controls injection. The internal thread receives personality + memory + knowledge; the gateway thread receives knowledge only; all other threads receive nothing from the presence layer.

### Knowledge graph (AD4M perspective)

Both presence threads maintain a shared knowledge graph in a private AD4M perspective named `hex-knowledge`. The schema, tools, and patterns live in `~/.sovereign/PRESENCE_KNOWLEDGE.md` (injected into both sessions). Two subject classes:

- **Entity** (`hex://Entity`) — durable nodes (person, project, concept, system)
- **Note** (`hex://Note`) — timestamped knowledge units (observation, decision, fact, preference, insight)

Relationships between entities use raw AD4M links under `hex://` predicates. The agent bootstraps the perspective + models on first session activation via `mcp__ad4m__*` tools.

## Tests

The root `vitest.config.ts` collects `packages/*/src/**/*.test.ts`. Most packages have no local vitest config, so `pnpm --filter <pkg> test` reports "no test files" for them — that is expected. The repo-root run is the real gate.

### Rebuild dist after touching a shared package's runtime code

Workspace packages resolve each other through the `exports` map (`types`/`development` conditions point at `src/*.ts`; `default` points at `dist/*.js`). Vitest's default resolution picks the `default` condition, so a change to a runtime function in one package (e.g. `@sovereign/core`, `@sovereign/primitives`, `@sovereign/chat`) stays invisible to any other package's tests until that package's `dist/` gets rebuilt (`cd packages/<name> && npx tsdown`). `tsc --noEmit` never catches this gap — it type-checks against `src/` regardless of the `exports` condition. Symptom: a test asserting the new behavior fails, returning the old output, even though the source edit looks correct. Type-only edits (new interface fields, etc.) need no rebuild; only edits to functions/values that cross a package boundary at runtime do.

### solid-js resolves to its SSR build under vitest — `createEffect` never fires

`vitest.config.ts` sets no `test.environment` (defaults to Node) and adds no resolve conditions, so Node's built-in `"node"` export condition wins solid-js's `package.json` `exports` map — every test import of `solid-js` resolves to `dist/server.js` (the SSR build), never the reactive client build (`dist/dev.js`/`dist/solid.js`), regardless of `NODE_ENV`. That build keeps `createSignal`/`createRoot` working normally, but `createEffect` callbacks never run — not on creation, not on a tracked signal write. Any store using `initPresence`'s pattern (`createEffect(() => { const key = threadKey(); ... })`) consequently resists direct testing as written; this went uncaught because no existing test exercises `initPresence` or any other `createEffect`-based store directly. Two ways around it, depending on what the store needs:

- Prefer a plain polled watcher (`setInterval` comparing the accessor's current value against a `lastSeen` local) over `createEffect` for App-level "react to signal X with an async side effect" stores. This keeps the store a plain function, testable with real timers/`vi.useFakeTimers()`, with no dependency on which solid-js build the resolver picks. See `packages/client/src/features/chat/summary-store.ts`.
- A store that genuinely needs `createEffect` still won't run its callback body inside a vitest run — treat that code as covered only by manual/browser verification, never by unit assertions.

This artifact belongs to test resolution only — the client's real Vite/browser build always resolves the proper reactive build, so production behavior stays unaffected.

## Wind tunnel (`wind-tunnel/`)

End-to-end regression tests against a Dockerised Sovereign instance with a mock Anthropic API. 18 scenarios cover thread CRUD, chat roundtrip (full SDK → mock LLM → WS response), presence threads, thread-to-thread forwarding, scheduler jobs, WebSocket event propagation, config/membranes, context management, backend mixing, and LLM benchmarking.

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

**⚠️ Upgrade warning:** Running `uv tool upgrade litellm` will overwrite this patch. Re-apply the block above after every LiteLLM upgrade before restarting the service.

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
