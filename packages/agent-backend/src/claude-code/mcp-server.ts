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
    spawn(
      parentSessionKey: string,
      opts: { task: string; label?: string; backend?: string; model?: string }
    ): Promise<{ sessionKey: string }>
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
  /** Presence-system integration. When set, registers the presence_reply_*
   *  MCP tools gated to the internal session.
   *  Sourced from `@sovereign/presence` at the wiring layer. */
  presence?: PresenceMcpDeps
  /** Embeddings service. When set, registers `embeddings_search` and
   *  `embeddings_index` tools for semantic retrieval over local content. */
  embeddings?: EmbeddingsToolDeps
  /** Task service. When set, registers the eight task_* MCP tools. */
  tasks?: TaskMcpDeps
}

/** Subset of @sovereign/embeddings the MCP layer needs. Kept inline so this
 *  package doesn't depend on @sovereign/embeddings directly. */
export interface EmbeddingsToolDeps {
  search(
    query: string,
    opts?: { collection?: string; source?: string; limit?: number }
  ): Promise<Array<{ content: string; source: string; score: number; metadata: Record<string, unknown> }>>
  index(content: string, opts: { source: string; collection?: string }): Promise<{ chunksIndexed: number }>
  listCollections(): Array<{ collection: string; count: number }>
  healthy(): Promise<boolean>
}

/** Subset of @sovereign/presence the MCP layer needs. Kept inline so this
 *  package doesn't depend on @sovereign/presence directly. */
export interface PresenceMcpDeps {
  /** The internal thread's bare id, or null when none. Gates `presence_reply_*`. */
  internalThreadId(): string | null
  /** The gateway thread's bare id, or null when none. */
  gatewayThreadId(): string | null
  tools: {
    reply_voice(text: string, opts?: { deviceId?: string }): Promise<unknown>
    reply_ad4m(text: string, opts?: { perspectiveUuid?: string; channelAddress?: string }): Promise<unknown>
  }
}

/** Subset of @sovereign/tasks the MCP layer needs. Kept inline so this
 *  package doesn't depend on @sovereign/tasks directly. */
export interface TaskMcpDeps {
  create(opts: {
    name: string
    description?: string
    parentTaskIds?: string[]
    tags?: string[]
    autoAssign?: boolean
    sourceThreadId: string
    provider?: Record<string, unknown>
  }): Promise<{ id: string; name: string; state: string; threadId: string | null }>
  update(
    taskId: string,
    opts: {
      state?: string
      transientState?: string
      name?: string
      description?: string
      threadId?: string | null
      tags?: string[]
      sourceThreadId: string
      provider?: Record<string, unknown>
    }
  ): Promise<Record<string, unknown>>
  get(taskId: string): Promise<Record<string, unknown> | null>
  list(filter?: {
    state?: string
    threadId?: string | null
    parentId?: string
    rootsOnly?: boolean
  }): Promise<Array<Record<string, unknown>>>
  link(parentId: string, childId: string, sourceThreadId: string): Promise<void>
  unlink(parentId: string, childId: string, sourceThreadId: string): Promise<void>
  summary(resolveLabel?: (threadId: string) => string | undefined): Promise<Record<string, unknown>>
  /** Import a GitHub PR as a task. Returns the created task + starts polling. */
  importPr?(opts: {
    repo: string
    pr: number
    threadId?: string
    parentTaskIds?: string[]
    tags?: string[]
    prompt?: string
    pollIntervalMinutes?: number
    sourceThreadId: string
  }): Promise<Record<string, unknown>>
  /** Send a prompt to a task's assigned thread. */
  sendPrompt?(taskId: string, prompt: string): Promise<void>
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
 * Return the bare thread key of the calling session.
 * Every MCP instance receives a fixed `currentSessionKey` at creation time
 * via the `?session=` HTTP parameter. Throws when no session attribution
 * exists — indicates a wiring bug.
 */
function getCallingThreadKey(deps: SovereignToolDeps): string {
  const current = deps.currentSessionKey?.()
  if (!current) {
    throw new Error('cron_create: no calling session — cannot determine target thread.')
  }
  return bareThreadKey(current)
}

/** Tools exposed to subagents (local-LLM workers). Deliberately narrow —
 *  subagents do implementation work and only need browser automation and
 *  local semantic search. Orchestration tools (cron, sessions, agents,
 *  presence, planning, orgs) stay on the main thread. */
export const SUBAGENT_SOVEREIGN_TOOLS = [
  'browser_open',
  'browser_act',
  'browser_close',
  'embeddings_search',
  'embeddings_index'
] as const

export function createSovereignMcpServer(
  deps: SovereignToolDeps,
  opts?: { include?: readonly string[] }
): McpSdkServerConfigWithInstance {
  const tools: any[] = [
    // ── cron ──────────────────────────────────────────────────────────────
    tool(
      'cron_create',
      'Schedule a future user-message into the calling thread.',
      {
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
        const threadKey = getCallingThreadKey(deps)
        const result = await deps.cron.createUserMessageCron({
          threadKey,
          schedule: sched,
          prompt: args.prompt,
          label: args.label
        })
        return okJson({ id: result.id, schedule: result.schedule, threadKey })
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
        backendKind: z.enum(['claude-code', 'local-llm']).optional()
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
    // NOTE: agents_spawn disabled — local-LLM subagents produce unreliable
    // results. Use Claude Code's built-in Task tool instead. The tool
    // definition, deps interface, and wiring remain for future re-enable.
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

  // ── embeddings (only registered when wired) ─────────────────────────────
  if (deps.embeddings) {
    const emb = deps.embeddings
    tools.push(
      tool(
        'embeddings_search',
        'Search local embedded content by natural language query. Returns the most semantically similar chunks with relevance scores. All data stays on-machine — nothing leaves the box.',
        {
          query: z.string().describe('Natural language search query.'),
          collection: z
            .string()
            .optional()
            .describe('Filter to a specific collection (e.g. "daily-notes", "membranes"). Omit to search all.'),
          source: z
            .string()
            .optional()
            .describe('Filter to a specific source (e.g. a file path). Omit to search all sources.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(10)
            .describe('Maximum number of results to return. Default: 10.')
        },
        async (args) => {
          const results = await emb.search(args.query, {
            collection: args.collection,
            source: args.source,
            limit: args.limit
          })
          if (results.length === 0) return okText('No matching content found.')
          return okJson({ results, totalResults: results.length })
        }
      ),
      tool(
        'embeddings_index',
        'Index text content into the local vector store for later semantic search. Chunks the content, embeds it locally, and stores it. Use this to make documents, notes, or any text searchable.',
        {
          content: z.string().describe('The text content to index.'),
          source: z.string().describe('Source identifier — typically a file path, URL, or descriptive label.'),
          collection: z.string().optional().default('default').describe('Collection to index into. Default: "default".')
        },
        async (args) => {
          const result = await emb.index(args.content, {
            source: args.source,
            collection: args.collection
          })
          return okJson({ indexed: true, chunksIndexed: result.chunksIndexed, source: args.source })
        }
      ),
      tool('embeddings_collections', 'List all embedding collections with document counts.', {}, async () => {
        const collections = emb.listCollections()
        return okJson({ collections })
      }),
      tool(
        'embeddings_health',
        'Check whether the local embedding server (nomic-embed-text) responds.',
        {},
        async () => {
          const ok = await emb.healthy()
          return okJson({ healthy: ok })
        }
      )
    )
  }

  // ── tasks (only registered when wired) ──────────────────────────────────
  if (deps.tasks) {
    const tasks = deps.tasks
    tools.push(
      tool(
        'task_create',
        'Create a holonic task. Assigns to the calling thread by default. Returns the new task.',
        {
          name: z.string().describe('Short imperative title for the task.'),
          description: z.string().optional().describe('What needs doing (markdown).'),
          parentTaskIds: z.array(z.string()).optional().describe('IRIs of parent tasks (holonic — many-to-many).'),
          tags: z.array(z.string()).optional().describe('Freeform labels.'),
          autoAssign: z.boolean().optional().default(true).describe('Assign to the calling thread. Defaults to true.')
        },
        async (args) => {
          const sourceThreadId = deps.currentSessionKey?.() ? bareThreadKey(deps.currentSessionKey()!) : 'unknown'
          const result = await tasks.create({
            name: args.name,
            description: args.description,
            parentTaskIds: args.parentTaskIds,
            tags: args.tags,
            autoAssign: args.autoAssign,
            sourceThreadId
          })
          return okJson(result)
        }
      ),
      tool(
        'task_update',
        'Update task properties. Sets updatedAt automatically. Emits typed bus events for state, thread, and transient changes.',
        {
          taskId: z.string().describe('The task IRI to update.'),
          state: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional().describe('New task state.'),
          transientState: z.string().optional().describe('Freeform live status line.'),
          name: z.string().optional(),
          description: z.string().optional(),
          threadId: z.string().nullable().optional().describe('Reassign (string) or unassign (null).'),
          tags: z.array(z.string()).optional().describe('Replaces the entire tag set.')
        },
        async (args) => {
          const sourceThreadId = deps.currentSessionKey?.() ? bareThreadKey(deps.currentSessionKey()!) : 'unknown'
          const result = await tasks.update(args.taskId, {
            state: args.state,
            transientState: args.transientState,
            name: args.name,
            description: args.description,
            threadId: args.threadId,
            tags: args.tags,
            sourceThreadId
          })
          return okJson(result)
        }
      ),
      tool(
        'task_get',
        'Retrieve a single task with its full relationship graph (parents, children, tags).',
        {
          taskId: z.string().describe('The task IRI to retrieve.')
        },
        async (args) => {
          const result = await tasks.get(args.taskId)
          if (!result) return okText(`Task not found: ${args.taskId}`)
          return okJson(result)
        }
      ),
      tool(
        'task_list',
        'List tasks with optional filtering by state, thread, parent, or roots-only.',
        {
          state: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
          threadId: z.string().nullable().optional().describe('Filter by assigned thread (null = unassigned).'),
          parentId: z.string().optional().describe('Only direct children of this task.'),
          rootsOnly: z.boolean().optional().describe('Only tasks with no parents.')
        },
        async (args) => {
          const result = await tasks.list({
            state: args.state,
            threadId: args.threadId,
            parentId: args.parentId,
            rootsOnly: args.rootsOnly
          })
          return okJson(result)
        }
      ),
      tool(
        'task_link',
        'Add a holonic parent/child relationship. Rejects cycles.',
        {
          parentId: z.string().describe('Parent task IRI.'),
          childId: z.string().describe('Child task IRI.')
        },
        async (args) => {
          const sourceThreadId = deps.currentSessionKey?.() ? bareThreadKey(deps.currentSessionKey()!) : 'unknown'
          await tasks.link(args.parentId, args.childId, sourceThreadId)
          return okJson({ linked: true })
        }
      ),
      tool(
        'task_unlink',
        'Remove a holonic parent/child relationship.',
        {
          parentId: z.string().describe('Parent task IRI.'),
          childId: z.string().describe('Child task IRI.')
        },
        async (args) => {
          const sourceThreadId = deps.currentSessionKey?.() ? bareThreadKey(deps.currentSessionKey()!) : 'unknown'
          await tasks.unlink(args.parentId, args.childId, sourceThreadId)
          return okJson({ unlinked: true })
        }
      ),
      tool(
        'task_subscribe',
        'Subscribe the calling thread to task events matching a filter. Returns a subscription id. (Requires AD4M waker — currently a placeholder for manual bus subscription.)',
        {
          taskId: z.string().optional().describe('Watch a specific task.'),
          threadId: z.string().optional().describe('Watch all tasks assigned to a thread.'),
          state: z
            .enum(['pending', 'in_progress', 'completed', 'cancelled'])
            .optional()
            .describe('Watch for transitions to this state.')
        },
        async (_args) => {
          // Subscriptions require AD4M waker integration. The bus-based
          // TaskDigest covers the passive path; waker subscriptions provide
          // the proactive path. For now, return a placeholder — the
          // TaskDigest handles all current use cases.
          return okJson({
            subscriptionId: `sub-${Date.now()}`,
            note: 'Task event subscriptions flow through the TaskDigest. AD4M waker integration pending.'
          })
        }
      ),
      tool(
        'task_summary',
        'Read-only snapshot of the operational landscape: in-flight tasks, recently completed, and unassigned work.',
        {},
        async () => {
          const result = await tasks.summary()
          return okJson(result)
        }
      )
    )

    // ── PR-task bridge tools (only when importPr/sendPrompt wired) ───
    if (tasks.importPr) {
      const importPr = tasks.importPr
      tools.push(
        tool(
          'task_import_pr',
          'Import a GitHub PR as a task in the holonic task graph. Starts polling for CI/review changes. Optionally assigns a thread and sends an initial prompt.',
          {
            repo: z.string().describe('GitHub repo slug (e.g. "coasys/we").'),
            pr: z.number().int().positive().describe('PR number.'),
            threadId: z.string().optional().describe('Thread to assign. Omit to leave unassigned.'),
            parentTaskIds: z.array(z.string()).optional().describe('Parent task IRIs.'),
            tags: z.array(z.string()).optional().describe('Freeform labels.'),
            prompt: z.string().optional().describe('Initial prompt to send to the assigned thread.'),
            pollIntervalMinutes: z
              .number()
              .int()
              .min(1)
              .max(60)
              .optional()
              .describe('Poll interval in minutes. Default: 5.')
          },
          async (args) => {
            const sourceThreadId = deps.currentSessionKey?.() ? bareThreadKey(deps.currentSessionKey()!) : 'unknown'
            const result = await importPr({
              repo: args.repo,
              pr: args.pr,
              threadId: args.threadId,
              parentTaskIds: args.parentTaskIds,
              tags: args.tags,
              prompt: args.prompt,
              pollIntervalMinutes: args.pollIntervalMinutes,
              sourceThreadId
            })
            return okJson(result)
          }
        )
      )
    }

    if (tasks.sendPrompt) {
      const sendPrompt = tasks.sendPrompt
      tools.push(
        tool(
          'task_send_prompt',
          "Send a prompt to a task's assigned thread. The task must have a threadId assigned.",
          {
            taskId: z.string().describe('The task IRI.'),
            prompt: z.string().describe('The message to send to the assigned thread.')
          },
          async (args) => {
            await sendPrompt(args.taskId, args.prompt)
            return okText(`Prompt sent to task ${args.taskId}'s assigned thread.`)
          }
        )
      )
    }
  }

  // ── presence (only registered when wired) ──────────────────────────────
  // The presence_* tools split by session role. See plans/presence-thread-spec.md.
  if (deps.presence) {
    const presence = deps.presence
    function refuseFor(role: 'internal' | 'gateway', expectedId: string | null) {
      const current = deps.currentSessionKey?.()
      const currentBare = current ? bareThreadKey(current) : undefined
      if (!expectedId) return okText(`presence: no ${role} thread configured.`)
      if (currentBare !== expectedId) {
        return okText(
          `presence: this tool can only be used from the ${role} session (current: ${currentBare ?? 'unknown'}, ${role}: ${expectedId}).`
        )
      }
      return null
    }
    function ensureInternal() {
      return refuseFor('internal', presence.internalThreadId())
    }
    // ── Internal-only tools (reply + watch) ─────────────────────────────
    tools.push(
      tool(
        'presence_reply_voice',
        'Synthesize a voice (TTS) reply to the last voice-origin device, or an explicit deviceId. Returns delivery status. Only callable from the presence-internal thread.',
        {
          text: z.string().describe('The spoken reply text — keep it short and conversational.'),
          deviceId: z.string().optional().describe('Override the target deviceId (defaults to the last voice origin).')
        },
        async (args) => {
          const refusal = ensureInternal()
          if (refusal) return refusal
          const result = await presence.tools.reply_voice(
            args.text,
            args.deviceId ? { deviceId: args.deviceId } : undefined
          )
          return okJson(result)
        }
      ),
      tool(
        'presence_reply_ad4m',
        'Post a reply into the AD4M channel of the last ad4m-origin message (or explicit perspective/channel). Only callable from the presence-internal thread.',
        {
          text: z.string(),
          perspectiveUuid: z.string().optional(),
          channelAddress: z.string().optional()
        },
        async (args) => {
          const refusal = ensureInternal()
          if (refusal) return refusal
          const opts: { perspectiveUuid?: string; channelAddress?: string } = {}
          if (args.perspectiveUuid) opts.perspectiveUuid = args.perspectiveUuid
          if (args.channelAddress) opts.channelAddress = args.channelAddress
          const result = await presence.tools.reply_ad4m(args.text, Object.keys(opts).length ? opts : undefined)
          return okJson(result)
        }
      )
    )
  }

  const filteredTools = opts?.include ? tools.filter((t) => opts.include!.includes(t.name)) : tools

  return createSdkMcpServer({
    name: 'sovereign',
    version: '1.0.0',
    instructions:
      "Sovereign-native tools. Use these to interact with the user's threads, agents, cron jobs, notifications, planning, orgs, and meetings. The user expects you to reach for these instead of asking them to relay information by hand.",
    tools: filteredTools,
    alwaysLoad: true
  })
}
