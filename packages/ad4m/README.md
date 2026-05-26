# @sovereign/ad4m

Bridge between Sovereign and an [AD4M](https://ad4m.dev) executor. Provides server-side mention subscriptions, watch management, auth, and HTTP routes — without duplicating anything the executor's own MCP already does.

---

## What it does

AD4M exposes **two distinct APIs**. This package only touches the second one:

| API | Port (default) | Used for |
| --- | --- | --- |
| **MCP** (`/mcp`) | 3001 | Claude Code agent tools (`mcp__ad4m__*`). Injected directly into every session by `agent-backend/env-config.ts` — this package does not proxy it. |
| **TypeScript SDK** | 12000 | Server-side subscriptions, queries, watch management. **This is what this package wraps.** |

### Components

**`client.ts` — `Ad4mClientManager`**  
Thin wrapper around `@coasys/ad4m`'s `Ad4mClient`. Handles:

- Initial connection with token loaded from disk
- Health-check polling every 15 s (detects disconnect/reconnect)
- `onConnected()` callbacks so other modules can re-subscribe after reconnect
- `setToken()` for re-auth without restarting the server

**`waker.ts` — mention subscription**  
The core feature. Watches joined AD4M neighbourhood perspectives for messages that mention the agent by name or DID.

- Builds a SPARQL live query using `<ad4m://fn/parse_literal>` to decode `literal:string:` / `literal:json:` message bodies before substring matching
- Subscribes via `QuerySubscriptionProxy` from the SDK
- Deduplicates by message source address (the message node IRI), persisted to `ad4m-watched.json` so restarts don't re-fire old mentions
- Seeds existing matches as "seen" on first boot without emitting — no flood on startup
- 2 s debounce per perspective to coalesce rapid mentions
- Resolves parent channels via a second SPARQL query (`?parent <ad4m://has_child> <msgAddr>`)
- Auto-discovers all joined neighbourhood perspectives and subscribes them; user-configured watches override auto-discovered ones

When a new mention fires, two bus events are emitted:

- `ad4m.perspective.mention` — raw payload `{ uuid, msgAddr, parents, body }`
- `ad4m.thread.message` — injected as a message into the configured Sovereign thread

**`routes.ts` — HTTP routes**

| Method   | Path                                 | Purpose                                                  |
| -------- | ------------------------------------ | -------------------------------------------------------- |
| `GET`    | `/api/ad4m/status`                   | Connection status + agent DID                            |
| `GET`    | `/api/ad4m/perspectives`             | List all joined perspectives                             |
| `GET`    | `/api/ad4m/watch/perspectives`       | List watched perspectives                                |
| `POST`   | `/api/ad4m/watch/perspectives`       | Add a watch `{ uuid, threadKey?, label? }`               |
| `DELETE` | `/api/ad4m/watch/perspectives/:uuid` | Remove a watch                                           |
| `POST`   | `/api/ad4m/command`                  | Slash command handler: `/ad4m watch\|unwatch <url>`      |
| `POST`   | `/api/ad4m/auth/setup`               | Start capability request flow (one-time setup)           |
| `POST`   | `/api/ad4m/auth/complete`            | Complete capability flow, save JWT `{ requestId, rand }` |

**`notifications.ts`**  
Bridges `ad4m.notification.triggered` bus events (fired when the executor sends an app notification) into Sovereign's notification store.

---

## Configuration

All configuration is via environment variables, typically set in `packages/server/.env.local` or the data-dir `.env.local`.

```env
# Required — the executor's TypeScript SDK endpoint
AD4M_HOST=http://127.0.0.1:12000

# Required for Claude Code agent tools — the executor's MCP endpoint
# Injected directly into Claude Code sessions; not proxied by this package
AD4M_MCP_URL=http://127.0.0.1:13001/mcp

# The AI agent's display name — used as the primary mention search term.
# People type this name in neighbourhood messages to invoke the agent.
# Falls back to the Flux profile name if unset (unreliable — set this explicitly).
SOVEREIGN_AGENT_NAME=Hex
```

### Remote executor (SSH tunnel)

If the AD4M executor is running on another machine, forward both ports before starting Sovereign:

```bash
ssh -fNL 12000:127.0.0.1:12000 \
       -L 13001:127.0.0.1:3001 \
       user@remote-host
```

---

## Auth setup (one-time)

AD4M requires a JWT capability token. This is stored in `<data-dir>/ad4m-token.json` and survives restarts.

**If you already have a token** (e.g. from a previous session), place it in the token file and skip this section.

**To obtain a token for the first time:**

1. Start Sovereign with `AD4M_HOST` set. The executor must be running and reachable.

2. Request a capability:

   ```bash
   curl -s -X POST http://localhost:5801/api/ad4m/auth/setup \
     -H "Content-Type: application/json" \
     -d '{"appName":"Sovereign"}'
   ```

   Note the `requestId` in the response.

3. In the ADAM Launcher, go to **Settings → Authorized Apps** and approve the request from "Sovereign". The Launcher will display a numeric code (the `rand`).

4. Complete the flow:
   ```bash
   curl -s -X POST http://localhost:5801/api/ad4m/auth/complete \
     -H "Content-Type: application/json" \
     -d '{"requestId":"<from step 2>","rand":"<code from ADAM Launcher>"}'
   ```

The token is saved to disk. The client reconnects automatically — no restart needed.

---

## Watch management

Perspectives can be watched via the HTTP API or the `/ad4m` slash command in the Sovereign chat UI.

### Via API

```bash
# Watch a perspective — mentions route to "my-thread"
curl -X POST http://localhost:5801/api/ad4m/watch/perspectives \
  -H "Content-Type: application/json" \
  -d '{"uuid":"<perspective-uuid>","threadKey":"my-thread","label":"My Neighbourhood"}'

# Unwatch
curl -X DELETE http://localhost:5801/api/ad4m/watch/perspectives/<uuid>
```

### Via slash command

In any Sovereign chat thread, use the neighbourhood's `sharedUrl`:

```
/ad4m watch neighbourhood://QmAbc...
/ad4m unwatch neighbourhood://QmAbc...
```

The neighbourhood must already be joined in AD4M. The watch is bound to the current thread — mentions route back there.

### Via thread settings UI

Open the ⚙ settings dropdown in any thread. The **AD4M Neighbourhoods** section lists currently watched perspectives and allows adding/removing them from a dropdown of all joined perspectives.

---

## Persistent state

Watch configuration and seen-message deduplication are persisted in a single JSON file alongside the token:

```
<data-dir>/ad4m-watched.json
```

Shape:

```json
{
  "watched": [{ "uuid": "...", "threadKey": "my-thread", "label": "My Neighbourhood" }],
  "seenMessages": {
    "<perspective-uuid>": ["<msgAddr1>", "<msgAddr2>"]
  }
}
```

Delete this file to reset all watches and re-baseline seen messages.

---

## Mention detection — how it works

The waker builds a SPARQL query per watched perspective:

```sparql
SELECT ?source ?predicate ?target WHERE {
  ?source ?predicate ?target .
  FILTER(isIRI(?source) && isIRI(?predicate))
  FILTER(
    CONTAINS(LCASE(STR(<ad4m://fn/parse_literal>(?target))), "hex") ||
    CONTAINS(LCASE(STR(<ad4m://fn/parse_literal>(?target))), "did:key:z6Mk...")
  )
}
```

`<ad4m://fn/parse_literal>` is a built-in executor function that decodes `literal:string:` and `literal:json:` targets to their plain string values before matching — so the CONTAINS operates on actual message text, not raw URIs.

The executor's own `get_mention_waker_config` MCP tool has a known bug where it includes unparsed `literal:json:` expression blobs as CONTAINS terms (they never match). This package builds its own query and avoids the issue entirely.

---

## Package structure

```
src/
  auth.ts          Token read/write utilities
  client.ts        Ad4mClientManager — SDK wrapper with health-check + reconnect
  index.ts         Public exports
  notifications.ts AD4M system notification → Sovereign notification store bridge
  routes.ts        Express HTTP routes
  service.ts       createAd4mService() — composes all modules, consumed by server
  waker.ts         Mention subscription, watch management, persistence
  waker.test.ts    Unit tests for parseLiteralTarget and WatcherController
```
