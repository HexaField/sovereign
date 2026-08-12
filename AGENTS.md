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

Two long-lived threads form the presence system (`packages/presence/`):

- **`presence-internal`** (`ThreadInfo.presence = 'internal'`) — the agent's stream-of-consciousness. Receives ambient inbound (voice, AD4M, watched-thread digests). The agent speaks externally only via `presence_reply_*` tool calls; silence counts as valid. Carries PRESENCE.md + PRESENCE_MEMORY.md + PRESENCE_KNOWLEDGE.md in its session prompt.
- **`presence`** (`ThreadInfo.presence = 'gateway'`) — the user's text-chat surface. A normal Claude Code thread. Carries only PRESENCE_KNOWLEDGE.md in its session prompt.

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
