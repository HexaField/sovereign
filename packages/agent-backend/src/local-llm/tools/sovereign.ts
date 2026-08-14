// Sovereign-native tools for the local-llm backend — gives local models the
// same Sovereign capabilities Claude Code gets via MCP: cron, sessions,
// browser, agents, notifications, planning, orgs, meetings.
//
// Plus WebFetch — HTTP request tool for internet access.
//
// Each tool reuses the same handler interfaces as the Claude Code MCP server
// (SovereignToolDeps from mcp-server.ts) so wiring feeds them both.

import type { ToolSchema } from '../inference.js'
import type { ToolResult } from './index.js'

// ── Deps interface ──────────────────────────────────────────────────────

/** Subset of SovereignToolDeps that the local-llm tools need. */
export interface SovereignToolsDeps {
  cron: {
    createUserMessageCron(opts: {
      threadKey: string
      schedule: { kind: string; expr?: string; tz?: string; everyMs?: number; at?: string }
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
    list(parentKey?: string): Promise<Array<{ sessionKey: string; label: string; status: string; task?: string }>>
    spawn(
      parentKey: string,
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
    }): Promise<any>
    updateIssue(opts: {
      orgId: string
      projectId: string
      issueId: string
      title?: string
      body?: string
      state?: string
      labels?: string[]
    }): Promise<any>
  }
  orgs: {
    list(): Array<{ id: string; name: string; path: string }>
  }
  meetings: {
    list(orgId: string, limit?: number): Promise<any[]>
    read(orgId: string, meetingId: string): Promise<any | null>
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
  currentSessionKey?(): string | undefined
}

// ── Schemas ─────────────────────────────────────────────────────────────

const cronCreateSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_cron_create',
    description:
      'Schedule a future user-message into a Sovereign thread. Supports one-shot, interval, and cron schedules.',
    parameters: {
      type: 'object',
      required: ['when', 'prompt'],
      properties: {
        threadKey: {
          type: 'string',
          description: 'Target thread key. Defaults to the current thread when omitted.'
        },
        when: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['cron', 'interval', 'oneshot'] },
            expr: { type: 'string', description: 'Cron expression (kind=cron).' },
            tz: { type: 'string', description: 'Timezone (kind=cron).' },
            everyMs: { type: 'number', description: 'Interval in ms (kind=interval).' },
            at: { type: 'string', description: 'ISO8601 timestamp (kind=oneshot).' }
          },
          required: ['kind']
        },
        prompt: { type: 'string', description: 'The user-message text to deliver at fire time.' },
        label: { type: 'string' }
      },
      additionalProperties: false
    }
  }
}

const cronListSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_cron_list',
    description: 'List Sovereign-managed cron jobs, optionally filtered to a thread.',
    parameters: {
      type: 'object',
      properties: {
        threadKey: { type: 'string' }
      },
      additionalProperties: false
    }
  }
}

const cronDeleteSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_cron_delete',
    description: 'Cancel a Sovereign cron job by id.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
      additionalProperties: false
    }
  }
}

const sessionsListSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_sessions_list',
    description: 'List Sovereign sessions/threads visible across enabled backends.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }
}

const sessionsSendSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_sessions_send',
    description: 'Deliver a user message into another Sovereign thread. Use to coordinate across threads.',
    parameters: {
      type: 'object',
      required: ['sessionKey', 'text'],
      properties: {
        sessionKey: { type: 'string', description: 'Target session key or bare thread name.' },
        text: { type: 'string' }
      },
      additionalProperties: false
    }
  }
}

const sessionsHistorySchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_sessions_history',
    description: 'Read recent turns from another Sovereign thread for context.',
    parameters: {
      type: 'object',
      required: ['sessionKey'],
      properties: {
        sessionKey: { type: 'string' },
        limit: { type: 'integer', minimum: 1, description: 'Number of turns to return (default 20).' }
      },
      additionalProperties: false
    }
  }
}

const agentsSpawnSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_agents_spawn',
    description: 'Spawn a tracked subagent under the current session. Returns the child session key.',
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string' },
        label: { type: 'string' },
        backend: {
          type: 'string',
          description: 'Backend kind (e.g. "claude-code", "local-llm"). Defaults to current backend.'
        },
        model: { type: 'string', description: 'Model to use for the subagent.' }
      },
      additionalProperties: false
    }
  }
}

const agentsListSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_agents_list',
    description: 'List live subagents, optionally filtered to a specific parent.',
    parameters: {
      type: 'object',
      properties: {
        parentSessionKey: { type: 'string' }
      },
      additionalProperties: false
    }
  }
}

const notificationsSendSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_notifications_send',
    description: 'Push a notification to the user surface.',
    parameters: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        severity: { type: 'string', enum: ['info', 'warning', 'error'] },
        entityId: { type: 'string' }
      },
      additionalProperties: false
    }
  }
}

const createIssueSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_create_issue',
    description: 'Create an issue / planning node in a Sovereign org/project.',
    parameters: {
      type: 'object',
      required: ['orgId', 'projectId', 'remote', 'title'],
      properties: {
        orgId: { type: 'string' },
        projectId: { type: 'string' },
        remote: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        assignees: { type: 'array', items: { type: 'string' } }
      },
      additionalProperties: false
    }
  }
}

const updatePlanningNodeSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_update_planning_node',
    description: 'Update an existing planning node / issue.',
    parameters: {
      type: 'object',
      required: ['orgId', 'projectId', 'issueId'],
      properties: {
        orgId: { type: 'string' },
        projectId: { type: 'string' },
        issueId: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed'] },
        labels: { type: 'array', items: { type: 'string' } }
      },
      additionalProperties: false
    }
  }
}

const listOrgsSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_list_orgs',
    description: 'List Sovereign orgs/workspaces.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
}

const readMeetingSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_read_meeting',
    description: 'Read a meeting transcript or summary by id, or list recent meetings when no meetingId is provided.',
    parameters: {
      type: 'object',
      required: ['orgId'],
      properties: {
        orgId: { type: 'string' },
        meetingId: { type: 'string' },
        limit: { type: 'integer', minimum: 1 }
      },
      additionalProperties: false
    }
  }
}

const browserOpenSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_browser_open',
    description: 'Open a managed browser session at a URL. Returns a sessionId for browser_act / browser_close.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
        headed: { type: 'boolean' },
        viewport: {
          type: 'object',
          properties: { width: { type: 'integer' }, height: { type: 'integer' } },
          required: ['width', 'height']
        },
        sessionId: { type: 'string', description: 'Reuse an existing browser session.' }
      },
      additionalProperties: false
    }
  }
}

const browserActSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_browser_act',
    description:
      "Act on an open browser session. action.kind selects the action: 'navigate', 'click', 'type', 'fill', 'press', 'hover', 'scroll', 'wait', 'snapshot', 'screenshot', 'evaluate', 'extract', 'close'.",
    parameters: {
      type: 'object',
      required: ['sessionId', 'action'],
      properties: {
        sessionId: { type: 'string' },
        action: {
          type: 'object',
          properties: { kind: { type: 'string' } },
          required: ['kind'],
          additionalProperties: true
        }
      },
      additionalProperties: false
    }
  }
}

const browserCloseSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'sovereign_browser_close',
    description: 'Close a managed browser session and release its tab.',
    parameters: {
      type: 'object',
      required: ['sessionId'],
      properties: { sessionId: { type: 'string' } },
      additionalProperties: false
    }
  }
}

const webFetchSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'WebFetch',
    description:
      'Fetch content from a URL. Returns the response body as text. Supports GET, POST, PUT, PATCH, DELETE. ' +
      'Response body is truncated to 100KB.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'HTTP method. Defaults to GET.'
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Request headers as key-value pairs.'
        },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH).' }
      },
      additionalProperties: false
    }
  }
}

// ── Exported schemas ────────────────────────────────────────────────────

export const SOVEREIGN_TOOL_SCHEMAS: ToolSchema[] = [
  cronCreateSchema,
  cronListSchema,
  cronDeleteSchema,
  sessionsListSchema,
  sessionsSendSchema,
  sessionsHistorySchema,
  agentsSpawnSchema,
  agentsListSchema,
  notificationsSendSchema,
  createIssueSchema,
  updatePlanningNodeSchema,
  listOrgsSchema,
  readMeetingSchema,
  browserOpenSchema,
  browserActSchema,
  browserCloseSchema,
  webFetchSchema
]

// ── Executor ────────────────────────────────────────────────────────────

const MAX_WEBFETCH_BODY_CHARS = 100_000
const WEBFETCH_TIMEOUT_MS = 30_000

function bareThreadKey(key: string): string {
  if (key === 'agent:main:main') return 'main'
  if (key.startsWith('agent:main:thread:')) return key.slice('agent:main:thread:'.length)
  return key
}

function resolveThreadKey(explicit: string | undefined, deps: SovereignToolsDeps): string {
  if (explicit && explicit.trim()) return explicit.trim()
  const current = deps.currentSessionKey?.()
  if (current) return bareThreadKey(current)
  throw new Error('threadKey is required when no calling session is attributable.')
}

export function createSovereignToolExecutor(
  deps: SovereignToolsDeps
): (toolName: string, input: Record<string, unknown>) => Promise<ToolResult> {
  const ok = (obj: unknown): ToolResult => ({ content: JSON.stringify(obj, null, 2) })
  const okText = (text: string): ToolResult => ({ content: text })
  const fail = (msg: string): ToolResult => ({ content: '', error: msg })

  return async (toolName: string, input: Record<string, unknown>): Promise<ToolResult> => {
    try {
      switch (toolName) {
        // ── cron ──────────────────────────────────────────────────────
        case 'sovereign_cron_create': {
          const when = input.when as { kind: string; expr?: string; tz?: string; everyMs?: number; at?: string }
          if (!when?.kind) return fail('when.kind is required')
          const threadKey = resolveThreadKey(input.threadKey as string | undefined, deps)
          const result = await deps.cron.createUserMessageCron({
            threadKey,
            schedule: when,
            prompt: String(input.prompt ?? ''),
            label: input.label as string | undefined
          })
          return ok({ id: result.id, schedule: result.schedule, threadKey })
        }
        case 'sovereign_cron_list': {
          const all = await deps.cron.list(true)
          const threadKey = input.threadKey as string | undefined
          const filtered = threadKey
            ? all.filter((j: any) => {
                const target = j.sessionTarget ?? j.sessionKey ?? j.payload?.threadKey
                if (!target) return false
                return target === threadKey || target.endsWith(`:thread:${threadKey}`)
              })
            : all
          return ok({ crons: filtered })
        }
        case 'sovereign_cron_delete': {
          await deps.cron.remove(String(input.id))
          return okText(`Removed cron ${input.id}.`)
        }

        // ── sessions ─────────────────────────────────────────────────
        case 'sovereign_sessions_list': {
          const list = await deps.sessions.list()
          return ok({ sessions: list })
        }
        case 'sovereign_sessions_send': {
          await deps.sessions.send(String(input.sessionKey), String(input.text))
          return okText(`Sent to ${input.sessionKey}.`)
        }
        case 'sovereign_sessions_history': {
          const limit = typeof input.limit === 'number' ? input.limit : 20
          const turns = await deps.sessions.history(String(input.sessionKey), limit)
          return ok({ turns })
        }

        // ── agents ───────────────────────────────────────────────────
        case 'sovereign_agents_spawn': {
          const parent = deps.currentSessionKey?.()
          if (!parent) return fail('agents_spawn: no parent session key available')
          const result = await deps.agents.spawn(parent, {
            task: String(input.task),
            label: input.label as string | undefined,
            backend: input.backend as string | undefined,
            model: input.model as string | undefined
          })
          return ok({ sessionKey: result.sessionKey, parentSessionKey: parent })
        }
        case 'sovereign_agents_list': {
          const list = await deps.agents.list(input.parentSessionKey as string | undefined)
          return ok({ agents: list })
        }

        // ── notifications ────────────────────────────────────────────
        case 'sovereign_notifications_send': {
          const result = deps.notifications.send({
            title: String(input.title),
            body: input.body as string | undefined,
            severity: input.severity as string | undefined,
            entityId: input.entityId as string | undefined
          })
          return ok({ id: result.id })
        }

        // ── planning ─────────────────────────────────────────────────
        case 'sovereign_create_issue': {
          const issue = await deps.planning.createIssue(input as any)
          return ok(issue)
        }
        case 'sovereign_update_planning_node': {
          const issue = await deps.planning.updateIssue(input as any)
          return ok(issue)
        }

        // ── orgs ─────────────────────────────────────────────────────
        case 'sovereign_list_orgs':
          return ok({ orgs: deps.orgs.list() })

        // ── meetings ─────────────────────────────────────────────────
        case 'sovereign_read_meeting': {
          const orgId = String(input.orgId)
          if (input.meetingId) {
            const meeting = await deps.meetings.read(orgId, String(input.meetingId))
            if (!meeting) return okText(`Meeting ${input.meetingId} not found in org ${orgId}.`)
            return ok(meeting)
          }
          const limit = typeof input.limit === 'number' ? input.limit : 20
          const list = await deps.meetings.list(orgId, limit)
          return ok({ meetings: list })
        }

        // ── browser ──────────────────────────────────────────────────
        case 'sovereign_browser_open': {
          const result = await deps.browser.open({
            url: String(input.url),
            headed: input.headed as boolean | undefined,
            viewport: input.viewport as { width: number; height: number } | undefined,
            sessionId: input.sessionId as string | undefined
          })
          return ok(result)
        }
        case 'sovereign_browser_act': {
          const result = await deps.browser.act(String(input.sessionId), input.action)
          // Strip base64 images (huge); summarize instead
          const summary: Record<string, unknown> = {
            message: result.message,
            url: result.url,
            title: result.title
          }
          if (result.text) {
            summary.text = result.text.length > 4000 ? result.text.slice(0, 4000) + '\n…(truncated)' : result.text
          }
          if (result.summary) summary.summary = result.summary
          return ok(summary)
        }
        case 'sovereign_browser_close': {
          await deps.browser.close(String(input.sessionId))
          return okText(`Closed browser session ${input.sessionId}.`)
        }

        // ── web fetch ────────────────────────────────────────────────
        case 'WebFetch': {
          const url = String(input.url ?? '')
          if (!url) return fail('url is required')
          const method = (input.method as string) || 'GET'
          const headers = (input.headers as Record<string, string>) || {}
          const body = input.body as string | undefined
          try {
            const res = await fetch(url, {
              method,
              headers,
              body: body && method !== 'GET' ? body : undefined,
              signal: AbortSignal.timeout(WEBFETCH_TIMEOUT_MS)
            })
            const text = await res.text()
            const truncated =
              text.length > MAX_WEBFETCH_BODY_CHARS
                ? text.slice(0, MAX_WEBFETCH_BODY_CHARS) +
                  `\n\n[truncated — ${text.length - MAX_WEBFETCH_BODY_CHARS} more chars]`
                : text
            return okText(`HTTP ${res.status} ${res.statusText}\n\n${truncated}`)
          } catch (err) {
            return fail(`WebFetch failed: ${(err as Error).message}`)
          }
        }

        default:
          return fail(`Unknown sovereign tool: ${toolName}`)
      }
    } catch (err) {
      return fail(`${toolName} failed: ${(err as Error).message ?? String(err)}`)
    }
  }
}
