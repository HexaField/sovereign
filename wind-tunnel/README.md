# Sovereign Wind Tunnel

End-to-end regression tests for Sovereign. Runs the full server inside Docker with a mock Anthropic API, exercising HTTP + WebSocket surfaces against scripted LLM responses.

## Quick Start

```bash
# From repo root:
./wind-tunnel/run.sh

# Run specific scenarios:
./wind-tunnel/run.sh --scenario s1,s2

# Keep containers after run (inspect state):
./wind-tunnel/run.sh --keep

# Skip Docker rebuild:
./wind-tunnel/run.sh --no-build
```

## Architecture

```
wind-tunnel/
  run.sh                      # Entry point (Docker build + run + teardown)
  mock-llm/
    server.ts                 # Mock Anthropic API (/v1/messages SSE streaming)
  docker/
    sovereign.Dockerfile      # Sovereign headless test image
    mock-llm.Dockerfile       # Mock LLM image
    docker-compose.yml        # Orchestration
  src/
    main.ts                   # Runner — parses args, waits for health, runs scenarios
    client.ts                 # HTTP + WS test client with latency sampling
    scenario.ts               # Scenario interface
    scenarios/
      s1-cold-start.ts        # Server boot + health + WS connect
      s2-thread-lifecycle.ts   # Thread CRUD
      s3-chat-roundtrip.ts    # Full chat send → mock LLM → response via WS
      s4-presence.ts          # Presence thread auto-creation + roles
      s5-thread-messaging.ts  # Cross-thread forwarding
      s6-scheduler.ts         # Cron job CRUD
      s7-ws-events.ts         # WS event propagation
      s8-config-membranes.ts  # Config + membrane endpoints
```

## Scenarios

| ID | Name | Proves |
| --- | --- | --- |
| s1 | Cold Start | Server boots, health responds, WS connects |
| s2 | Thread Lifecycle | Thread create/read/update/list/delete |
| s3 | Chat Roundtrip | Full chat send → queue → SDK → mock API → WS response |
| s4 | Presence Threads | Auto-creation of internal + gateway threads, role assignment |
| s5 | Thread Messaging | Cross-thread message forwarding |
| s6 | Scheduler CRUD | Cron job create/list/delete |
| s7 | WS Events | Thread lifecycle events propagate to WS clients |
| s8 | Config & Membranes | Config endpoint, client config, membrane CRUD |
| s9 | Session Resume | Sessions rehydrate + resume after a restart |
| s10 | AD4M Waker | A second agent's WE-shaped mentions wake presence once each; substrings, other DIDs and own writes never do; no re-delivery after a restart; reply lands (ad4m lane) |

## Mock LLM

The mock implements Anthropic's `/v1/messages` endpoint with SSE streaming. Features:

- **Default**: echoes the user message back
- **Scripted responses**: register patterns via `POST /mock/script`
- **Request log**: query via `GET /mock/log` for assertions
- **Tool use**: return tool_use blocks for MCP testing

### Mock API

| Endpoint        | Method | Purpose                                |
| --------------- | ------ | -------------------------------------- |
| `/health`       | GET    | Health check                           |
| `/v1/messages`  | POST   | Anthropic messages API (streaming SSE) |
| `/v1/models`    | GET    | Model list                             |
| `/mock/log`     | GET    | Request log (for assertions)           |
| `/mock/log`     | DELETE | Clear request log                      |
| `/mock/script`  | POST   | Register scripted response             |
| `/mock/scripts` | DELETE | Clear all scripts                      |

### Scripted response format

```json
{
  "pattern": "regex-to-match-user-message",
  "response": "text response from the assistant",
  "toolUse": {
    "id": "tool_123",
    "name": "tool_name",
    "input": { "key": "value" }
  }
}
```

## Adding Scenarios

1. Create `src/scenarios/sN-name.ts` implementing the `Scenario` interface
2. Register it in `src/scenarios/index.ts`
3. Run with `./wind-tunnel/run.sh --scenario sN`

Each scenario receives a `ScenarioContext` with:

- `client` — pre-configured HTTP + WS test client
- `sovereignUrl` — base URL of the Sovereign instance
- `mockLlmUrl` — base URL of the mock LLM (for script injection + log queries)

Return a `ScenarioResult` with `passed`, `summary`, `metrics`, and `samples`.

## AD4M Lane

Scenario s10 runs Sovereign's mention waker against a real ad4m executor with two agents: a WE user mentions Sovereign's agent in a shared neighbourhood, the waker wakes the presence agent, and its `presence_reply_ad4m` write-back lands in the channel. It runs as an opt-in lane and self-skips otherwise.

### The executor image

The lane runs the executor of an ad4m checkout (e.g. a PR's head), wrapped in a thin image. Build the binaries and languages in the checkout first, then the image:

```bash
# In the ad4m checkout: a release build, the local bootstrap seed and the
# server-link-language bundle (see the ad4m repo's AGENTS.md for the Deno
# snapshot the executor build needs).
cargo build --release -p ad4m --bin ad4m-executor --bin ad4m
(cd bootstrap-languages/local && node generate-seed.mjs)
(cd bootstrap-languages/server-link-language && pnpm build)

# Here: stage those into wind-tunnel/ad4m/exec-image/.stage (gitignored) and build.
AD4M_SRC=<ad4m checkout> ./wind-tunnel/ad4m/build-exec-image.sh swt-ad4m-exec:latest
```

`AD4M_TARGET_DIR` points at a cargo target dir outside the checkout. The image (`ad4m/exec-image/Dockerfile`) is `ubuntu:26.04` plus the binaries, the checkout's own `docker-entrypoint.sh`, its local bootstrap languages and the server-link bundle. The base must run the host-built binary: one built on Ubuntu 26.04 needs glibc 2.43.

The provision step also needs the vendored SDK's build (`vendor/coasys/ad4m/core/lib`, made by `pnpm run build` at the repo root).

```bash
AD4M_EXEC_IMAGE=swt-ad4m-exec:latest ./wind-tunnel/run.sh --ad4m   # s10 by default
```

### Two agents, one neighbourhood

The lane overlays `docker/docker-compose.ad4m.yml`:

- **`link-server`** — ad4m's link-server (built from `vendor/coasys/ad4m/link-server`, `AUTO_ADMIT`), the sync backend of the server-link-language. Holochain is off, as on WE's staging.
- **`ad4m`** — one multi-user executor (MCP + WS-RPC); MCP on host `:14561`, WS-RPC on `:14560`.
- **`ad4m-provision`** (`ad4m/provision.mjs`, before Sovereign boots) — signs up **Hex** (Sovereign's agent) and **Alex** (a WE user, its own DID). Hex makes the channel perspective and publishes it as a neighbourhood over the server-link-language templated with the link-server's URL; Alex joins by URL. On one multi-user executor a joined neighbourhood is the same perspective with a second owner, as on WE's staging node, so Alex's links (signed by Alex) land in the perspective Hex's waker watches. A probe link from Alex must reach Hex's view before the step succeeds. It writes Hex's JWT as Sovereign's ad4m token and both agents' identities to `wind-tunnel/ad4m/.provision/provision.json` (gitignored).
- a **`sovereign`** override that mounts `ad4m/config.json` (`ad4m.host`, agent name `Hex`) and the provisioned dir as its data dir.

Two executors would each need the shared-store languages of ad4m's `tests/js/utils/sharedStores.ts` to find each other's neighbourhood and language, which the image's local bootstrap languages do not set up.

### What s10 checks

Alex registers WE-shaped classes over MCP (`add_model`) and writes records through them (`instance_create`), under the channel:

- `TextBlock` — WE's text block: `text` (`we://text`), `source` (`we://text_source`), `mentions` (`we://mention`), conforming to TextContent and Mentioning by name;
- `Note` — another app: `content` aliased to TextContent's `text`, `cc` to Mentioning's `mentions`;
- `Chat` — text only, no mention relation;
- `Post` — a post root with `mentions` and no text (Mentioning only);
- `CollectionBlock` — a composed record's root (`kind`, `mentions`), no text; a post comment is one of kind `reply`.

`TextBlock`, `Post` and `CollectionBlock` also carry `responses` (`we://response`, many), as WE's `WeNode` does: a reply is never a child, it hangs off what it answers. A reply is written as WE's transcribe module writes it: the reply `TextBlock` first (no parent), then `instance_add_to_collection` adds it to the answered record's `responses`, then one more adds each `we://mention` to the reply.

A wake case passes when the mock LLM log shows a presence turn whose message says it was mentioned, names the item and `By: <Alex's DID> (signature verified)`, and the presence-internal thread history holds that wake exactly once. A quiet case passes when neither shows up within a window of at least 20 s and three times the slowest wake, and a control mention written after the window still wakes.

| Case | Record | Expect |
| --- | --- | --- |
| 1 | TextBlock "@Hexi can you look at this" + mention link to Hex (the reply is scripted here: `presence_reply_ad4m` must land in the channel) | wake |
| 2 | TextBlock "Hex, can you check the build?", no link | wake |
| 3 | TextBlock with Hex's DID in the text, no link | wake |
| 4 | TextBlock source "spoken", "hey Hex what do you think" | wake |
| 5 | TextBlock "the hexagon tiles are done" | none |
| 6 | TextBlock, neutral text, mention link to another DID | none |
| 7 | Hex itself writes a TextBlock naming and mentioning Hex | none |
| 8 | Note, neutral text, `cc` (aliased to mentions) → Hex | wake |
| 9 | Chat "Hex are you around?" | wake |
| 10 | TextBlock naming Hex and linking Hex | wake, once |
| 11 | Restart the Sovereign container: a new mention wakes, none of the earlier ones is delivered again | wake |
| 12 | Post with only a mention link to Hex, its text in a child TextBlock (Mentioning, ad4m #1587) | wake, once, by Alex |
| R1 | Feed reply: a TextBlock "@Hexo yes, see the log" in a feed line's `responses`, then a mention link to Hex (the chip label runs into the next word, so only the link can wake). The case line prints the wake's `Parents:` (a reply is not a `has_child` child, so `(unknown)` is expected today; not asserted) | wake, once, by Alex |
| R2 | Feed reply "thanks Hex, merged" in a feed line's `responses`, no link | wake, once, by Alex |
| R3 | Post comment: a CollectionBlock of kind `reply` in a post's `responses`, its text in a child TextBlock that does not name Hex, only a mention link on the root (Mentioning, ad4m #1587). The case line prints `Parents:` as R1 does | wake, once, by Alex |

s10 prints one line per case (latency, deliveries, author). It restarts the Sovereign container, so keep it out of a run with s9.

## Isolation (HARD RULE)

The wind tunnel runs **only inside Docker containers**. No `--native` mode exists. The runner refuses any `--sovereign-url` pointing at port 5801 (production). Scenarios must never interact with the live production Sovereign instance.
