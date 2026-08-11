# Detached Session Sidecar — Design Spec

## Goal

Make a Sovereign rebuild stop severing in-flight LLM turns. Today `bin/sovereign build` kills the server, which kills every Claude Code SDK subprocess it spawned, which interrupts whatever the model was mid-way through. The resume orchestrator patches over this by injecting `[Resumed after server restart. Continue from where you left off.]` — a workaround that loses the turn's actual in-flight state and pollutes the transcript.

Instead: host agent sessions in **detached worker processes** that outlive the Sovereign server, and have the new server **reattach** to them on boot. A rebuild becomes invisible to the conversation.

## Non-Goals

- Changing how threads, history, or the JSONL transcript work
- Surviving a machine reboot (workers die with the login session; that's fine)
- Replacing the resume orchestrator — it stays as the fallback for workers that genuinely died

---

## Feasibility — verified, not assumed

Probed on the primary host against Claude Code 2.1.178 / SDK 0.3.220 (2026-07-27):

| Property | Result |
| --- | --- |
| `claude --bg -p "…"` dispatches a background session | ✅ returns a session id + `attach`/`logs`/`stop` verbs |
| Worker process parentage | **not a child of the daemon** — runs as `claude --bg-spare <sock>`, claiming a socket |
| Worker survives `daemon stop --any --keep-workers` | ✅ confirmed alive via `ps` across the gap |
| A _fresh_ daemon adopts the orphaned worker | ✅ `bg workers: 1 running, 1 in roster.json` |
| Work continued across the supervisor gap | ✅ 11,560 chars of assistant output landed in the transcript |
| `claude agents --json` sees Sovereign's existing sessions | ✅ all three, with pid / sessionId / cwd / startedAt |

The architecture rests on a supervisor (`claude daemon`) that owns a control socket and a `roster.json`, plus workers that claim sockets independently. Because workers aren't forked by the supervisor, supervisor death doesn't cascade.

---

## Architecture

```
                    ┌─────────────────────────────┐
  Sovereign  ──────▶│  claude daemon (supervisor) │
  (restarts freely) │  control.sock + roster.json │
                    └──────────────┬──────────────┘
                                   │ adopts on boot
                    ┌──────────────▼──────────────┐
                    │  bg worker (per thread)     │
                    │  claude --bg-spare <sock>   │  ← survives both
                    └─────────────────────────────┘
```

**Session lifecycle**

1. Thread's first message → dispatch a bg worker, record `{threadKey → sessionId, pid}` in a new `detached-sessions.json`
2. Subsequent messages → route into the existing worker
3. Sovereign restarts → read `detached-sessions.json`, call `claude agents --json`, match live workers by sessionId, reattach
4. Worker missing from the roster → fall through to today's resume orchestrator

**Reattach after a transport gap** — SDK 0.3.220's `Query.reinitialize()` is documented for exactly this: it re-sends `initialize` to an already-running CLI, and _"the CLI's response carries any `can_use_tool` / `request_user_dialog` control requests the loop is still blocked on, and the SDK redelivers them."_ That covers our AskUserQuestion case — a session parked on a question gets its pending request redelivered rather than lost.

---

## The blocker, and the two ways past it

`query()` accepts only `{prompt, options}`. There is **no `transport` or attach parameter**, and no daemon-attach option on `Options`. The `Transport` interface is exported but nothing public consumes it. So the TS SDK cannot currently say "attach to session X" instead of spawning a fresh subprocess.

**Option A — drive the CLI directly.** Replace the SDK's `query()` with CLI invocation for session lifecycle: `claude --bg -p` to dispatch, `claude agents --json` to poll, `claude attach` to reconnect. Everything needed is proven working today.

**Option B — wait for the SDK.** The plumbing is visibly in progress: `reinitialize()`, `daemonColdStart: 'transient' | 'ask'`, and a systemd unit template compiled into the binary but gated off (_"Service install is disabled in this version"_). When attach lands on `Options`, this becomes a small adapter change instead of a rewrite.

---

## Drawbacks

**1. Option A means abandoning the SDK for the hot path.** This is the big one. Sovereign's Claude Code adapter is ~1600 lines built around `query()`: streaming input via an async iterable, `chat.stream` / `chat.work` / `chat.turn` emission from typed SDK messages, hooks (`PreToolUse`, `SubagentStart`, `PreCompact`, …), `setModel`/`setSettings`/`setMcpServers` mid-session, and the in-process `sovereign` MCP server passed as an SDK object. Going CLI-first means re-deriving all of it from a text/JSON stream. Realistically a rewrite of the adapter's core, and it trades typed SDK messages for parsing a CLI contract that has no stability guarantee.

**2. The in-process MCP server probably can't come along.** Sovereign registers its MCP server as `McpSdkServerConfigWithInstance` — a live JS object, not a subprocess. A detached worker is a separate process and cannot hold a reference to it. Sovereign's own tools would have to move to the HTTP MCP endpoint (`/api/mcp` on the main server) for every session. Doable, but it adds a second migration riding on the first.

**3. Undocumented, un-versioned surface.** `--bg-spare`, `roster.json`, the socket layout under `/tmp/cc-daemon-1000/<hash>/`, and the adoption behaviour are all internal. None of it appears in public docs. A Claude Code patch release could change any of it without notice, and the failure mode is silent — sessions that stop reattaching.

**4. Orphan management becomes ours.** Workers that outlive their supervisor also outlive their usefulness. Sovereign would need to reap workers whose thread was deleted, whose session went stale, or that were left behind by a crash — plus surface them somewhere so they don't accumulate invisibly. New failure mode: leaked processes holding context windows and, if mid-turn, spending tokens.

**5. Debuggability gets worse.** Right now a session's lifetime is bounded by the server process, so `sovereign logs` tells the whole story. With detached workers, state spans three places (Sovereign, daemon, worker) with independent lifecycles. Diagnosing "why did this thread stop responding" gets meaningfully harder.

**6. It doesn't survive reboots anyway.** Workers live in `/tmp` under the login session. A machine restart, a logout, or a `systemctl --user` teardown still kills everything — so the resume orchestrator has to stay regardless. This buys rebuild-transparency, not durability.

**7. Real gain is narrower than it first sounds.** The win is: a rebuild during an active turn doesn't interrupt it. Rebuilds during idle threads already cost nothing, and the current Tier-3 auto-continue handles most interrupted cases acceptably. Weigh the rewrite against how often a rebuild actually lands mid-turn.

---

## Recommendation

**Don't build Option A yet.** The feasibility is proven, which is the valuable result — but the cost is an adapter rewrite against an undocumented interface, to fix a problem the resume orchestrator already handles imperfectly-but-adequately.

Suggested sequence:

1. **Now** — ship the independent wins: `cancel_queued: true` on the Stop button (~5 lines, real bug), and `claude agents --json` in the Service Health dropdown (free inventory).
2. **Watch** — track SDK releases for a daemon-attach option on `Options`. When it lands, revisit; Option B is a modest change rather than a rewrite.
3. **Revisit early if** — rebuilds-during-active-turns become frequent enough to be a daily irritation, or the SDK ships attach.

Revisit this spec when either trigger fires.
