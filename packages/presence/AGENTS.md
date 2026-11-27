# Presence system

Two long-lived threads form the presence system (`packages/presence/`). They pair but stay independent — each has its own session, history, and context window. They communicate via explicit tool calls, not by sharing context.

## Thread roles

- **`presence`** (`ThreadInfo.presence = 'gateway'`) — the user's primary interface. Voice input, text conversations, and direct work happen here (or in subagents spawned from here). A normal Claude Code thread. Carries only PRESENCE_KNOWLEDGE.md in its session prompt.
- **`presence-internal`** (`ThreadInfo.presence = 'internal'`) — the agent's peripheral awareness. Processes **external and ambient signals only**: AD4M mentions, webhook events, task digests, and context forwarded from the gateway. The agent speaks externally only via `presence_reply_*` tool calls; silence counts as valid. Carries PRESENCE.md + PRESENCE_MEMORY.md + PRESENCE_KNOWLEDGE.md in its session prompt.

The internal thread does NOT handle direct work. It observes the periphery — things that happen outside Sovereign (external integrations) and task activity across other threads (task digest). It surfaces noteworthy items to the gateway via `presence_reply_text`.

## Prompt layers

`makePresenceAwareAppendResolver` in `packages/agent-backend/src/wiring.ts` controls injection. The internal thread receives personality + memory + knowledge; the gateway thread receives knowledge only; all other threads receive nothing from the presence layer.

## Knowledge graph (AD4M perspective)

Both presence threads maintain a shared knowledge graph in a private AD4M perspective named `hex-knowledge`. The schema, tools, and patterns live in `PRESENCE_KNOWLEDGE.md` (injected into both sessions). Two subject classes:

- **Entity** (`hex://Entity`) — durable nodes (person, project, concept, system)
- **Note** (`hex://Note`) — timestamped knowledge units (observation, decision, fact, preference, insight)

Relationships between entities use raw AD4M links under `hex://` predicates. The agent bootstraps the perspective + models on first session activation via `mcp__ad4m__*` tools.

## In the UI: one thread among many

The client shows the gateway thread in the workspace like any other thread; it has no tab of its own. The ⬡ agent view holds only Overview, Forest, Tasks and System, and switching between the two views never changes the open thread. Quick settings (theme, notifications) live in the header's status-dot popover, above Service Health. The device name lives at the top of System → Devices, which the app opens on a first launch without a device name. A legacy `?view=agent` URL with no `tab` (or `tab=hex`) opens the workspace on the gateway thread.

Every open workspace thread gets the header's TTS toggle and simple-conversation toggle. The simple conversation (`packages/presence/src/simple-conversation.ts`) is kept per thread in `presence/simple-conversation/<threadId>.json`; the single-file gateway log of older builds (`presence/simple-conversation.json`) moves into the gateway thread's file on first use. `GET /api/threads/:id/simple-conversation` returns a thread's entries; the client calls it only while the simple view shows. A thread's first call backfills it from history (envelope turns skipped, duplicates of live entries dropped). Each call stamps the thread in `simple-conversation-watched.json`, and for the next 24 h its assistant turns get an LLM summary instead of a truncated first paragraph; the gateway thread always does. `presence.reply` carries a `threadId`; one without it belongs to the gateway thread.
