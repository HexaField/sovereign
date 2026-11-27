# Wind tunnel (`wind-tunnel/`)

End-to-end regression tests against a Dockerised Sovereign instance with a mock Anthropic API. Scenarios (`wind-tunnel/src/scenarios/`) cover thread CRUD, chat roundtrip (full SDK → mock LLM → WS response), presence threads, thread-to-thread forwarding, scheduler jobs, WebSocket event propagation, config/membranes, context management, backend mixing, and LLM benchmarking.

## Isolation (HARD RULE — NON-NEGOTIABLE)

The wind tunnel runs **only inside Docker containers**. No `--native` mode exists — it was removed. The runner hard-refuses any `--sovereign-url` pointing at port 5801 (production). Scenarios must NEVER interact with the live production Sovereign instance. This rule applies to all agents, all sessions, no exceptions.

## Quick start

```bash
# Builds images, runs scenarios, tears down
./wind-tunnel/run.sh

# Single scenario
./wind-tunnel/run.sh --scenario s3

# LLM benchmark (prompt via env, runs against mock in Docker)
SWT_BENCHMARK_PROMPT="your prompt" ./wind-tunnel/run.sh --scenario s18
```

To judge a dependency or refactor, run the suite on the change **and** on its parent commit (a `git worktree add --detach` checkout; fill the ad4m submodule with `git submodule update --init --reference <main checkout>/vendor/coasys/ad4m vendor/coasys/ad4m`). Only a failure absent from the parent counts as a regression. Remove the worktree with `git worktree remove --force` (submodules block a plain remove). `--no-build` reuses whichever checkout built the image last, so rebuild before trusting it.

## Writing scenarios — traps

- **Wait on the thread, not the stream.** Use `waitForThreadIdle(client, threadId, ms)` from `src/wait.ts`. An unfiltered `chat.status` wait ends on any thread's idle. Filter `chat.turn` waits on `threadId` and `turn.role` as well: a sent message's own user turn arrives first. Chat announces one idle per quiet spell, whichever order the backend uses — Claude Code idles just before its final assistant turn, the local LLM just after (`idleAnnounced` in `chat.ts`). A second idle for the same turn would end the next turn's wait at once. The mock LLM only produces the local-LLM order, so a unit test in `chat.test.ts` covers the Claude Code order.
- **The mock resets before every scenario** (`POST /mock/reset`: scripts, log, canned transcript). Sovereign-side state (threads, voice devices, config) still carries over, so a scenario must clean up what it creates.
- **`mockLlmUrl` holds the runner's host-side address.** Never hand it to Sovereign: the container reaches the mock at `http://mock-llm:8900`, set in `docker/config.json`.
- **WS delivery:** a message consumed by a live `waitForWs` never enters the buffer, and `waitForWs('')` matches any type, buffered or live.
- **Token counts drive local-llm compaction.** The backend trusts server-reported `prompt_tokens` (streamed when `stream_options.include_usage` is set, as with llama.cpp). The mock reports about chars/4 of each request. Compaction also needs more than 12 messages, because the backend always keeps the last 10 verbatim, so fill with many rounds, not a few huge ones.
- **History versus model context.** `threadHistory` (`GET /api/threads/:id/history`) returns the original conversation, which compaction never alters. Compaction summaries live only in the model-context view: `fullHistory` (WS `chat.history.full`, backed by `getFullHistory`).
- **The build context mirrors a fresh checkout** (`.dockerignore`): host `node_modules`, `dist`, and `services/` (Python virtualenvs and training data, tens of GB) stay out.
- **Skips:** s10 (ad4m lane inactive), s18 (`SWT_BENCHMARK_PROMPT` unset), and s31 (local-llm threads have no `agents_spawn`) report a pass while skipping.

## The ad4m lane (`--ad4m`, s10)

s10 runs Sovereign's mention waker against a real executor with two agents. It needs two things the plain suite does not:

- **An executor image of the ad4m code under test.** `AD4M_SRC=<ad4m checkout> wind-tunnel/ad4m/build-exec-image.sh <tag>` wraps a release build that is already there (`cargo build --release -p ad4m --bin ad4m-executor --bin ad4m`, the local bootstrap seed `bootstrap-languages/local/dist`, and `bootstrap-languages/server-link-language/build/bundle.js`) with the checkout's own `docker-entrypoint.sh` on `ubuntu:26.04`. The base has to run the host-built binary; a 26.04 host links glibc 2.43, which 24.04 lacks. Pass the tag as `AD4M_EXEC_IMAGE` (default `swt-ad4m-exec:latest`). `run.sh` refuses to start without it.
- **The vendored SDK's build** (`vendor/coasys/ad4m/core/lib`, from `pnpm run build`): the provision step imports it to publish the neighbourhood.

Topology: one multi-user executor with two users, as WE's staging node hosts its users. Hex (Sovereign's agent; the waker uses its JWT) publishes the channel perspective as a neighbourhood over the server-link-language, templated with the lane's `link-server` (built from the submodule's `link-server/`); Holochain is off. Alex (a WE user, its own DID) joins by URL. On one executor a joined neighbourhood is the **same perspective with a second owner** (`install_neighbourhood_with_context`), so Alex's links, signed by Alex, land in the perspective Hex's waker watches; the provision step checks that with a probe link before Sovereign boots. Two executors would each need the shared-store languages of ad4m's `sharedStores.ts` to find each other's neighbourhood and language. s10 drives both agents over the executor's MCP (`add_model`, `instance_create`, host port 14561) and reads wakes from the mock log (the presence turn) and the presence-internal thread history (exactly one delivery per mention, also after a restart). Its cases: chip, name, DID, spoken line, alias class, text-only class and link plus name wake (1–4, 8–10); a substring, another DID and Hex's own write do not (5–7); a restart re-delivers nothing (11); a post root with only a mention link wakes (12, through Mentioning); replies hung off a feed line through `we://response` (`responses` on the classes, written with `instance_add_to_collection`) wake by mention link (R1, "@Hexo" chip, the wake's `Parents:` printed, not asserted) and by name (R2); a post comment root with only a mention link wakes too (R3, through Mentioning; `Parents:` printed, not asserted). It restarts the Sovereign container, so keep it out of a run with s9.

## The UI lane (`--ui`, `src/ui/thread-decisions-shots.ts`)

The images skip the client build unless `WITH_CLIENT=1` (compose: `SWT_WITH_CLIENT`, which `run.sh --ui` sets), so the isolated Sovereign on :5811 serves the UI. `./wind-tunnel/run.sh --ui [--baseline]` builds that image, starts the stack, runs the script instead of the scenarios and tears down. The script seeds a fixed scene through the tunnel's own API (two membranes, a thread "Release planning" with three open decisions across both, one answered, one for another thread), opens the client in Playwright (`playwright-core`, Chromium) at 1440x900 and 390x844 and takes `<prefix>-{desktop,mobile}-{header-badge,panel}.png` into `wind-tunnel/.screenshots/` (gitignored). It also asserts the badge count (3), the panel's rows (only this thread's open decisions), and that nothing was written to `/api/forge/views`. Needs a Chromium: playwright-core's pinned revision, or `SWT_CHROMIUM=<binary>` for another. Determinism: `page.clock` frozen at the newest seeded decision plus 3.5 h (ages read "3h"), animations and transitions off, UTC, en-US, light scheme, scale 1, one font stack (DejaVu Sans), and a pre-set device name (else the app opens System), and the header's status dot (the agent backend's connection, which flaps in the container) hidden (`visibility: hidden`, not a Playwright mask, which would paint over the panel's close button) in every shot with its state logged. Two runs on fresh containers give identical files. For "before" shots, run the lane from a checkout of the base ref that carries the lane's files: `git worktree add <dir> origin/main`, copy `wind-tunnel/` and `.gitignore` in, then `run.sh --ui --baseline` (prefix `before`, header shot only: the feature is absent).

## Architecture

- **Mock LLM** (`wind-tunnel/mock-llm/server.ts`) — implements Anthropic `/v1/messages` (SSE streaming) with scripted response support via `POST /mock/script`.
- **Test client** (`wind-tunnel/src/client.ts`) — HTTP + WebSocket client with `timed()` latency sampling. Unwraps Sovereign's response wrappers (`{ threads: [...] }`, `{ thread: {...} }`, etc.).
- **Mock GitHub** (`wind-tunnel/mock-github/`, container `mock-github`, host port 8910, `ctx.mockGithubUrl`) — see below.
- **Scenarios** (`wind-tunnel/src/scenarios/`) — TypeScript modules implementing the `Scenario` interface.

## Mock GitHub (`wind-tunnel/mock-github/`)

Answers what the forge adapter (`packages/forges`) sends, from an in-memory model (`model.ts`) that scenarios seed and mutate. The runner resets it before every scenario, like the mock LLM.

- **GraphQL** `POST /graphql` (or `/api/graphql`), dispatched by operation name: `ForgeChanges`, `ForgeIssues`, `ForgeBranches`, and the single reads `ForgeChange` / `ForgeIssue` (by `number`) (the queries in `packages/forges/src/queries.ts` — rename one and the mock answers with an error). Ordered by `updatedAt` desc, `first` ≤ 100, cursors, `states`, issue `since`. A missing repo, PR or issue answers `NOT_FOUND`, as GitHub does.
- **REST**: `GET /user`, `GET /repos/:o/:r/pulls/:n`, `…/commits/:ref`, `…/commits/:sha/check-runs`, `…/commits/:sha/status`, `…/compare/:base...:head`, `…/issues/:n/comments`, `…/pulls/:n/comments` (`per_page`/`page` + `Link`), `POST`/`DELETE …/issues/:n/assignees`. GETs carry an ETag and answer 304 to a matching `If-None-Match`. Every API call needs an `Authorization` header (any token).
- **Derived like GitHub:** "#N", "owner/repo#N" and issue/PR URLs in a body cross-reference their target (timeline items); "Closes/Fixes/Resolves #N" fills `closingIssuesReferences`; the check rollup comes from the head commit's runs and statuses; merging into the default branch closes those issues as completed; a review clears the reviewer's request. A check result does not move a PR's `updatedAt` (GitHub's behaviour too), so a since-sync alone misses CI changes.
- **Timestamps:** each mutation stamps a time strictly after the last one, so order is stable; seeds may set `createdAt`/`updatedAt`/`closedAt`/`mergedAt` explicitly (past dates make `since` cuts deterministic).

Control API (JSON bodies; every write returns the changed object):

| Route | Body | Does |
| --- | --- | --- |
| `POST /mock/github/reset` | — | Empty model, viewer `hex-agent`, clears the log and queued failures |
| `POST /mock/github/seed` | `{ viewer?, repos: [{ repo, defaultBranch?, branches?, issues?, pulls?, checks? }] }` | Replaces those repos whole (issues are added before PRs, so PR bodies cross-link them) |
| `POST /mock/github/repo` | `{ repo, defaultBranch? }` | Ensure an empty repo |
| `POST /mock/github/pr` | `{ repo, number?, title?, body?, state?, isDraft?, author?, assignees?, reviewRequests?, reviews?, labels?, head?, headSha?, base?, headRepo?, mergeable?, closes?, …times }` | Create (next number) or update a PR; bumps `updatedAt`. A new head branch is created |
| `POST /mock/github/issue` | `{ repo, number?, title?, body?, state?, stateReason?, author?, assignees?, labels?, …times }` | Create or update an issue |
| `POST /mock/github/review` | `{ repo, number, login, state }` | `APPROVED`/`CHANGES_REQUESTED`/`COMMENTED`/`DISMISSED`, or `REQUESTED` to request one |
| `POST /mock/github/checks` | `{ repo, sha \| branch \| pr, runs?, statuses?, append? }` | Set check runs (`{ name, status, conclusion }`) and statuses (`{ context, state }`) on a commit |
| `POST /mock/github/merge` | `{ repo, number, deleteBranch? }` | Merge an open PR |
| `POST /mock/github/comment` | `{ repo, number, login?, body, review? }` | Issue comment, or a PR review comment with `review: true` |
| `POST /mock/github/branch` | `{ repo, name, sha?, ahead?, behind?, delete? }` | Upsert or delete a branch; ahead/behind are against the default branch (what `compare` returns) |
| `POST /mock/github/assign` | `{ repo, number, add?, remove? }` | Change assignees as someone else on GitHub would |
| `POST /mock/github/fail` | `{ status, count?, path?, method?, retryAfter?, message? }` | The next `count` matching API requests (path prefix) fail with `status`; 403/429 default to a secondary-rate-limit message |
| `GET /mock/github/log` | — | Every API request: method, path + query, status, GraphQL operation and variables |
| `GET /mock/github/state` | — | The whole model |

s43 drives the adapter from the runner against this container: mapping, paging and `since`, assignee writes, ETag 304s, retries over injected 502s and a `Retry-After`, merge → issue closed. s45 and s46 drive the server's `/api/forge*` routes against it (see `packages/work-graph/AGENTS.md`).

## API response shapes (gotcha)

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

## Docker config

Sovereign runs on port 5801 inside Docker, exposed as 5811 on the host (avoids conflict with the live service). TLS disabled. Personality off. `ANTHROPIC_BASE_URL` points at the mock LLM container.
