# AGENTS.md

Read [PRINCIPLES.md](./PRINCIPLES.md) before making any architectural or implementation decisions. Every contribution must align with these principles — if it doesn't, fix the design, not the principles.

**This repo is public.** Nothing that identifies a deployment goes into tracked files: no real host or tailnet names, LAN/tailnet IPs, MAC addresses, coordinates, home paths, people's names, or captured runtime data (`.data/`, event logs, keys). Tests and docs use neutral stand-ins — `Alex`, `hub`/`worker`/`laptop`, `10.20.30.0/24` or `192.0.2.0/24`, IEEE documentation MACs (`00:00:5e:00:53:xx`), a fictional property location. Deployment-specific values live in the user's config, never in code defaults.

**Agent instructions live in `AGENTS.md` files only.** This root file holds the rules for the whole repo. A folder `AGENTS.md` holds the detail for the code in that folder, and a tool reads it when it reads a file there. Do not create `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`: a `CLAUDE.md` in a folder makes Claude Code skip every `AGENTS.md` below it. Sovereign's own subagents read only the nearest `AGENTS.md` and cut it at 40,000 characters, so keep each file short, and put a rule that matters in the folder it governs.

## Setup — ad4m submodule

The `@coasys/ad4m` SDK lives in a git submodule at `vendor/coasys/ad4m` (pinned to the `coasys/ad4m` commit the AD4M executor runs, currently the `staging` release 0.13.1-staging.4; SDK and executor move together, since the RPC and event API change between releases); `pnpm-workspace.yaml` resolves `@coasys/ad4m` from its `core/`. Check it out **before** `pnpm install`, or workspace resolution fails on the missing package.

```bash
git clone --recurse-submodules <repo>          # fresh clone
git submodule update --init --recursive        # existing clone
pnpm install && pnpm run build                  # build:vendor compiles core first
```

To move the pin: `cd vendor/coasys/ad4m && git fetch && git checkout <commit>`, then commit the updated gitlink in the superproject. Then rebuild the SDK's JavaScript too, not only its types: `cd vendor/coasys/ad4m/core && pnpm install --ignore-workspace && npx tsc; npx rollup -c rollup.config.js` (`tsc` reports type errors in the SDK's own sources but still emits). `build:vendor` emits declarations only, so without this the server runs the old `lib/index.js` against the new types.

The SDK API changes, the mention waker and the wake text are in `packages/ad4m/AGENTS.md`.

### A new git worktree of this repo

A fresh `git worktree add` lacks three untracked pieces that the build and tests need:

- **The submodule.** `git submodule update --init --reference <main-checkout>/.git/modules/vendor/coasys/ad4m vendor/coasys/ad4m` borrows objects from the main checkout instead of cloning ad4m.
- **Dev TLS certs.** `ln -s <main-checkout>/.certs .certs` — the client build reads `.certs/localhost.key`.
- **node-pty's native binary.** pnpm 10 skips install scripts, so copy `node_modules/.pnpm/node-pty@*/node_modules/node-pty/build/` from the main checkout. Without it the terminal tests and every test that imports `bootstrapServer` fail on `pty.node`.

Then `pnpm install && pnpm run build`.

## Service lifecycle

Sovereign runs under a supervisor (a systemd user unit, `sovereign.service`, on Linux). `bin/sovereign` drives it: `build`, `status`, `start`, `stop`, `restart`, `logs`, `health`. Production serves the compiled `packages/server/dist/index.js`, so source edits change nothing until `bin/sovereign build` runs.

Never signal the server pid directly. Use `bin/sovereign restart` or the supervisor's own restart command — a direct kill leaves the supervisor's view of the process stale. The shutdown rule, the supervisor directives and the single-instance lock are in `packages/server/AGENTS.md`.

## Rebuild semantics

A rebuild severs in-flight agent turns rather than draining them. Draining deadlocks whenever the rebuild is triggered from inside an in-flight session, which is the common case. Recovery is `packages/agent-backend/src/resume.ts`, which runs at boot over `active-sessions.json`:

- **Tier 1** — replay the in-flight message-queue head.
- **Tier 2** — drop the entry when the assistant turn actually completed before shutdown; invalidate when the backend session file has gone.
- **Tier 3** — synthesize a continuation message, quoting the in-flight prompt. Always-on: the backend's session resume rehydrates a transcript and then waits for input, so a mid-turn session otherwise sits idle forever.
- **tool-await** — a `PreToolUse` hook was holding the backend open (currently `AskUserQuestion`). The backend re-fires the tool on resume, so synthesizing a continuation here would duplicate it. Short-circuit instead.

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

End-to-end regression tests against a Dockerised Sovereign instance with a mock Anthropic API. The quick start, the scenario traps, the ad4m and UI lanes, the mock GitHub and the Docker config are in `wind-tunnel/AGENTS.md`.

### Isolation (HARD RULE — NON-NEGOTIABLE)

The wind tunnel runs **only inside Docker containers**. No `--native` mode exists — it was removed. The runner hard-refuses any `--sovereign-url` pointing at port 5801 (production). Scenarios must NEVER interact with the live production Sovereign instance. This rule applies to all agents, all sessions, no exceptions.

## Agents never add remotes or publish

`publish-guard.ts` (agent-backend) is a hard block in both backends: the Claude Code `PreToolUse` hook denies the Bash call, and the local-llm Bash tool returns the denial as its error. It refuses `git remote add|set-url|rename`, `git config` writes of `remote.*.url` / `url.*.insteadOf`, `git push` to a URL or path instead of an existing remote, `git subtree push`, `gh repo create|fork`, and `rad auth|init|publish|seed|push`, `rad node start`, `rad remote add`. Pushing a branch to a remote the repo already has stays allowed. Local repos stay local; the user adds remotes and publishes by hand. Forge rethink bug drafts take only forge items as evidence, never plans or tasks (local files), so an approved draft cannot carry private plan text to a public issue.

## Edits go through the edit tools, not the shell

Shell edits (sed -i, heredoc rewrites, Python read-modify-write) fail silently and skip the diff review, so Sovereign removes the push toward them and gives the batch power to the tools (`replace_all`, `edit_files`, see `packages/code-edit/AGENTS.md`):

- **No bash-first steer.** In bypass and auto permission modes the bundled Claude CLI adds a reminder telling the model to edit files with sed, heredocs or scripts. Every session's `env` sets `BASH_FIRST_OFF_ENV` (`CLAUDE_CODE_THRIFTY_SONIC=0`, an internal CLI flag) in `claude-code.ts`. `bash-first-steer.test.ts` runs the real CLI against a stub API and fails if an SDK upgrade renames the flag; wind-tunnel s36 forces the flag on in the container and checks the override wins.
- **No hard block (yet).** `shell-edit-guard.ts` parses a Bash command and names any shell file edit in it (`sed`/`perl`/`ruby -i`, `awk -i inplace`, `cat`/`echo`/`printf`/`tee` authoring, scripts that write files; `/tmp` and `mktemp` targets are scratch). It is **not wired in**: a deny hook proved too blunt, since shell edits are sometimes warranted. It stays as the candidate first layer of a future decision gate (rules, then possibly a Jev-like decision model). Until then, watch the tool-usage metrics to see whether the steer removal and the batch tools are enough.

## API traps

- **Thread history** (`GET /api/threads/:threadId/history`) comes from the chat routes, which mount before the threads routes. Its 5 s response cache drops a thread's entry on every `chat.turn` and `chat.message.sent`, so readers without an SSE stream still see new turns.
- **Crons:** `GET /api/crons` renders each payload as `{kind: 'agentTurn', message, text}`, while the store keeps `{kind: 'sovereign.userMessage', threadKey, prompt, label}`. `PATCH /api/crons/:id` accepts either shape and rejects any other payload, so a read-modify-write round trip stays safe.

## Where the detail lives

Each file holds the sections named here. Where a section spans several packages, it sits with the package that owns its entry point.

- `packages/ad4m/AGENTS.md` — SDK API changes to know, the mention waker, wake text config.
- `packages/agent-backend/AGENTS.md` — post-rebuild session conflicts, one session per thread, Claude Agent SDK and model catalog, subagents (`agents_spawn`), turns cut short, context recycle.
- `packages/agent-backend/src/harness/AGENTS.md` — subagent harnesses (other coding-agent CLIs).
- `packages/client/AGENTS.md` — dictation draft bubble, file quick-open, file panel tree, file chips and Mermaid in messages.
- `packages/client/src/features/forge/AGENTS.md` — Forge client: Tree panel, goal tree on the canvas, Kanban, phone layout, gestures, Decisions views.
- `packages/code-edit/AGENTS.md` — symbol edit tools (`mcp__code__edit`), their gotchas.
- `packages/code-index/AGENTS.md` — keeping codegraph indexes in step with files.
- `packages/files/AGENTS.md` — file watcher (inotify limits, ignored names, inode rule).
- `packages/forges/AGENTS.md` — the `Forge` interface, GitHub adapter, transport, discovery.
- `packages/graphcoder-core/AGENTS.md` — all of Graphcoder (core, server, CLI, ports, structure, concept map). Spans three packages and the server's composition root; the other two packages point here.
- `packages/presence/AGENTS.md` — presence threads, prompt layers, knowledge graph, simple conversation.
- `packages/scheduler/AGENTS.md` — crons and their routes.
- `packages/server/AGENTS.md` — shutdown rule, supervisor directives, single-instance lock, one managing unit, PDF export.
- `packages/server/src/hazards/AGENTS.md` — hazard monitor.
- `packages/server/src/pr-watch/AGENTS.md` — PR watch tools and polling.
- `packages/system/AGENTS.md` — device file viewer, network map.
- `packages/tasks/AGENTS.md` — holonic task system, stores, outbox, providers, MCP tools.
- `packages/threads/AGENTS.md` — `POST /api/threads` model field.
- `packages/timeline/AGENTS.md` — timeline events, storage, API.
- `packages/voice/AGENTS.md` — voice replies (one speaker per device, speech queue).
- `packages/work-graph/AGENTS.md` — Forge work graph server side: scope, trusted authors, sync, builder, plans, epics, categories, events, tracked items, overlay, routes, Decisions, classifier, rethink. The Forge client text is in `packages/client/src/features/forge/AGENTS.md`; this file points to it.
- `services/AGENTS.md` — TTS services.
- `services/litellm/AGENTS.md` — LiteLLM proxy (local inference routing).
- `services/voice-node/AGENTS.md` — voice node push-to-talk.
- `wind-tunnel/AGENTS.md` — wind tunnel: quick start, scenario traps, ad4m and UI lanes, mock GitHub, API shapes, Docker config.
