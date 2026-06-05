// HTTP RPC façade for the Sovereign MCP tools.
//
// The lightweight `@sovereign/mcp-sidecar` daemon (or any other MCP host) calls
// `POST /api/mcp-rpc/:tool` with the tool's JSON arguments. We dispatch into
// the same `SovereignToolDeps` bag the in-process MCP server uses, so there is
// exactly one place where the tool's business logic lives — both transports
// route through it.
//
// Auth: localhost-only by default. The server should not bind a public
// interface (Sovereign's loopback policy is enforced elsewhere). Callers
// inside the same machine can still poison this endpoint, so a shared-secret
// header check guards it when `SOVEREIGN_MCP_RPC_SECRET` is set.

import type { Router, Request, Response } from 'express'
import { Router as createRouter } from 'express'
import type { SovereignToolDeps } from './claude-code/index.js'

interface RpcOk {
  ok: true
  /** Tool's content array as returned by the MCP `tool()` handler — preserved verbatim. */
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
}
interface RpcErr {
  ok: false
  error: string
}

/**
 * Build the dispatch map. Each handler returns the MCP-shaped `{content:[...]}`
 * object (matches what the in-process `tool(...)` callback returns).
 *
 * Schemas + descriptions are NOT validated here — the sidecar already validates
 * args via zod before forwarding, and the server only sees well-formed JSON.
 * If a caller bypasses the sidecar, the handler's own runtime checks will
 * surface the error.
 */
function buildHandlers(deps: SovereignToolDeps): Record<string, (args: any) => Promise<unknown>> {
  const okText = (text: string) => ({ content: [{ type: 'text' as const, text }] })
  const okJson = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] })

  return {
    // ── cron ────────────────────────────────────────────────────────────────
    async cron_create(args: any) {
      const sched = args.when
      if (sched.kind === 'cron' && !sched.expr) throw new Error('cron_create: kind=cron requires expr')
      if (sched.kind === 'interval' && !sched.everyMs) throw new Error('cron_create: kind=interval requires everyMs')
      if (sched.kind === 'oneshot' && !sched.at) throw new Error('cron_create: kind=oneshot requires at')
      // Default the cron target to the calling thread if the agent didn't
      // pass `threadKey`. Same semantics as the in-process MCP server.
      // The sidecar leaves `threadKey` undefined when the agent omitted it.
      let resolvedThreadKey = args.threadKey?.trim()
      if (!resolvedThreadKey) {
        const current = deps.currentSessionKey?.()
        if (!current) {
          throw new Error(
            'cron_create: threadKey is required when no calling session is attributable. ' +
              'Pass `threadKey` explicitly (e.g. "main") or call from inside an active thread.'
          )
        }
        resolvedThreadKey =
          current === 'agent:main:main'
            ? 'main'
            : current.startsWith('agent:main:thread:')
              ? current.slice('agent:main:thread:'.length)
              : current
      }
      const result = await deps.cron.createUserMessageCron({
        threadKey: resolvedThreadKey,
        schedule: sched,
        prompt: args.prompt,
        label: args.label
      })
      return okJson({ id: result.id, schedule: result.schedule, threadKey: resolvedThreadKey })
    },
    async cron_list(args: any) {
      const all = await deps.cron.list(true)
      const filtered = args.threadKey
        ? all.filter((j: any) => {
            const target = j.sessionTarget ?? j.sessionKey ?? j.payload?.threadKey
            if (!target) return false
            return target === args.threadKey || target.endsWith(`:thread:${args.threadKey}`)
          })
        : all
      return okJson({ crons: filtered })
    },
    async cron_delete(args: any) {
      await deps.cron.remove(args.id)
      return okText(`Removed cron ${args.id}.`)
    },

    // ── sessions ────────────────────────────────────────────────────────────
    async sessions_list(args: any) {
      const list = await deps.sessions.list(args.backendKind ? { backendKind: args.backendKind } : undefined)
      return okJson({ sessions: list })
    },
    async sessions_send(args: any) {
      await deps.sessions.send(args.sessionKey, args.text)
      return okText(`Sent to ${args.sessionKey}.`)
    },
    async sessions_history(args: any) {
      const turns = await deps.sessions.history(args.sessionKey, args.limit ?? 20)
      return okJson({ turns })
    },

    // ── agents ──────────────────────────────────────────────────────────────
    async agents_list(args: any) {
      const list = await deps.agents.list(args.parentSessionKey)
      return okJson({ agents: list })
    },
    async agents_spawn(args: any) {
      const parent = args.parentSessionKey ?? deps.currentSessionKey?.()
      if (!parent) throw new Error('agents_spawn: parentSessionKey is required (no active session attribution)')
      const out = await deps.agents.spawn(parent, { task: args.task, label: args.label })
      return okJson(out)
    },

    // ── browser ─────────────────────────────────────────────────────────────
    async browser_open(args: any) {
      const result = await deps.browser.open({
        url: args.url,
        headed: args.headed,
        viewport: args.viewport,
        sessionId: args.sessionId
      })
      return okJson(result)
    },
    async browser_act(args: any) {
      const result = await deps.browser.act(args.sessionId, args.action)
      const summary: Record<string, unknown> = { message: result.message, url: result.url, title: result.title }
      if (result.text) {
        summary.text = result.text.length > 4000 ? result.text.slice(0, 4000) + '\n…(truncated)' : result.text
      }
      if (result.summary) summary.summary = result.summary
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text', text: JSON.stringify(summary, null, 2) }
      ]
      if (result.imageBase64) {
        content.push({ type: 'image', data: result.imageBase64, mimeType: result.imageMime ?? 'image/png' })
      }
      return { content }
    },
    async browser_close(args: any) {
      await deps.browser.close(args.sessionId)
      return okText(`Closed ${args.sessionId}.`)
    },

    // ── notifications ───────────────────────────────────────────────────────
    async notifications_send(args: any) {
      const out = deps.notifications.send({
        title: args.title,
        body: args.body,
        severity: args.severity ?? 'info',
        entityId: args.entityId
      })
      return okJson(out)
    },

    // ── meetings ────────────────────────────────────────────────────────────
    async read_meeting(args: any) {
      if (args.meetingId) {
        const m = await deps.meetings.read(args.orgId, args.meetingId)
        return okJson(m)
      }
      const list = await deps.meetings.list(args.orgId, args.limit ?? 10)
      return okJson({ meetings: list })
    },

    // ── planning / issues ───────────────────────────────────────────────────
    async create_issue(args: any) {
      const issue = await deps.planning.createIssue({
        orgId: args.orgId,
        projectId: args.projectId,
        remote: args.remote,
        title: args.title,
        body: args.body,
        labels: args.labels,
        assignees: args.assignees
      })
      return okJson({ issue })
    },
    async update_planning_node(args: any) {
      const node = await deps.planning.updateIssue({
        orgId: args.orgId,
        projectId: args.projectId,
        issueId: args.issueId,
        title: args.title,
        body: args.body,
        state: args.state,
        labels: args.labels
      })
      return okJson({ node })
    },

    // ── orgs ────────────────────────────────────────────────────────────────
    async list_orgs() {
      return okJson({ orgs: deps.orgs.list() })
    }
  }
}

/**
 * Mount the RPC routes under `/api/mcp-rpc/*`. The sidecar (or any other
 * MCP host that forwards to Sovereign) makes one POST per tool call.
 */
export function createMcpRpcRoutes(deps: SovereignToolDeps): Router {
  const router = createRouter()
  const handlers = buildHandlers(deps)
  const sharedSecret = process.env.SOVEREIGN_MCP_RPC_SECRET

  /**
   * Catalog endpoint. The sidecar GETs this on boot to confirm Sovereign is
   * up + to discover which tools are wired. Useful for smoke tests too:
   *   curl -fsS http://127.0.0.1:5801/api/mcp-rpc | jq
   */
  router.get('/api/mcp-rpc', (_req: Request, res: Response) => {
    res.json({ ok: true, tools: Object.keys(handlers).sort() })
  })

  router.post('/api/mcp-rpc/:tool', async (req: Request, res: Response) => {
    if (sharedSecret && req.headers['x-sovereign-mcp-secret'] !== sharedSecret) {
      return res.status(401).json({ ok: false, error: 'bad shared secret' } satisfies RpcErr)
    }
    const toolName = req.params.tool
    const handler = handlers[toolName]
    if (!handler) {
      return res.status(404).json({ ok: false, error: `unknown tool '${toolName}'` } satisfies RpcErr)
    }
    try {
      const args = req.body ?? {}
      const result = (await handler(args)) as { content: RpcOk['content'] }
      res.json({ ok: true, content: result.content } satisfies RpcOk)
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message ?? String(err) } satisfies RpcErr)
    }
  })

  return router
}
