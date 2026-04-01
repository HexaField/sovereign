# Chat Architecture

## Data Flow

```
Client (SolidJS)                    Server (Express)                    OpenClaw Gateway
     │                                   │                                    │
     ├──GET /api/threads/:key/history────►│──readRecentMessages(JSONL)─────────┤
     │◄─────────JSON {turns, hasMore}─────┤                                    │
     │                                   │                                    │
     ├──GET /api/threads/:key/events─────►│ SSE connection                     │
     │◄─────────SSE: status, work,────────┤◄──WS events (chat, agent)──────────┤
     │          stream, turn, etc         │                                    │
     │                                   │──JSONL poll (2s interval)───────────┤
     │◄─────────SSE: work (tool calls)────┤   (reads new bytes from file)      │
```

## History Loading

- **HTTP GET** `/api/threads/:key/history` — fast, file-based JSONL parsing (reads last 2000 messages)
- Cached at two levels:
  1. `historyCache` in openclaw.ts — keyed by sessionKey, invalidated by file mtime+size (capped at 50)
  2. `historyResponseCache` in routes.ts — 5s TTL, prevents re-serialization (auto-cleaned every 30s)
- Client fetches history immediately on SSE connect, with 3 retries on failure

## Live Events (SSE)

- Server-Sent Events at `/api/threads/:key/events`
- Events: `status`, `stream`, `work`, `turn`, `compacting`, `error`, `backend-status`, `queue`, `user-message`
- On connect: sends `backend-status` and `queue`, replays cached live state (status, work items, stream text)
- Backend WS events → chat.ts EventEmitter → SSE endpoint
- Keep-alive ping every 30s

## JSONL Polling

- Gateway WS doesn't stream tool_call/tool_result events
- When agent status is `working`/`thinking`, polls JSONL file every 2s
- Reads only NEW bytes (tracks file position)
- Starts on: backend status change to working/thinking, or SSE client connect if agent is already active
- Stops on: status → idle, or last SSE client disconnects
- Tracks seen tool IDs to avoid duplicates

## Caches

| Cache                | Location    | Invalidation              | Bounds              |
| -------------------- | ----------- | ------------------------- | ------------------- |
| historyCache         | openclaw.ts | file mtime+size           | 50 entries (LRU)    |
| historyResponseCache | routes.ts   | 5s TTL, turn events       | auto-cleaned 30s    |
| currentWork          | chat.ts     | cleared on turn/idle      | capped at 200 items |
| currentStatus        | chat.ts     | cleared on turn           | per-thread          |
| currentStreamText    | chat.ts     | cleared on turn/tool_call | per-thread          |

## SSE Client Tracking

- `sseClientCount` map tracks active SSE connections per thread
- `trackSSEClient` on connect, `untrackSSEClient` on `req.close`
- JSONL polling stops when count reaches 0

## Failure Modes

- Stuck status: 5-minute timeout auto-resets to idle
- History fetch failure: client retries 3 times with backoff
- SSE disconnect: EventSource auto-reconnects (browser built-in)
- WS disconnect: exponential backoff reconnect with jitter
