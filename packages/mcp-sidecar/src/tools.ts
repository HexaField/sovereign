// Tool registry for the standalone MCP sidecar.
//
// Each tool here has the SAME schema (name, description, zod args) as the
// in-process server's tool. Handlers are uniformly `forward(toolName, args)`
// — every call becomes one HTTP request to the Sovereign daemon's
// `/api/mcp-rpc/:tool` endpoint. No business logic lives here.
//
// If you add a tool to `packages/agent-backend/src/claude-code/mcp-server.ts`
// AND to `packages/agent-backend/src/mcp-rpc-routes.ts:buildHandlers`, mirror
// the schema here. The sidecar publishes the catalog — the daemon executes.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ForwardFn } from './forward.js'

/** Tool definitions are heterogeneous in their schema shapes; widen to
 *  the SDK's own `any`-parameterised type so the array can hold all 16
 *  without TS collapsing to an empty intersection. Matches what the
 *  SDK's own `Options.tools?: Array<SdkMcpToolDefinition<any>>` accepts. */
export type SidecarTool = SdkMcpToolDefinition<any>

/**
 * Build the tool array. `forward` does the HTTP round-trip to Sovereign.
 * Returning the SDK-shaped `{content: [...]}` lets the MCP server stream
 * it back to Claude Code verbatim.
 */
export function buildTools(forward: ForwardFn): SidecarTool[] {
  // The strict per-tool inference inside `tool()` produces handler types
  // with contravariant args (e.g. `args: { orgId: string, ... }`), which
  // doesn't unify with the `any`-widened `SidecarTool`. Cast at the array
  // boundary — runtime is fine, the SDK consumes them all uniformly.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const t = tool as unknown as (...args: any[]) => SidecarTool
  /* eslint-enable */
  /**
   * Shorthand. `args` typing is widened to `any` because the SDK's `tool()`
   * generic infers a tight per-tool shape and the helper itself can't
   * stay polymorphic without an explicit type parameter at every call
   * site. The runtime contract is fine — handlers always pass the args
   * object straight to `forward`, which serialises to JSON.
   */
  const fwd = (name: string) => async (args: any) => forward(name, args)

  return [
    // ── cron ────────────────────────────────────────────────────────────────
    t(
      'cron_create',
      'Schedule a future user-message. Defaults to the CALLING thread when `threadKey` is omitted — i.e. the message is delivered back into the same thread the agent is currently running in. Pass `threadKey` explicitly only to cross-post into a different thread.',
      {
        threadKey: z
          .string()
          .optional()
          .describe(
            'Optional. Logical thread key — bare name (e.g. "v2-app") or full `agent:main:thread:<x>` form. When omitted, defaults to the calling thread. Pass `"main"` (or any other thread) to target a different one.'
          ),
        when: z
          .object({
            kind: z.enum(['cron', 'interval', 'oneshot']),
            expr: z.string().optional().describe('Cron expression when kind=cron.'),
            tz: z.string().optional(),
            everyMs: z.number().optional().describe('Interval in ms when kind=interval.'),
            at: z.string().optional().describe('ISO8601 timestamp when kind=oneshot.')
          })
          .describe('Schedule: { kind: "cron", expr } | { kind: "interval", everyMs } | { kind: "oneshot", at }.'),
        prompt: z
          .string()
          .describe('The user-message text to deliver at fire time. Sovereign wraps it with a [Cron: …] envelope.'),
        label: z.string().optional()
      },
      fwd('cron_create')
    ),
    t(
      'cron_list',
      'List Sovereign-managed cron jobs, optionally filtered to a specific thread.',
      { threadKey: z.string().optional() },
      fwd('cron_list')
    ),
    t('cron_delete', 'Cancel a Sovereign cron job by id.', { id: z.string() }, fwd('cron_delete')),

    // ── sessions ────────────────────────────────────────────────────────────
    t(
      'sessions_list',
      'List Sovereign sessions/threads visible across enabled backends.',
      { backendKind: z.enum(['pi', 'claude-code']).optional() },
      fwd('sessions_list')
    ),
    t(
      'sessions_send',
      'Deliver a user message into another Sovereign thread. Use this to coordinate across threads instead of asking the user to relay.',
      {
        sessionKey: z.string().describe('Target session key — canonical (agent:main:thread:<x>) or bare thread name.'),
        text: z.string()
      },
      fwd('sessions_send')
    ),
    t(
      'sessions_history',
      'Read recent turns from another Sovereign thread for context.',
      { sessionKey: z.string(), limit: z.number().int().min(1).max(200).optional().default(20) },
      fwd('sessions_history')
    ),

    // ── agents ──────────────────────────────────────────────────────────────
    t(
      'agents_list',
      'List live subagents, optionally filtered to a specific parent.',
      { parentSessionKey: z.string().optional() },
      fwd('agents_list')
    ),
    t(
      'agents_spawn',
      'Spawn a Sovereign-tracked subagent under the current parent session. Use when the model wants a tracked subagent record (the Task tool is the lighter-weight alternative for ad-hoc work).',
      { task: z.string(), label: z.string().optional(), parentSessionKey: z.string().optional() },
      fwd('agents_spawn')
    ),

    // ── browser ─────────────────────────────────────────────────────────────
    t(
      'browser_open',
      'Open a managed browser session at a URL. Returns a sessionId you pass to browser_act / browser_close. The summary lists interactive elements with `[r1]`, `[r2]` refs you can target in subsequent acts.',
      {
        url: z.string().describe('URL to navigate to immediately.'),
        headed: z.boolean().optional().describe('Show the browser window (default: headless).'),
        viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
        sessionId: z.string().optional().describe('Reuse an existing browser session id (re-navigates to url).')
      },
      fwd('browser_open')
    ),
    t(
      'browser_act',
      "Act on an open browser session. The `action` is a discriminated union — pick a `kind` and the fields that go with it. Kinds: 'navigate' (url, waitUntil?), 'click' (ref|selector|{x,y}, doubleClick?, button?), 'type' (text, ref|selector, submit?), 'fill' (text, ref|selector), 'press' (key, ref?|selector?), 'hover' (ref|selector), 'scroll' (deltaX?, deltaY?, ref?|selector?), 'wait' (timeMs?|selector?|loadState?), 'snapshot' (mode?: 'aria'|'text'), 'screenshot' (fullPage?, selector?), 'evaluate' (fn: JS string returning JSON-serializable value), 'extract' (selector?), 'close'.",
      {
        sessionId: z.string(),
        action: z
          .object({
            kind: z.enum([
              'navigate',
              'click',
              'type',
              'fill',
              'press',
              'hover',
              'scroll',
              'wait',
              'snapshot',
              'screenshot',
              'evaluate',
              'extract',
              'close'
            ])
          })
          .catchall(z.unknown())
      },
      fwd('browser_act')
    ),
    t(
      'browser_close',
      'Close a managed browser session and release its tab.',
      { sessionId: z.string() },
      fwd('browser_close')
    ),

    // ── notifications ───────────────────────────────────────────────────────
    t(
      'notifications_send',
      'Push a notification to the user surface.',
      {
        title: z.string(),
        body: z.string().optional(),
        severity: z.enum(['info', 'warning', 'error']).optional().default('info'),
        entityId: z.string().optional()
      },
      fwd('notifications_send')
    ),

    // ── meetings ────────────────────────────────────────────────────────────
    t(
      'read_meeting',
      'Read a meeting transcript or summary by id, or list recent meetings when no id is provided.',
      { orgId: z.string(), meetingId: z.string().optional(), limit: z.number().optional() },
      fwd('read_meeting')
    ),

    // ── planning / issues ───────────────────────────────────────────────────
    t(
      'create_issue',
      'Create an issue / planning node in a Sovereign org/project. Routes through the planning service.',
      {
        orgId: z.string(),
        projectId: z.string(),
        remote: z.string().describe('Remote name (e.g. "origin").'),
        title: z.string(),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional()
      },
      fwd('create_issue')
    ),
    t(
      'update_planning_node',
      'Update an existing planning node / issue.',
      {
        orgId: z.string(),
        projectId: z.string(),
        issueId: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        state: z.enum(['open', 'closed']).optional(),
        labels: z.array(z.string()).optional()
      },
      fwd('update_planning_node')
    ),

    // ── orgs ────────────────────────────────────────────────────────────────
    t('list_orgs', 'List Sovereign orgs/workspaces.', {}, fwd('list_orgs'))
  ]
}
