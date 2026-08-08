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

# Run against already-running services (no Docker):
./wind-tunnel/run.sh --native
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

## Native Mode

For development, run services manually and test against them:

```bash
# Terminal 1: mock LLM
cd wind-tunnel && npx tsx mock-llm/server.ts

# Terminal 2: Sovereign (with mock LLM)
ANTHROPIC_BASE_URL=http://localhost:8900 ANTHROPIC_API_KEY=sk-mock bin/sovereign run

# Terminal 3: scenarios
cd wind-tunnel && ./run.sh --native
```
