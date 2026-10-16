// S43: Task graph persistence (Forge P0a).
//
// Creates a work stream, tasks, a plan task (REST import), assigns and links
// them, saves two Forge views (PUT /api/forge/views, the work graph's route
// into the same perspective), and imports a plan through the MCP
// `task_import` tool. Then restarts the Sovereign container and checks
// everything is still there, read back from the store on disk (the base lane
// has no AD4M, so the snapshot is the store).
//
// In the ad4m lane (./run.sh --ad4m --scenario s44) it also stops the AD4M
// node, keeps writing (outbox), restarts Sovereign with AD4M still down
// (snapshot + outbox), starts AD4M again and checks the outbox drains.

import { execSync } from 'node:child_process'
import path from 'node:path'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import { waitForThreadIdle } from '../wait.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TOOL_USE_ID = 'toolu_s44_task_import'

async function waitForHealth(url: string, timeoutMs = 60000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${url}/health`)).ok) return
    } catch {
      /* retry */
    }
    await sleep(500)
  }
  throw new Error(`${url} failed to respond within ${timeoutMs}ms`)
}

async function json(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status}: ${text}`)
  return JSON.parse(text)
}

const post = (base: string, p: string, body: unknown) =>
  json(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const patch = (base: string, p: string, body: unknown) =>
  json(`${base}${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const uuidOf = (taskId: string) => taskId.replace('task://', '')

/** The text of the tool_result for `toolUseId`, once the SDK echoes it back. */
async function toolResult(mockLlmUrl: string, toolUseId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const log = (await (await fetch(`${mockLlmUrl}/mock/log`)).json()) as any[]
    for (const entry of log) {
      for (const msg of entry?.messages ?? []) {
        if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue
        for (const block of msg.content) {
          if (block?.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue
          const c = block.content
          return typeof c === 'string' ? c : (c ?? []).map((b: any) => b?.text ?? '').join('\n')
        }
      }
    }
    await sleep(500)
  }
  return null
}

export const s44TaskPersistence: Scenario = {
  id: 's44',
  name: 'Task Persistence',
  description:
    'Tasks, streams, links, views and edges survive a Sovereign restart (and an AD4M outage in the ad4m lane)',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, sovereignUrl: base, mockLlmUrl, composeFile } = ctx
    const metrics: Record<string, unknown> = {}
    const failures: string[] = []
    const check = (ok: boolean, what: string) => {
      if (!ok) failures.push(what)
    }
    const ad4mLane = !!process.env.AD4M_PROVISION_FILE
    const compose = ad4mLane
      ? `docker compose -f "${composeFile}" -f "${path.join(path.dirname(composeFile), 'docker-compose.ad4m.yml')}"`
      : `docker compose -f "${composeFile}"`
    const run = (cmd: string) => execSync(`${compose} ${cmd}`, { encoding: 'utf-8', timeout: 60000 })
    const restartSovereign = async () => {
      client.disconnectWs()
      run('restart sovereign')
      await waitForHealth(base, 90000)
      await sleep(2000)
    }

    const status0 = await json(`${base}/api/tasks/store-status`)
    metrics.backendAtStart = status0.tasks.backend

    // ── Build a small graph through REST ───────────────────────────────
    if (!(await client.membranes()).some((m: any) => m.id === 'swt-forge'))
      await client.post('/api/membranes', { id: 'swt-forge', name: 'Task persistence wind tunnel', workspaceIds: [] })
    const thread = await client.timed('create-thread', () => client.post('/api/threads', { label: 'swt-s44-tasks' }))
    const threadId: string = (thread?.thread ?? thread).id
    const tag = `s44-${Date.now()}`

    const stream = await post(base, '/api/tasks', { name: `${tag} stream`, isStream: true, membrane: 'swt-forge' })
    const t1 = await post(base, '/api/tasks', { name: `${tag} build`, membrane: 'swt-forge', tags: [tag] })
    const t2 = await post(base, '/api/tasks', { name: `${tag} review`, membrane: 'swt-forge', tags: [tag] })
    await patch(base, `/api/tasks/${uuidOf(t1.id)}`, { threadId, state: 'in_progress', transientState: 'CI pending' })
    await post(base, '/api/tasks/link', { parentId: stream.id, childId: t1.id })
    await post(base, '/api/tasks/link', { parentId: stream.id, childId: t2.id })
    await post(base, '/api/tasks/link', { parentId: t1.id, childId: t2.id })
    const planImport = await post(base, '/api/tasks/import', {
      plan: { project: 'swt', path: `plans/${tag}.md` },
      parentTaskIds: [stream.id],
      membrane: 'swt-forge'
    })
    const planAgain = await post(base, '/api/tasks/import', { plan: { project: 'swt', path: `plans/${tag}.md` } })
    check(planImport.created === true && planAgain.created === false, 'plan import is idempotent')
    check(planAgain.task.id === planImport.task.id, 'plan re-import returns the same task')
    // Forge views are the work graph's (membrane-scoped, through the TaskPort
    // into the same perspective); the membrane must exist.
    const view = {
      id: `${tag}-view`,
      membrane: 'swt-forge',
      title: `${tag} view`,
      repos: ['example-org/example-repo'],
      filters: {}
    }
    await json(`${base}/api/forge/views?membrane=swt-forge`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ views: [view, { ...view, id: `${tag}-second`, title: 'second', repos: [] }] })
    })

    // ── MCP: task_import of a plan through the model ───────────────────
    await client.connectWs(['chat'])
    await client.timed('warmup-send', () => client.sendMessage(threadId, 'warmup — initialise session'))
    await client.timed('warmup-idle', () => waitForThreadIdle(client, threadId, 20000))
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's44-task-import',
        once: true,
        needsTools: true,
        toolUse: {
          id: TOOL_USE_ID,
          name: 'mcp__sovereign__task_import',
          input: {
            plan: { project: 'swt', path: `plans/${tag}-mcp.md`, name: `${tag} mcp plan` },
            parentTaskIds: [stream.id]
          }
        }
      })
    })
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await client.timed('mcp-send', () => client.sendMessage(threadId, 'Please run s44-task-import'))
    const mcpText = await client.timed('mcp-result', () => toolResult(mockLlmUrl, TOOL_USE_ID, 30000))
    await waitForThreadIdle(client, threadId, 20000).catch(() => false)
    let mcpTaskId: string | null = null
    try {
      const parsed = JSON.parse(mcpText ?? '')
      mcpTaskId = parsed?.task?.id ?? null
      check(parsed?.created === true, 'MCP task_import created the task')
    } catch {
      failures.push(`MCP task_import result unreadable: ${mcpText?.slice(0, 160) ?? 'none'}`)
    }
    metrics.mcpTaskId = mcpTaskId

    // ── Check the graph, before and after a restart ────────────────────
    const verify = async (when: string) => {
      const s = await json(`${base}/api/tasks/${uuidOf(stream.id)}`)
      const a = await json(`${base}/api/tasks/${uuidOf(t1.id)}`)
      const b = await json(`${base}/api/tasks/${uuidOf(t2.id)}`)
      check(s.isStream === true && s.membrane === 'swt-forge', `${when}: stream flag + membrane`)
      const members = new Set(s.childTasks.map((c: any) => c.id))
      check(
        [t1.id, t2.id, planImport.task.id, ...(mcpTaskId ? [mcpTaskId] : [])].every((id) => members.has(id)),
        `${when}: stream members`
      )
      check(
        a.threadId === threadId && a.state === 'in_progress' && a.transientState === 'CI pending',
        `${when}: assignment`
      )
      check(
        b.parentTasks
          .map((p: any) => p.id)
          .sort()
          .join() === [stream.id, t1.id].sort().join(),
        `${when}: many-to-many parents`
      )
      const inStream = (await json(`${base}/api/tasks?workstream=${encodeURIComponent(stream.id)}`)).tasks
      check(inStream.length === members.size, `${when}: workstream filter`)
      const plans = (await json(`${base}/api/tasks?providerKind=plan&membrane=swt-forge`)).tasks
      check(
        plans.some((t: any) => t.id === planImport.task.id),
        `${when}: plan provider filter`
      )
      const views = (await json(`${base}/api/forge/views?membrane=swt-forge`)).views
      check(
        views.map((v: any) => v.id).join() === `${view.id},${tag}-second` &&
          views[0].repos[0] === 'example-org/example-repo',
        `${when}: views in order`
      )
    }

    await verify('before restart')
    let snapshotHasTasks = false
    try {
      const snap = run('exec -T sovereign cat /data/data/tasks/snapshot.json')
      snapshotHasTasks = snap.includes(t1.id) && snap.includes(stream.id)
    } catch (err: any) {
      metrics.snapshotError = err?.message
    }
    check(snapshotHasTasks, 'snapshot on disk holds the tasks')

    await client.timed('restart', restartSovereign)
    await verify('after restart')
    metrics.backendAfterRestart = (await json(`${base}/api/tasks/store-status`)).tasks.backend

    // ── ad4m lane: an AD4M outage ──────────────────────────────────────
    if (ad4mLane && status0.tasks.backend !== 'off') {
      run('stop ad4m')
      const t3 = await post(base, '/api/tasks', { name: `${tag} written while AD4M is down`, membrane: 'swt-forge' })
      await post(base, '/api/tasks/link', { parentId: stream.id, childId: t3.id })
      await sleep(1000)
      const down = await json(`${base}/api/tasks/store-status`)
      metrics.pendingWhileDown = down.tasks.pending
      check(down.tasks.pending >= 2, 'writes queue in the outbox while AD4M is down')

      await client.timed('restart-ad4m-down', restartSovereign)
      const t3After = await json(`${base}/api/tasks/${uuidOf(t3.id)}`).catch(() => null)
      check(t3After?.parentTasks?.[0]?.id === stream.id, 'restart with AD4M down keeps outbox writes')

      run('start ad4m')
      const deadline = Date.now() + 90000
      let st: any = null
      while (Date.now() < deadline) {
        st = await json(`${base}/api/tasks/store-status`)
        if (st.tasks.pending === 0 && st.tasks.backend === 'connected') break
        await sleep(2000)
      }
      metrics.afterAd4mBack = st?.tasks
      check(st?.tasks.pending === 0 && st?.tasks.backend === 'connected', 'outbox drains when AD4M returns')
      await verify('after AD4M outage')
    } else {
      metrics.ad4mOutage = 'skipped (base lane has no AD4M)'
    }

    // Clean up what can be removed (tasks have no delete; mark them cancelled).
    for (const id of [t1.id, t2.id, stream.id, planImport.task.id, ...(mcpTaskId ? [mcpTaskId] : [])]) {
      await patch(base, `/api/tasks/${uuidOf(id)}`, { state: 'cancelled' }).catch(() => {})
    }
    await fetch(`${base}/api/forge/views?membrane=swt-forge`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ views: [] })
    }).catch(() => {})
    await client.del('/api/membranes/swt-forge').catch(() => {})
    client.disconnectWs()
    await client.deleteThread(threadId).catch(() => {})

    const passed = failures.length === 0
    return {
      passed,
      summary: passed
        ? `tasks, stream, links, plan import (REST + MCP) and ordered views survived a restart (store backend: ${metrics.backendAfterRestart})${ad4mLane ? ' and an AD4M outage' : ''}`
        : `failed: ${failures.join('; ')}`,
      metrics: { ...metrics, failures },
      samples: client.samples
    }
  }
}
