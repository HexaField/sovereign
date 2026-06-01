# Pi as a Second Backend Factory — Specification

**Status:** Draft **Revision:** 2 **Date:** 2026-06-01

Land [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) + [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) as a second `AgentBackend` factory inside `@sovereign/agent-backend`, sibling to the existing `claude-code/` adapter, selectable per-thread via the `SOVEREIGN_DEFAULT_BACKEND` config key. This document conforms to [PRINCIPLES.md](../PRINCIPLES.md). Requirements use MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

**Doctrine:** [pi-principles-spec.md](pi-principles-spec.md) extracts the eight theses from Mario Zechner's ["Building Pi in a World of Slop"](references/pi-mario-zechner-talk-2025.md) talk and operationalises them against Sovereign's architecture. **Where this spec and the principles spec disagree, the principles spec wins; this spec is amended.**

---

## 0. State of Play — 2026-06-01

Revision 1 of this spec (2026-05-23) was written when OpenClaw was the live backend and "land Pi" meant a wholesale migration. Since then a much larger refactor has shipped:

- **`c43a5fd` — Cleaned OpenClaw reliance into explicit abstraction** (the un-openclawing spec, [archived](archive/un-openclawing-spec.md)).
- **`05575a4` — Added Claude Code backend and CronService.** Claude Code became the second backend the seam carries; CronService became Sovereign-owned.
- **`b34303d` — Modularisation refactor.** The agent-backend code moved out of `packages/server/src/agent-backend/` into its own package `@sovereign/agent-backend`. 27 packages total.
- **`8654a85` — Config-driven runtime.** Env vars retired; `~/.sovereign/data/config.json` is the canonical settings surface. `agentBackend.enabled` and `agentBackend.default` already exist in the schema.
- **`bcfe3bb` — Auto-resume for active agents on restart.** `resumeActiveSessions()` is the boot-time sweep.
- **`8e83e64` — Lossless restart Rev 2 — JSONL-derived liveness** ([spec](lossless-restart-spec.md)). In-process `active-sessions.json` is now a derived view of canonical JSONL.
- **`30a7884` — PreToolUse redirects for SDK scheduling tools to Sovereign's CronService** ([spec](claude-code-wakeup-bridge-spec.md)). Blocks `ScheduleWakeup`/`CronCreate`/`CronList`/`CronDelete`.
- **`2f8da5d` — AD4M MCP and Waker bridge.**
- **`d7a9ccd` — Removed OpenClaw support completely.** Replaced by a migration guide for end users. The only remaining `openclaw` strings in code are two legacy-path comments in `packages/server/src/index.ts` and `packages/agent-backend/src/claude-code/path-encoding.ts`.
- **`9d40513` — Backend abstraction for message processing** above the agent-backend seam.

Together those commits already deliver **§5 (module layout), §6 (file-by-file impact), §7 (new `AgentBackend` methods), §8 (feature-for-feature mapping of OpenClaw-only surfaces), §10 (history migration), and §11 (client impact) of Revision 1.** This revision deletes those sections, retains §4 (event translation matrix), §9 (subagent requirements), and §17 (capabilities Pi unlocks) — which still describe work yet to land — and rewrites §1, §2, §12, §13, §14, §15 to match present reality.

**Net of this revision:** Pi is a **factory addition**, not a migration. Land `packages/agent-backend/src/pi/` as a sibling of `claude-code/`, widen the `agentBackend.enabled` enum, wire the factory into `wireAgentBackend()`. Most of the conceptual surface is already in place.

---

## 1. Goals and Non-Goals

### Goals

- **Sibling factory.** Add `packages/agent-backend/src/pi/` parallel to `claude-code/`, registered via `wireAgentBackend()`'s `factories` map, no new public types beyond the doctrine additions called out in [pi-principles-spec.md §4.1](pi-principles-spec.md#41-pi-migration-specmd).
- **Behavioural parity.** Chat send/abort, history (live + paginated), session switching, model selection, streaming text, tool calls, tool results, thinking blocks, compaction events, turn boundaries, and subagent visibility MUST behave indistinguishably from the live `claude-code` backend for any thread bound to Pi.
- **Co-existence.** Pi and Claude Code MUST run in the same process. Each thread is bound to its backend at creation time via `SessionsRegistry`. `forSession(sessionKey)` already resolves to the owning backend.
- **Same `AgentBackend` interface.** [`packages/core/src/agent-backend.ts`](../packages/core/src/agent-backend.ts) is the contract. The `'pi' | 'claude-code'` union is already declared. No additions to the interface; missing Pi features are either dropped, moved to Sovereign-native modules, or implemented as in-process equivalents.
- **Doctrine compliance.** Pi exists for [the reasons in pi-principles-spec.md](pi-principles-spec.md#1-the-doctrine--eight-theses). Implementation MUST honour Thesis 1 (context sovereignty) and Thesis 2 (minimal core) by emitting `context.mutation` events for every system-prompt change and capping Sovereign's contribution to the system prompt per R-MC-3.

### Non-Goals

- Re-implementing Pi's RPC mode (we embed the SDK).
- Migrating Claude Code sessions into Pi sessions. Sessions stay on whichever backend created them.
- Removing Claude Code. Claude Code remains a peer backend, with the divergences from doctrine noted in [pi-principles-spec.md §4.3](pi-principles-spec.md#43-claude-code-adapter-specmd).
- Changing the client. The SolidJS client already adapted to the multi-backend seam during un-openclawing.

---

## 2. Design Philosophy

- **Pi's doctrine governs Sovereign's adoption — see [pi-principles-spec.md](pi-principles-spec.md).** That spec is upstream of this one.
- **Pi is a library, not a service.** Treat it like `express` or `ws`: instantiate in the factory closure inside `wireAgentBackend()`, hold references, dispose on shutdown.
- **One `AgentSession` per Sovereign thread.** The mapping `sessionKey → AgentSession` is owned by the Pi backend instance. Pi's UUID session ids stay private and are persisted only in `SessionsRegistry.backendSessionId`.
- **Registry is shared, not Pi-owned.** `@sovereign/primitives.createSessionsRegistry()` is the canonical store; Pi's adapter writes through it just like Claude Code does.
- **Features Pi does not ship (subagents) are Sovereign-orchestrated.** Pi's `BackendCapabilities.subagents` returns `'sovereign-orchestrated'`. Implementation in §9.
- **Strangler-fig is already done.** This is a sibling addition, not a strangler. There is no "land behind a flag, then flip the default" trajectory — both backends ship enabled, the default is operator-chosen.

---

## 3. Pi Surface Recap

For implementers unfamiliar with Pi. Verified against the agent-core and coding-agent READMEs and `docs/sdk.md`, `docs/rpc.md`, `docs/session-format.md` in `earendil-works/pi`.

| Pi Surface | Sovereign Equivalent (current) |
| --- | --- |
| `createAgentSession({ sessionManager, authStorage, modelRegistry, cwd, agentDir, model, thinkingLevel, tools })` | Constructs one session. Pi backend holds a `Map<sessionKey, AgentSession>` in its closure. |
| `AgentSessionRuntime` (`newSession / switchSession / fork / importFromJsonl`) | Used for session lifecycle. Backend wraps it. |
| `session.prompt(text, { images, streamingBehavior })` | `AgentBackend.sendMessage` |
| `session.steer(text)` / `session.followUp(text)` | Plumbed via new optional methods (deferred — see §16 decision 1). |
| `session.abort()` | `AgentBackend.abort` |
| `session.agent.state.messages: AgentMessage[]` | In-memory history; `getHistory` reads JSONL via `getSessionFilePath`-style paths for parity with Claude Code's read pattern. |
| `session.subscribe((event) => …)` | Drives `pi-events.ts` translator (§4). |
| Session JSONL at `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl` | Pi's persistence. Sovereign treats it as opaque. `getSessionFilePath` returns the path; `getActivityMap` stats it. |
| `AuthStorage`, `ModelRegistry` at `~/.pi/agent/auth.json`, `~/.pi/agent/models.json` | Drives `listAvailableModels`. |
| RPC mode (`pi --mode rpc`) | **Not used.** We embed the SDK directly. |
| `AgentExtension` (TypeScript modules, hot-reload) | First-class — see [pi-principles-spec.md §3.3, §3.4](pi-principles-spec.md#3-gaps-and-required-additions) — drives the "agent writes its own extensions" workflow. |

Pi event types (from `docs/sdk.md`):

```
agent_start | agent_end | turn_start | turn_end
message_start | message_update | message_end
tool_execution_start | tool_execution_update | tool_execution_end
queue_update | compaction_start | compaction_end | auto_retry_start | auto_retry_end
```

`message_update` carries `assistantMessageEvent` with `text_delta | thinking_delta | ...`. `turn_end` carries the final assistant message and tool results.

---

## 4. Event Translation Matrix

The Pi backend MUST translate Pi events to `AgentBackendEvents` (defined in [`packages/core/src/agent-backend.ts`](../packages/core/src/agent-backend.ts)) so the chat module, threads routes, and active-sessions writer see the same shapes the Claude Code backend produces.

| Pi event | Emitted Sovereign event | Notes |
| --- | --- | --- |
| `agent_start` | `chat.status { status: 'working', backendKind: 'pi' }` and `activeSessions.upsert(...)` | Mirrors Claude Code's working transition. Must be synchronous-write (lossless-restart-spec.md R5). |
| `agent_end` | `chat.status { status: 'idle', backendKind: 'pi' }` and `activeSessions.remove(sessionKey)` | Final barrier per Pi docs — awaited subscribers settle before `prompt()` resolves. |
| `turn_start` | _(none)_ | Internal. |
| `turn_end` | `chat.turn { sessionKey, turn: ParsedTurn, backendKind: 'pi' }` | Build `ParsedTurn` directly from `event.message` + `event.toolResults`. No JSONL re-read required. |
| `message_update` (`text_delta`) | `chat.stream { sessionKey, text: delta, backendKind: 'pi' }` | Pi emits true deltas; no cumulative-length bookkeeping needed. |
| `message_update` (`thinking_delta`) | `chat.work { type: 'thinking', output: accumulated, backendKind: 'pi' }` | Accumulate per session; flush at next `tool_execution_start` or `turn_end`. |
| `tool_execution_start` | `chat.work { type: 'tool_call', name, input, toolCallId, backendKind: 'pi' }` | Flush pending thinking first. |
| `tool_execution_update` | _(swallow for now)_ | Open: surface as a streaming `WorkItem` update once core grows the channel. Decision deferred (§16). |
| `tool_execution_end` | `chat.work { type: 'tool_result', name, output, toolCallId, backendKind: 'pi' }` | Output stringified via the shared `contentToOutputStr` helper used by Claude Code. |
| `compaction_start` / `compaction_end` | `chat.compacting { active: true/false, backendKind: 'pi' }` | 1:1. Also emits `context.mutation { kind: 'compaction_replaced', ... }` per [pi-principles-spec.md R-CS-1](pi-principles-spec.md#31-context-sovereignty--enforcement). |
| `auto_retry_start` / `auto_retry_end` | _(log only)_ + optional `chat.error { retryAfterMs, backendKind: 'pi' }` on retry start. | Surfaces "Retrying in Xs…" in UI if delay is known. |
| _(thrown error in `prompt()`)_ | `chat.error { sessionKey, error, backendKind: 'pi' }` | Standard error path. |
| `dispose()` / shutdown | `backend.status { status: 'disconnected', backendKind: 'pi' }` | Local. |
| Pi extension load/unload events | `context.mutation { kind: 'extension_loaded' \| 'extension_unloaded', ... }` (R-CS-1) | Per [pi-principles-spec.md R-SM-3](pi-principles-spec.md#33-self-modifying--make-it-a-first-class-workflow). |

**Consequence:** the entire Claude Code adapter's classification machinery (TurnKind variants, system-envelope parsing, compaction-marker detection) is the model the Pi adapter should follow. Pi gives us cleaner inputs (typed deltas, awaited settlement, terminate flags) so the Pi translator is smaller than Claude Code's. The shared bus events `chat.stream`, `chat.turn`, `chat.work`, `chat.compacting`, `chat.error`, `backend.status`, `subagent.spawned`, `subagent.completed`, `subagent.failed` already exist (see [`packages/core/src/agent-backend.ts:91-131`](../packages/core/src/agent-backend.ts#L91)).

---

## 5. Module Layout (delta from current)

Current — already in place:

```
packages/agent-backend/src/
├── index.ts                 # public surface — exports createBackend, wireAgentBackend, createActiveSessions, claude-code surface
├── factory.ts               # RoutingBackend — multi-backend session routing
├── factory.test.ts          # tests Pi+Claude-Code coexistence (already references 'pi' as a kind)
├── routing-as-backend.ts    # adapts RoutingBackend to AgentBackend for legacy callsites
├── wiring.ts                # composition root — wireAgentBackend()
├── active-sessions.ts       # JSONL-derived liveness writer
├── active-sessions.test.ts
├── resume.ts                # resumeActiveSessions() — boot-time sweep
├── resume.test.ts
├── mcp-deps.ts              # Sovereign MCP server dependency wiring
└── claude-code/             # full Claude Code adapter
    ├── claude-code.ts
    ├── config.ts
    ├── events.ts
    ├── history.ts
    ├── personality.ts
    ├── personality-compiler.ts
    ├── path-encoding.ts
    ├── mcp-server.ts
    ├── classify.ts          # TurnKind classifier
    ├── types.ts
    └── *.test.ts
```

Delta this spec adds:

```
packages/agent-backend/src/
└── pi/                      # NEW — sibling of claude-code/
    ├── pi.ts                # createPiBackend(config, deps): AgentBackend  (matches createClaudeCodeBackend signature)
    ├── config.ts            # piConfigFromStore(configStore, dataDir)
    ├── events.ts            # Pi event → AgentBackendEvents translator
    ├── history.ts           # Pi v3 tree JSONL → ParsedTurn linearisation
    ├── classify.ts          # TurnKind classifier for Pi-emitted envelopes (custom message types per §17.7)
    ├── subagents.ts         # spawn_subagent tool registration + sovereign-orchestrated lifecycle
    ├── extensions.ts        # extension loader, hot-reload watcher, context.mutation emitter (pi-principles-spec.md §3.3-3.4)
    ├── mcp-bridge.ts        # mount Sovereign's MCP server on Pi as a tool source
    ├── types.ts
    └── *.test.ts
```

Public surface additions in `packages/agent-backend/src/index.ts`:

```ts
export { createPiBackend, piConfigFromStore, type PiBackend, type PiBackendDeps, type PiConfig } from './pi/index.js'
```

`@sovereign/primitives.SessionsRegistry`, `createActiveSessions`, `createSovereignMcpServer`, `createPersonalityCompiler` — all already shipped — are reused by Pi the same way Claude Code uses them. Pi does NOT get its own registry.

---

## 6. Configuration

Config is no longer env-driven — `8654a85` migrated everything to `~/.sovereign/data/config.json`. Pi support requires schema and defaults additions:

### `packages/config/src/schema.ts`

```ts
agentBackend: {
  type: 'object',
  properties: {
    enabled: {
      type: 'array',
      items: { type: 'string', enum: ['claude-code', 'pi'] },  // widened
      'x-reload': 'restart'
    },
    default: { type: 'string', enum: ['claude-code', 'pi'], 'x-reload': 'restart' },
    claudeCode: { /* unchanged */ },
    pi: {                                                     // NEW block
      type: 'object',
      properties: {
        cwd: { ...stringSession },                            // default: workspace root
        agentDir: { ...stringSession },                       // default: ~/.pi/agent
        defaultProvider: { ...stringSession },                // e.g. 'anthropic'
        defaultModel: { ...stringSession },
        defaultThinkingLevel: { ...stringSession },           // off|minimal|low|medium|high|xhigh
        extensionsDir: { ...stringSession },                  // default: ~/.sovereign/extensions
        orgExtensionsDir: { ...stringSession },               // optional per-org override
        systemPromptTokenCeiling: {                           // R-MC-3 — default 2000
          type: 'number',
          'x-reload': 'restart'
        }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
}
```

### `packages/config/src/defaults.ts`

```ts
agentBackend: {
  enabled: ['claude-code'],                                   // unchanged default — operator opts into Pi
  default: 'claude-code',
  claudeCode: { /* unchanged */ },
  pi: {
    cwd: '',                                                  // resolved at runtime to workspace root
    agentDir: home ? path.join(home, '.pi', 'agent') : '',
    defaultProvider: 'anthropic',
    defaultModel: '',
    defaultThinkingLevel: 'off',
    extensionsDir: home ? path.join(home, '.sovereign', 'extensions') : '',
    orgExtensionsDir: '',
    systemPromptTokenCeiling: 2000
  }
}
```

### `wireAgentBackend()` addition

In [`packages/agent-backend/src/wiring.ts`](../packages/agent-backend/src/wiring.ts), the `factories` map gains a `pi:` entry:

```ts
factories: {
  'claude-code': () => { /* existing */ },
  pi: () => createPiBackend(piConfigFromStore(configStore, dataDir), {
    sovereignMcpServer,
    registry: { /* same upsert/lookup shape claude-code uses */ },
    toolPolicy: makeToolPolicy(orgManager),
    activeSessions
  })
}
```

The factory is constructed only if `'pi'` is in `enabledBackends`. Same lazy-construction pattern Claude Code already uses.

### Hot-reload semantics

- Per [PRINCIPLES.md §4](../PRINCIPLES.md), every config key declares `'x-reload': 'hot' | 'session' | 'restart'`.
- `enabled` and `default` are `restart` (changing the set of backends requires re-wiring).
- `cwd`, `agentDir`, `defaultModel`, `defaultThinkingLevel`, `extensionsDir` are `session` (apply to new sessions; existing sessions keep their bound config).
- `systemPromptTokenCeiling` is `restart` (enforcement check happens at session construction).

---

## 7. Subagents — Detailed Requirements

Pi declares `BackendCapabilities.subagents = 'sovereign-orchestrated'`. Sovereign already orchestrates subagents for Claude Code via the existing `ActiveSessions.subagents` field and the `subagent.spawned`/`subagent.completed`/`subagent.failed` bus events. Pi's adapter uses the same orchestration; what's new is the spawn mechanism (Pi tool registration vs Claude Code's tool harness).

### Implementation

Register a `spawn_subagent` `AgentTool` with the Pi session at construction. When the LLM invokes it, the tool:

1. Creates a new Pi session via `runtime.newSession()` with a constrained tool set (R-SA-11) and the parent's `cwd`.
2. Writes a `SessionsRegistry` record with `kind: 'subagent'`, `parentSessionKey`, `backendKind: 'pi'`.
3. Calls `activeSessions.upsert(...)` to mark the child working.
4. Emits `subagent.spawned`.
5. Subscribes to the child's events, surfacing `turn_end` summaries via `onUpdate` (R-SA-10).
6. On completion, emits `subagent.completed` and removes the child from `activeSessions`.
7. Returns the child's final assistant text plus `details.childKey` to the parent.

### Requirements (MUST)

- **R-SA-1.** Subagents MUST be first-class entries in `SessionsRegistry` (`kind: 'subagent'`, `parentSessionKey` set). This is already the registry's shape ([`packages/primitives/src/sessions-registry.ts`](../packages/primitives/src/sessions-registry.ts)).
- **R-SA-2.** Subagent events MUST be exposed via the same `AgentBackendEvents` bus, keyed by the child's session key, so existing client subscriptions cover Pi children without change.
- **R-SA-3.** Active subagent status MUST update on every `turn_end` (working → idle) and `agent_end` (final → done).
- **R-SA-4.** `/api/threads/active-subagents` MUST return Pi subagents grouped by `parentSessionKey` alongside Claude Code subagents — already routed via `RoutingBackend.registry`.
- **R-SA-5.** `/api/threads/:key/subagents` MUST resolve children via `parentSessionKey`, not session-key prefix pattern-matching.
- **R-SA-6.** Subagent transcripts MUST be readable through `backend.getHistory(childKey)` where `backend = routing.forSession(childKey)`.
- **R-SA-7.** Cancelling the parent MUST cancel running children. The tool's `signal` parameter wires this for free.
- **R-SA-8.** Subagent tool MUST NOT recurse infinitely — depth limit (default 3) enforced from the registry's parent chain.
- **R-SA-9.** Pi's `terminate: true` return value MUST be supported so a successful subagent can short-circuit the parent's next LLM call.

### Requirements (SHOULD)

- **R-SA-10.** The subagent tool SHOULD stream a brief progress line via `onUpdate` after each child `turn_end`.
- **R-SA-11.** Default child toolset SHOULD be `read`, `grep`, `find`, `ls`; `bash` and `edit` opt-in per spawn. (Matches [pi-principles-spec.md R-MC-4](pi-principles-spec.md#32-minimal-core--sovereign-restraint).)
- **R-SA-12.** Child JSONLs SHOULD live in a `subagents/` subdirectory of the parent's Pi session directory.
- **R-SA-13.** Cleanup: child JSONL retained while parent exists; deleted when parent is deleted.

---

## 8. Risks and Mitigations

| Risk | Mitigation |
| --- | --- | --- |
| Pi runs in-process; tool executions (`bash`) share the server's process. | Pi's `AgentTool.execute` accepts `AbortSignal`; long-running tools are async. Same risk profile Claude Code already carries — no regression. |
| `bash` tool runs in the Sovereign server's PID space. | Policy extension per [pi-principles-spec.md R-YO-2](pi-principles-spec.md#36-yolo--extensible-security--wire-the-hooks) gates by `beforeToolCall`. Org-level allowlist via `toolPolicy` already wired through `wireAgentBackend()`. |
| Pi's default `cwd` is process cwd; need explicit per-session. | `piConfigFromStore` passes `cwd` explicitly to every `createAgentSession`. Per-thread `cwd` deferred (§16 decision 4). |
| Pi v3 tree JSONL ≠ Claude Code linear JSONL. | New `pi/history.ts` linearises depth-first from root to active leaf. Mirrors what Claude Code's `history.ts` does for its format. |
| `tool_execution_update` has no current UI surface. | Swallow; document as deferred. WorkItem extension is a follow-up (§16 decision 3). |
| Concurrent prompts during streaming. | Pi requires explicit `streamingBehavior: 'steer' | 'followUp'`. Map "send while busy" to `'steer'` (matches Sovereign's current implicit interrupt UX). |
| Hot-reload of Pi extensions could crash a running session. | [pi-principles-spec.md R-HR-3](pi-principles-spec.md#34-hot-reload--beyond-config-to-extensions) — failed reload MUST keep the previous version active and surface a `extension_reload_failed` WorkItem; no crash propagation. |
| Pi version bumps silently change system prompt or tool definitions. | [pi-principles-spec.md R-CS-5](pi-principles-spec.md#31-context-sovereignty--enforcement) — version pinned exactly, every bump accompanied by a context-delta report. |

---

## 9. Phasing

### Phase A — Land Pi backend factory

- New `pi/pi.ts`, `pi/events.ts`, `pi/history.ts`, `pi/classify.ts`, `pi/config.ts`.
- Widen `agentBackend.enabled`/`default` enums in config schema + defaults.
- Wire Pi factory into `wireAgentBackend()`.
- Implement `listSessions`, `listSubagents` (returns `[]` initially), `getSessionMeta`, `setSessionModel`, `listAvailableModels`, `getContextBudget`, `getSessionFilePath`, `getActivityMap` — same surface Claude Code implements.
- Pi tests (`pi.test.ts`, `events.test.ts`, `history.test.ts`, `classify.test.ts`) mirror Claude Code's coverage.

**Acceptance:** with `agentBackend.default = 'pi'`, a new thread bound to Pi can send a message, get a streamed response with tool calls, abort, switch model, see history, switch threads. Subagents are non-functional but don't crash. Claude Code threads in the same process keep working unchanged.

### Phase B — Subagents

- Implement `pi/subagents.ts` per §7.
- Register `spawn_subagent` Pi tool at session construction.
- Wire into `ActiveSessions.subagents` and `subagent.*` bus events.

**Acceptance:** a Pi thread spawns a subagent via tool call; child appears in the drawer; child completes; result returns to parent; subagent drawer matches Claude Code parity.

### Phase C — Extension authoring loop (doctrine work)

Per [pi-principles-spec.md §3.3-3.4](pi-principles-spec.md#33-self-modifying--make-it-a-first-class-workflow):

- Implement `pi/extensions.ts` — extension loader, hot-reload watcher.
- Ship Pi extension docs under `PI_AGENT_DIR/docs/extensions/` (build step writes them; CI verifies presence).
- Build first-party `sovereign-extension-author` extension that lets the agent propose / smoke-test / commit extensions inside a session.
- Emit `context.mutation` events for every extension load/unload/reload.
- UI surfaces the `extension_loaded` banner in any subscribed thread.

**Acceptance:** operator says "I need a tool that does X"; agent reads the docs via a built-in tool, writes a TypeScript extension under `~/.sovereign/extensions/`, hot-loads it, calls it within the same session. The extension file is visible in the transcript with content hash; operator approves promotion to default for the thread.

### Phase D — Doctrine compliance — context mutation

Per [pi-principles-spec.md §3.1](pi-principles-spec.md#31-context-sovereignty--enforcement):

- Define `context.mutation` event in `@sovereign/core/bus`.
- Emit from every system-prompt assembly, compaction event, extension load, custom-message-type insertion.
- CI test that asserts no Pi-bound code path can insert text into a session's message list without a corresponding bus event.
- UI surface: per-thread "context history" view that renders every mutation in transcript position.

**Acceptance:** every change to a session's context window is observable in the UI and the bus log.

### Phase E — Policy and review (doctrine work, cross-cutting)

Per [pi-principles-spec.md §3.6, §3.7](pi-principles-spec.md#36-yolo--extensible-security--wire-the-hooks):

- First-party `sovereign-extension-policy` extension (`beforeToolCall`/`afterToolCall` driven by `~/.sovereign/orgs/<org>/policy.yaml`).
- `CODEOWNERS.criticality` parsing in `@sovereign/review`.
- Review surface tags every changed file with criticality; agent-edited critical files block auto-merge.
- Booboo-budget telemetry per thread.

Not Pi-specific — applies to all backends — but Phase E is the doctrine landing for both Pi and Claude Code. Sequence after Phase C.

---

## 10. Configuration Migration

For operators who already have a `~/.sovereign/data/config.json` from before this revision:

- `agentBackend.enabled` and `agentBackend.default` already exist as `['claude-code']` / `'claude-code'`. No-op until operator opts in.
- Operator opt-in: edit config to `enabled: ['claude-code', 'pi']` and optionally `default: 'pi'`. Restart Sovereign.
- Pi-specific config block (`agentBackend.pi`) gets populated from defaults on first load if absent.

No data migration. Pi sessions are created fresh per-thread.

---

## 11. Verification Checklist

Before flagging Phase A complete:

- [ ] `pnpm build` succeeds; type-check passes across all workspaces.
- [ ] `pnpm test` passes; `pi/*.test.ts` covers the same matrix `claude-code/*.test.ts` covers.
- [ ] `factory.test.ts` updated to construct both backends with real factories (currently uses stubs).
- [ ] With `agentBackend.default = 'pi'` and `agentBackend.enabled = ['claude-code', 'pi']`, send a message on a new Pi-bound thread; observe streamed text and tool calls in real time.
- [ ] Abort mid-stream; status returns to idle; `activeSessions.remove` fires.
- [ ] Switch to a Claude Code thread; both backends remain healthy.
- [ ] Change model via the thread header dropdown on a Pi thread; next prompt uses new model.
- [ ] Trigger a cron job targeting a Pi thread; `CronService` → `routing.forSession` → Pi `sendMessage` path delivers it; queue bubble surfaces; transcript shows the delivery as a typed `cron-fired` TurnKind.
- [ ] Spawn a subagent via tool call (Phase B); appears in drawer; result returns to parent.
- [ ] Restart Sovereign mid-prompt; `resumeActiveSessions()` re-attaches the Pi thread; transcript shows the mid-turn-no-response continuation per lossless-restart-spec.md.
- [ ] Kill the process during streaming; on restart, no zombie state, no lock files held; Pi JSONL on disk is consistent.
- [ ] `/api/system/health` reports `agentBackend.pi: 'connected'`.
- [ ] No new `~/.openclaw/` references introduced (`git grep` clean).
- [ ] `context.mutation` events fire for system prompt assembly and compaction on Pi sessions (Phase D).
- [ ] CI asserts the Sovereign-authored portion of Pi's system prompt is ≤ `systemPromptTokenCeiling` ([pi-principles-spec.md R-MC-3](pi-principles-spec.md#32-minimal-core--sovereign-restraint)).

---

## 12. Resolved Design Decisions

Carried from Rev 1, unchanged unless noted.

1. **Expose Pi's `steer()` and `followUp()` to the client — nice-to-have, follow-up phase.** Migration default: "send while streaming" maps to `steer` (matches today's implicit behaviour). After Phase A, optionally surface explicit "steer" vs "queue for after" affordances. New WS/SSE messages `chat.steer` and `chat.followUp` MAY be added.
2. **`AGENTS.md` discovery — defer.** Pi's `DefaultResourceLoader` walks up from `cwd` looking for `AGENTS.md`. For Phase A we MUST pass an explicit `cwd` to each session but do not rely on `AGENTS.md` injection. `AGENTS.md` content, when adopted, counts against the Sovereign system-prompt token ceiling ([pi-principles-spec.md R-MC-3](pi-principles-spec.md#32-minimal-core--sovereign-restraint)).
3. **Pi extensions — open runtime, doctrine-governed.** **Revised from Rev 1.** The original spec said "closed runtime — Sovereign does NOT load Pi extensions." That contradicts [pi-principles-spec.md Thesis 3](pi-principles-spec.md#thesis-3--self-modifying--malleable). Extensions ARE the surface; Sovereign-native modules register as extensions. Phase C lands the workflow.
4. **Per-thread `cwd` — out of scope for Phase A.** All Pi sessions in a process share `agentBackend.pi.cwd`. The registry shape already supports `ThreadSessionRecord.cwd?` for future per-thread routing.
5. **Richer token accounting — defer.** Pi's per-message `Usage` is captured into the registry; only legacy fields are surfaced. Cost-per-thread dashboard is a follow-up.
6. **Sovereign MCP tools as Pi tools — yes, via mcp-bridge.** The same `sovereignMcpServer` Claude Code uses is mounted on Pi sessions as an MCP source (`pi/mcp-bridge.ts`). No duplication of tool registrations.

---

## 13. Capabilities Pi Unlocks

These remain aspirational — they're what Phase A through E earn back. Documented so we don't lose track of what's now feasible. Unchanged from Rev 1 §17 unless noted.

### 13.1 Architecture & Operational Wins (free, immediate from Phase A)

- **No external daemon** — Pi runs in-process, same as Claude Code's SDK adapter does.
- **No IPC tax** — sub-millisecond in-process method calls.
- **AbortSignal flows end-to-end into tools.** Pi's `tool.execute(toolCallId, args, signal, onUpdate)` makes cancellation first-class. Today Claude Code abort is best-effort SDK.
- **Awaited subscriber settlement (`agent_end` barrier).** Pi guarantees `await session.prompt()` resolves only after every subscriber finishes processing `agent_end`. Lets Sovereign reliably flush registry updates and `activeSessions.remove` without races.
- **Supply-chain hardening.** Pi's package pins exact versions, uses `min-release-age=2`, ships `npm-shrinkwrap.json`, runs scheduled `npm audit`.

### 13.2 Streaming & Event-Model Improvements

- **Tool execution updates (`tool_execution_update`).** Pi streams partial tool output. Today Sovereign sees results only on completion. UI improvements: live `bash` output, live file-read progress, live subagent transcript snippets — all within the same `WorkItem` model with a small core extension.
- **Thinking deltas are first-class.** `message_update.thinking_delta` is a typed event, not a string heuristic.
- **`queue_update` events.** Pi emits when steering/follow-up queues change. Drives a queue indicator without polling.
- **`compaction_start` / `compaction_end` are explicit.** Sovereign's `chat.compacting` event becomes a clean 1:1 mapping.
- **`auto_retry_start` / `auto_retry_end` events.** Surface "Retrying in Xs…" instead of generic stall.

### 13.3 Session Model Improvements

- **Tree-structured sessions (v3 JSONL with `id`/`parentId`).** Pi sessions are trees:
  - **Branching.** `runtime.fork(entryId)` creates a new active branch without copying.
  - **In-place navigation.** `session.navigateTree(targetId)` rewinds the active leaf.
  - **Alternative explorations.** Useful for the planning module — alternate plan branches as session forks.
- **Compaction is an explicit API.** `session.compact(customInstructions?)`, `session.abortCompaction()`, `transformContext` hook. Sovereign can trigger on demand, pass per-thread instructions, set thresholds per-thread.
- **`shouldStopAfterTurn` hook.** Stop gracefully after current turn. Useful for compaction-on-demand and "park this agent" UX.
- **`importFromJsonl`.** Import any JSONL — Pi format, claude-cli, anything we can map.
- **Per-cwd session directories.** `~/.pi/agent/sessions/--<cwd>--/` — pre-bakes future per-thread-`cwd`.
- **Explicit `sessionId` for provider prompt caching.** Pi passes a `sessionId` to provider cache-control headers — fine-grained cost control.

### 13.4 Tool Runtime Improvements

- **First-class tool registration with schema validation.** `AgentTool` uses `typebox` parameter schemas.
- **Parallel tool execution.** Pi runs independent tool calls concurrently. Single-shot speedup for read-heavy turns.
- **`beforeToolCall` hook for policy enforcement.** Lands the policy extension per [pi-principles-spec.md R-YO-2](pi-principles-spec.md#36-yolo--extensible-security--wire-the-hooks). Today Claude Code has `onPreToolUse` doing similar — Pi will plug into the same `toolPolicy` callback wired in `wireAgentBackend()`.
- **`afterToolCall` hook.** Post-process every tool result. Inject metadata, redact, surface as additional `WorkItem`s.
- **`terminate: true` from tools.** Tools hint that the agent should stop. No need for fake user messages.
- **Streaming tool progress (`onUpdate`).** Long-running tools no longer appear stuck.
- **Sovereign-native tools as Pi extensions.** Per Decision 3. The `mcp-deps` machinery already pipes Sovereign's modules through MCP — Pi mounts the same MCP server, so all existing tools come along for free.

### 13.5 Multi-Provider & Auth Improvements

- **Many providers out of the box.** Anthropic API + Claude Pro/Max subscription, OpenAI API + ChatGPT subscription, GitHub Copilot subscription, Google Gemini, Vertex, Bedrock, Azure, Mistral, DeepSeek, Groq.
- **Subscription auth, not just API keys.** Non-developer Sovereign users can sign in to Pi via `/login` instead of provisioning API keys.
- **OAuth refresh built-in.** `getApiKey: async (provider) => refreshToken()` hook.
- **Custom models via `models.json`.** Register any OpenAI-compatible endpoint — local LLMs, proxies, private deployments.
- **`scopedModels`** for fast cycling — maps to a per-thread model dropdown with a curated set.
- **Runtime API-key overrides.** `authStorage.setRuntimeApiKey(provider, key)` — per-thread, per-org credentials.
- **Per-thinking-level token budgets.** `thinkingBudgets: { minimal: 128, ..., xhigh: 2048 }` — tune thinking spend per-thread.

### 13.6 Steering & Follow-up

- **`steer()`** — formalised mid-turn interrupt.
- **`followUp()`** — queue work for after the agent stops.
- **`steeringMode: "all"`** — process every queued steer instead of one-at-a-time. Useful for voice mode.
- **`clearSteeringQueue()` / `clearFollowUpQueue()`** — explicit queue management.

### 13.7 Custom Message Types

Per Rev 1, with the doctrine wrapper: every custom message MUST also emit `context.mutation { kind: 'custom_message_inserted', ... }` ([pi-principles-spec.md R-CS-1](pi-principles-spec.md#31-context-sovereignty--enforcement)).

```ts
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    sovereign_notification: { ... }
    sovereign_forwarded: { ... }
    sovereign_cron_result: { ... }
    sovereign_entity_event: { ... }
  }
}
```

Replaces today's string-envelope hacks where they persisted in Claude Code; the new TurnKind classifier system already covers most of these for Claude Code via typed envelopes.

### 13.8 Direct Bus Integration

- **Wire bus events into tools.** A `subscribe_to_bus` Pi tool lets the agent receive live events (CI results, review comments) without webhook plumbing.
- **Emit bus events from tools synchronously.** `bus.emit()` is in the same event loop.
- **Inline state inspection.** `session.agent.state.messages` is a JS array — the system view shows real conversation state.
- **Synchronous tool installation.** Hot-reload an extension and the agent picks it up on the next turn.

### 13.9 Sovereign Roadmap Alignment

Unchanged from Rev 1.

### 13.10 Future Capabilities Now Cheap

- **Multi-agent orchestration.** Multiple `AgentSession` instances in the same process, sharing the bus, typed messages flowing between them.
- **Agent ensembles.** Spawn N sessions with different models on the same prompt; pick best.
- **Speculative execution.** Fork a session, try a destructive action, roll back.
- **Replay & debugging.** `importFromJsonl` + read-only mode = replay for bug repro.
- **Time-travel debugging.** `navigateTree(turnId)` rewinds; replay from any point.
- **Per-org credential isolation.** Multiple `AuthStorage` instances scoped per-org.
- **Cost telemetry.** Aggregate Pi's per-message cost into the system view.
- **LLM-as-tool.** Register a sub-LLM as a Pi tool.
- **Voice latency reduction.** In-process path = no WebSocket round-trip from STT to first delta.

---

## 14. Open Questions

(None — the open questions from Rev 1 are either resolved by the doctrine spec or moved to [pi-principles-spec.md §6](pi-principles-spec.md#6-open-questions). New questions raised during implementation append here with a date.)
