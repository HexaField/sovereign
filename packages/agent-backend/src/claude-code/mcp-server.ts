// Sovereign-native MCP server registered with every Claude Code session.
// Wraps Sovereign modules (cron / sessions / agents / notifications /
// planning / meetings / orgs) as thin MCP tools.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'

/**
 * Sovereign modules surfaced to the agent. Each handler is a thin wrapper —
 * no business logic.
 */
export interface SovereignToolDeps {
  cron: {
    /**
     * Schedule a future user-message into a thread. Returns the cron id.
     */
    createUserMessageCron(opts: {
      threadKey: string
      schedule:
        | { kind: 'cron'; expr: string; tz?: string }
        | { kind: 'interval'; everyMs: number }
        | { kind: 'oneshot'; at: string }
      prompt: string
      label?: string
    }): Promise<{ id: string; schedule: string }>
    list(includeDisabled?: boolean): Promise<any[]>
    remove(id: string): Promise<void>
  }
  sessions: {
    list(filter?: { backendKind?: string }): Promise<Array<{ key: string; label?: string; kind?: string }>>
    send(sessionKey: string, text: string): Promise<void>
    history(sessionKey: string, limit?: number): Promise<Array<{ role: string; content: string }>>
  }
  agents: {
    list(
      parentSessionKey?: string
    ): Promise<Array<{ sessionKey: string; label: string; status: string; task?: string }>>
    spawn(parentSessionKey: string, opts: { task: string; label?: string }): Promise<{ sessionKey: string }>
  }
  notifications: {
    send(opts: { title: string; body?: string; severity?: string; entityId?: string }): { id: string }
  }
  planning: {
    createIssue(opts: {
      orgId: string
      projectId: string
      remote: string
      title: string
      body?: string
      labels?: string[]
      assignees?: string[]
    }): Promise<{ id: string; orgId: string; projectId: string; title: string }>
    updateIssue(opts: {
      orgId: string
      projectId: string
      issueId: string
      title?: string
      body?: string
      state?: string
      labels?: string[]
    }): Promise<{ id: string; orgId: string; projectId: string; title: string; state: string }>
  }
  orgs: {
    list(): Array<{ id: string; name: string; path: string }>
  }
  meetings: {
    list(orgId: string, limit?: number): Promise<Array<{ id: string; title: string; createdAt: string }>>
    read(
      orgId: string,
      meetingId: string
    ): Promise<{ id: string; title: string; transcript?: string; summary?: string } | null>
  }
  browser: {
    open(opts: {
      url: string
      headed?: boolean
      viewport?: { width: number; height: number }
      sessionId?: string
    }): Promise<{ sessionId: string; url: string; title: string; summary: string }>
    act(
      sessionId: string,
      action: any
    ): Promise<{
      message: string
      url?: string
      title?: string
      text?: string
      summary?: string
      imageBase64?: string
      imageMime?: string
    }>
    close(sessionId: string): Promise<void>
  }
  /** Used by `sovereign.sessions_send` source attribution; optional. */
  currentSessionKey?(): string | undefined
}

const okText = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const okJson = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] })

/**
 * Strip the canonical-key prefix so the value matches what
 * `cron.createUserMessageCron` expects (bare thread name).
 *
 *   `agent:main:thread:neural-nets` → `neural-nets`
 *   `agent:main:main`               → `main`
 *   `v2-app`                        → `v2-app`  (already bare, untouched)
 */
function bareThreadKey(key: string): string {
  if (key === 'agent:main:main') return 'main'
  if (key.startsWith('agent:main:thread:')) return key.slice('agent:main:thread:'.length)
  return key
}

/**
 * Resolve the target thread for tools that schedule or send into a thread.
 * Order of preference: explicit arg → the calling session's thread →
 * throw with a clear message. Prevents the foot-gun where an agent in
 * `neural-nets` forgets to pass `threadKey` and the cron silently lands
 * in `main`.
 */
function resolveThreadKey(explicit: string | undefined, deps: SovereignToolDeps): string {
  if (explicit && explicit.trim()) return explicit.trim()
  const current = deps.currentSessionKey?.()
  if (current) return bareThreadKey(current)
  throw new Error(
    'cron_create: threadKey is required when no calling session is attributable. ' +
      'Pass `threadKey` explicitly (e.g. "main") or call from inside an active thread.'
  )
}

export function createSovereignMcpServer(deps: SovereignToolDeps): McpSdkServerConfigWithInstance {
  const tools = [
    // ── cron ──────────────────────────────────────────────────────────────
    tool(
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
      async (args) => {
        const sched: any = args.when
        if (sched.kind === 'cron' && !sched.expr) throw new Error('cron_create: kind=cron requires expr')
        if (sched.kind === 'interval' && !sched.everyMs) throw new Error('cron_create: kind=interval requires everyMs')
        if (sched.kind === 'oneshot' && !sched.at) throw new Error('cron_create: kind=oneshot requires at')
        const resolvedThreadKey = resolveThreadKey(args.threadKey, deps)
        const result = await deps.cron.createUserMessageCron({
          threadKey: resolvedThreadKey,
          schedule: sched,
          prompt: args.prompt,
          label: args.label
        })
        return okJson({ id: result.id, schedule: result.schedule, threadKey: resolvedThreadKey })
      }
    ),
    tool(
      'cron_list',
      'List Sovereign-managed cron jobs, optionally filtered to a specific thread.',
      {
        threadKey: z.string().optional()
      },
      async (args) => {
        const all = await deps.cron.list(true)
        const filtered = args.threadKey
          ? all.filter((j: any) => {
              const target = j.sessionTarget ?? j.sessionKey ?? j.payload?.threadKey
              if (!target) return false
              return target === args.threadKey || target.endsWith(`:thread:${args.threadKey}`)
            })
          : all
        return okJson({ crons: filtered })
      }
    ),
    tool('cron_delete', 'Cancel a Sovereign cron job by id.', { id: z.string() }, async (args) => {
      await deps.cron.remove(args.id)
      return okText(`Removed cron ${args.id}.`)
    }),

    // ── sessions ──────────────────────────────────────────────────────────
    tool(
      'sessions_list',
      'List Sovereign sessions/threads visible across enabled backends.',
      {
        backendKind: z.enum(['pi', 'claude-code']).optional()
      },
      async (args) => {
        const list = await deps.sessions.list(args.backendKind ? { backendKind: args.backendKind } : undefined)
        return okJson({ sessions: list })
      }
    ),
    tool(
      'sessions_send',
      'Deliver a user message into another Sovereign thread. Use this to coordinate across threads instead of asking the user to relay.',
      {
        sessionKey: z.string().describe('Target session key — canonical (agent:main:thread:<x>) or bare thread name.'),
        text: z.string()
      },
      async (args) => {
        await deps.sessions.send(args.sessionKey, args.text)
        return okText(`Sent to ${args.sessionKey}.`)
      }
    ),
    tool(
      'sessions_history',
      'Read recent turns from another Sovereign thread for context.',
      {
        sessionKey: z.string(),
        limit: z.number().int().min(1).max(200).optional().default(20)
      },
      async (args) => {
        const turns = await deps.sessions.history(args.sessionKey, args.limit ?? 20)
        return okJson({ turns })
      }
    ),

    // ── browser ───────────────────────────────────────────────────────────
    tool(
      'browser_open',
      'Open a managed browser session at a URL. Returns a sessionId you pass to browser_act / browser_close. The summary lists interactive elements with `[r1]`, `[r2]` refs you can target in subsequent acts.',
      {
        url: z.string().describe('URL to navigate to immediately.'),
        headed: z.boolean().optional().describe('Show the browser window (default: headless).'),
        viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
        sessionId: z.string().optional().describe('Reuse an existing browser session id (re-navigates to url).')
      },
      async (args) => {
        const result = await deps.browser.open({
          url: args.url,
          headed: args.headed,
          viewport: args.viewport,
          sessionId: args.sessionId
        })
        return okJson(result)
      }
    ),
    tool(
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
          .describe('Action object — see the tool description for shape per kind.')
      },
      async (args) => {
        const result = await deps.browser.act(args.sessionId, args.action as any)
        // Don't dump base64 image into the text payload (huge); summarize and
        // return both text + image as separate content blocks when present.
        const summary: Record<string, unknown> = {
          message: result.message,
          url: result.url,
          title: result.title
        }
        if (result.text)
          summary.text = result.text.length > 4000 ? result.text.slice(0, 4000) + '\n…(truncated)' : result.text
        if (result.summary) summary.summary = result.summary
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          { type: 'text', text: JSON.stringify(summary, null, 2) }
        ]
        if (result.imageBase64 && result.imageMime) {
          content.push({ type: 'image', data: result.imageBase64, mimeType: result.imageMime })
        }
        return { content }
      }
    ),
    tool(
      'browser_close',
      'Close a managed browser session and release its tab.',
      { sessionId: z.string() },
      async (args) => {
        await deps.browser.close(args.sessionId)
        return okText(`Closed browser session ${args.sessionId}.`)
      }
    ),

    // ── subagents ─────────────────────────────────────────────────────────
    tool(
      'agents_spawn',
      'Spawn a Sovereign-tracked subagent under the current parent session. Use when the model wants a tracked subagent record (the Task tool is the lighter-weight alternative for ad-hoc work).',
      {
        task: z.string(),
        label: z.string().optional(),
        parentSessionKey: z.string().optional()
      },
      async (args) => {
        const parent = args.parentSessionKey ?? deps.currentSessionKey?.()
        if (!parent) throw new Error('agents_spawn: no parent session key available')
        const result = await deps.agents.spawn(parent, { task: args.task, label: args.label })
        return okJson({ sessionKey: result.sessionKey, parentSessionKey: parent })
      }
    ),
    tool(
      'agents_list',
      'List live subagents, optionally filtered to a specific parent.',
      { parentSessionKey: z.string().optional() },
      async (args) => {
        const list = await deps.agents.list(args.parentSessionKey)
        return okJson({ agents: list })
      }
    ),

    // ── notifications ─────────────────────────────────────────────────────
    tool(
      'notifications_send',
      'Push a notification to the user surface.',
      {
        title: z.string(),
        body: z.string().optional(),
        severity: z.enum(['info', 'warning', 'error']).optional().default('info'),
        entityId: z.string().optional()
      },
      async (args) => {
        const result = deps.notifications.send({
          title: args.title,
          body: args.body,
          severity: args.severity,
          entityId: args.entityId
        })
        return okJson({ id: result.id })
      }
    ),

    // ── planning / issues ─────────────────────────────────────────────────
    tool(
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
      async (args) => {
        const issue = await deps.planning.createIssue(args)
        return okJson(issue)
      }
    ),
    tool(
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
      async (args) => {
        const issue = await deps.planning.updateIssue(args)
        return okJson(issue)
      }
    ),

    // ── orgs ──────────────────────────────────────────────────────────────
    tool('list_orgs', 'List Sovereign orgs/workspaces.', {}, async () => okJson({ orgs: deps.orgs.list() })),

    // ── meetings ──────────────────────────────────────────────────────────
    tool(
      'read_meeting',
      'Read a meeting transcript or summary by id, or list recent meetings when no id is provided.',
      {
        orgId: z.string(),
        meetingId: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional()
      },
      async (args) => {
        if (args.meetingId) {
          const meeting = await deps.meetings.read(args.orgId, args.meetingId)
          if (!meeting) return okText(`Meeting ${args.meetingId} not found in org ${args.orgId}.`)
          return okJson(meeting)
        }
        const list = await deps.meetings.list(args.orgId, args.limit ?? 20)
        return okJson({ meetings: list })
      }
    )
  ]

  return createSdkMcpServer({
    name: 'sovereign',
    version: '1.0.0',
    instructions:
      "Sovereign-native tools. Use these to interact with the user's threads, agents, cron jobs, notifications, planning, orgs, and meetings. The user expects you to reach for these instead of asking them to relay information by hand.",
    tools,
    alwaysLoad: true
  })
}
