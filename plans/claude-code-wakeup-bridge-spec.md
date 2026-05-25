# Claude Code Wakeup Tools — Block-and-Substitute

**Status:** Ready to implement **Revision:** 3 (decided: block, not bridge) **Date:** 2026-05-25

Block the Claude Agent SDK's built-in scheduling tools (`ScheduleWakeup`, `CronCreate`, `CronList`, `CronDelete`) at the `PreToolUse` hook with a message redirecting the agent to Sovereign's equivalents (`sovereign.cron_create`, `sovereign.cron_list`, `sovereign.cron_delete`). Conforms to [PRINCIPLES.md](../PRINCIPLES.md).

## Why block (decision recap)

Sovereign's `CronService` is strictly more powerful than the SDK's built-ins for autonomous work:

- Targets any thread / backend, not just the calling session.
- Fires through `messageQueue` → `chat.queue` SSE → visible queue bubble → audit-trail-as-history.
- Cancellable from any device via `DELETE /api/chat/queue/:id`.
- Bus events can trigger sends (not just wall-clock cron).
- One canonical durable file (`<dataDir>/scheduler/jobs.json`), survives restart, no separate daemon.

The SDK's tools assume the CLI process model and a `claude daemon` we deliberately do not run. Mirroring them via PostToolUse adds an id-mapping table, a persistence layer, schema-validation risk on `CronList`, and a daemon-collision risk (OQ-4 in the prior revision) — all to preserve the built-in `/loop` slash command. We don't use `/loop`. Block.

## What gets blocked

```ts
const WAKEUP_TOOLS = new Set(['ScheduleWakeup', 'CronCreate', 'CronList', 'CronDelete'])
```

`RemoteTrigger` (cloud routines on `claude.ai/code/routines`) is out of scope — it doesn't share the in-process firing problem and may be useful independently. Leave it alone.

## Implementation

Single branch added to the existing `onPreToolUse` hook in [packages/agent-backend/src/claude-code/claude-code.ts](../packages/agent-backend/src/claude-code/claude-code.ts), placed **before** the per-org toolPolicy check so the message is consistent regardless of org config:

```ts
const WAKEUP_REDIRECT: Record<string, string> = {
  ScheduleWakeup: 'sovereign.cron_create with schedule.kind="oneshot" and a future "at" timestamp',
  CronCreate: 'sovereign.cron_create',
  CronList: 'sovereign.cron_list',
  CronDelete: 'sovereign.cron_delete'
}

const onPreToolUse = async (input: HookInput) => {
  if (input.hook_event_name !== 'PreToolUse') return { continue: true }
  const inp = input as Extract<HookInput, { hook_event_name: 'PreToolUse' }>

  // Sovereign-managed sessions own scheduling. The SDK's built-in
  // wakeup tools depend on `claude daemon`, which we deliberately do
  // not run — their schedules would never fire and would bypass the
  // Sovereign message queue (no audit trail, no UI visibility).
  // Redirect the agent to the Sovereign-native equivalents.
  if (WAKEUP_TOOLS.has(inp.tool_name)) {
    const target = WAKEUP_REDIRECT[inp.tool_name]
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason:
          `This Sovereign-managed session does not support ${inp.tool_name}. ` +
          `Use ${target} instead — it schedules through Sovereign's own scheduler ` +
          `which fires the prompt back into this thread via the standard message queue.`
      }
    }
  }

  // … existing toolPolicy branch unchanged …
}
```

That's the whole change. The agent receives a denial with a clear next step on its next inference, and the existing `sovereign.cron_create` / `sovereign.cron_list` / `sovereign.cron_delete` MCP tools (already registered in [mcp-server.ts:106](../packages/agent-backend/src/claude-code/mcp-server.ts#L106)) handle the actual work.

## Tests

Two unit tests in `packages/agent-backend/src/claude-code/claude-code.test.ts` alongside the existing PreToolUse coverage:

1. `PreToolUse` for `tool_name: 'ScheduleWakeup'` returns `permissionDecision: 'deny'` with reason mentioning `sovereign.cron_create`.
2. `PreToolUse` for `tool_name: 'CronList'` returns `permissionDecision: 'deny'` with reason mentioning `sovereign.cron_list`.

(Two suffices — the dispatch table is trivial; explicit per-tool tests are not adding signal.)

## Acceptance Criteria

1. **Given** the agent calls `ScheduleWakeup({delaySeconds: 60, prompt: 'p'})`, **when** the tool runs, **then** PreToolUse denies it with a `permissionDecisionReason` naming `sovereign.cron_create`. The agent's next inference uses `sovereign.cron_create({schedule: {kind:'oneshot', at: <ISO>}, prompt: 'p'})`.
2. **Given** the agent calls `CronCreate` / `CronList` / `CronDelete`, **when** any runs, **then** each is denied with a redirect to the corresponding `sovereign.*` tool.
3. **Given** the agent successfully creates a Sovereign cron, **when** the schedule fires, **then** the prompt lands in the thread's `messageQueue` and renders as a queue bubble in the standard `queued → sending → removed` lifecycle observable via SSE.
4. **No invocation of `claude daemon`** is required. `claude daemon status` MAY remain "not running" indefinitely.

## Scope

- 1 file touched (~15 LOC implementation + ~10 LOC tests).
- No new persistence layer, no id-mapping table, no new module.
- Implementation + tests should take under 30 minutes; live verification under 5 minutes.

## Loss accepted

- Built-in `/loop` slash command no longer functions (it issues `ScheduleWakeup` calls under the hood). Acceptable — Sovereign's cron primitives subsume the use case and offer cross-thread/cross-backend reach the slash command never had.
- `tengu_loop_dynamic_*` telemetry events will fire less (the SDK's internal handler never runs because we deny before it). Pure metrics impact; no user-visible behaviour change.
