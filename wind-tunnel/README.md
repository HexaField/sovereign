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

| ID  | Name               | Proves                                                       |
| --- | ------------------ | ------------------------------------------------------------ |
| s1  | Cold Start         | Server boots, health responds, WS connects                   |
| s2  | Thread Lifecycle   | Thread create/read/update/list/delete                        |
| s3  | Chat Roundtrip     | Full chat send → queue → SDK → mock API → WS response        |
| s4  | Presence Threads   | Auto-creation of internal + gateway threads, role assignment |
| s5  | Thread Messaging   | Cross-thread message forwarding                              |
| s6  | Scheduler CRUD     | Cron job create/list/delete                                  |
| s7  | WS Events          | Thread lifecycle events propagate to WS clients              |
| s8  | Config & Membranes | Config endpoint, client config, membrane CRUD                |
| s9  | Session Resume     | Sessions rehydrate + resume after a restart                  |
| s10 | AD4M Waker         | Native ad4m waker wakes presence on a mention + reply lands  |

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

Scenario s10 exercises the full ad4m loop: a neighbourhood @mention wakes Sovereign's native waker, the presence agent runs a turn, and its `presence_reply_ad4m` write-back lands back in the channel. It needs a real ad4m executor, so it runs as an opt-in lane and self-skips otherwise.

```bash
# Needs an ad4m executor image (default ad4m-test:latest; override with
# AD4M_EXEC_IMAGE). s10 self-skips if the node is unreachable.
./wind-tunnel/run.sh --ad4m
./wind-tunnel/run.sh --ad4m --scenario s10        # just the ad4m lane
```

The lane overlays `docker/docker-compose.ad4m.yml`, which adds:

- **`ad4m`** — a multi-user ad4m node (MCP + WS-RPC, Holochain off), MCP exposed on host `:14561` so s10 can inject the mention + verify the reply.
- **`ad4m-provision`** — a one-shot step that signs up a user, mints a channel perspective, and writes the user JWT to a shared dir **before** Sovereign boots (`ad4m/provision.mjs`). Sovereign reads that token, so its waker connects as the same user that owns the perspective.
- a **`sovereign`** override that mounts `ad4m/config.json` (sets `ad4m.host` + agent name `Hex`) and the provisioned token dir as its data dir.

The provisioned identity is written to `wind-tunnel/ad4m/.provision/` (gitignored) so s10 (on the host) injects + verifies against the exact perspective the waker watches. This mirrors the AD4M wind tunnel's A4 (Sovereign) route, run inside Sovereign's own suite.

## Isolation (HARD RULE)

The wind tunnel runs **only inside Docker containers**. No `--native` mode exists. The runner refuses any `--sovereign-url` pointing at port 5801 (production). Scenarios must never interact with the live production Sovereign instance.
