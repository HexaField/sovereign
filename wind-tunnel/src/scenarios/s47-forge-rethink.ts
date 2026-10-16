// S47: Forge Loop 2 (rethink) end to end against the mock GitHub and the
// mock LLM. A membrane "forge-rt" gets one mock repo (PATCH /api/config); an
// owned change goes CI-red; POST /api/forge/rethink then has to: find or make
// the membrane's forge-rethink thread, send it the digest prompt (seen at the
// mock LLM), and write a run report listed by /api/forge/rethink/runs. The
// mock answers the prompt with a forge_relate call (a dashed `rethink` edge
// in the graph); a chat message in the rethink thread gets a forge_note call
// (a note on the card, in a "chat" run). A second rethink with nothing new
// is skipped.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import { waitForThreadIdle } from '../wait.js'

const M = 'forge-rt'
const R = 'acme-labs/sprocket'
const id = (n: number) => `github:github.com/${R}#${n}`
const SHA = (c: string) => c.repeat(40)
const RELATE_ID = 'toolu_s47_forge_relate'
const NOTE_ID = 'toolu_s47_forge_note'

const SEED = {
  viewer: 'hex-agent',
  repos: [
    {
      repo: R,
      defaultBranch: 'main',
      branches: [
        { name: 'feat/teeth', sha: SHA('a'), ahead: 2, behind: 0 },
        { name: 'feat/axle', sha: SHA('b'), ahead: 1, behind: 0 }
      ],
      pulls: [
        {
          number: 1,
          title: 'Sprocket teeth',
          head: 'feat/teeth',
          base: 'main',
          author: 'alex-dev',
          mergeable: 'MERGEABLE'
        },
        {
          number: 2,
          title: 'Sprocket axle',
          head: 'feat/axle',
          base: 'main',
          author: 'alex-dev',
          mergeable: 'MERGEABLE'
        }
      ],
      checks: [{ sha: SHA('a'), runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }]
    }
  ]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function mockLog(mockLlmUrl: string): Promise<any[]> {
  return (await (await fetch(`${mockLlmUrl}/mock/log`)).json()) as any[]
}

/** The text of the tool_result for `toolUseId`, once the SDK echoes it back. */
async function toolResult(mockLlmUrl: string, toolUseId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const entry of await mockLog(mockLlmUrl)) {
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

export const s47ForgeRethink: Scenario = {
  id: 's47',
  name: 'Forge Rethink',
  description:
    'Loop 2: CI red on an owned change → rethink thread + digest prompt + run report; forge_relate/forge_note tools; empty digest skips',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const mock = ctx.mockGithubUrl
    const problems: string[] = []
    const metrics: Record<string, unknown> = {}
    const check = (ok: boolean, what: string) => {
      if (!ok) problems.push(what)
    }
    const control = async (action: string, body?: unknown) => {
      const res = await fetch(`${mock}/mock/github/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
      if (!res.ok) throw new Error(`mock ${action} → ${res.status} ${await res.text()}`)
      return res.json() as Promise<any>
    }
    const script = (body: Record<string, unknown>) =>
      fetch(`${mockLlmUrl}/mock/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    const sync = () => client.timed('forge-sync', () => client.post(`/api/forge/sync?membrane=${M}`))
    const graph = () => client.get(`/api/forge?membrane=${M}`)
    const runs = () => client.get(`/api/forge/rethink/runs?membrane=${M}`)
    const untilRunEnds = async (ms: number) => {
      const end = Date.now() + ms
      let r = await runs()
      while (r.active && Date.now() < end) {
        await sleep(250)
        r = await runs()
      }
      return r
    }

    const threads: string[] = []
    await control('reset')
    await control('seed', SEED)
    await client.patch('/api/config', { forge: { repos: { [M]: [R] } } })
    if (!(await client.membranes()).some((m: any) => m.id === M)) {
      await client.post('/api/membranes', { id: M, name: 'Forge rethink wind tunnel', workspaceIds: [] })
    }

    try {
      // ── 1. An owned change goes CI-red ──────────────────────────────
      await sync()
      const owner = await client.createThread({ label: 'S47 sprocket owner', membraneId: M })
      threads.push(owner.id)
      await client.post('/api/forge/assign', { nodeId: id(1), threadId: owner.id })
      await control('checks', {
        repo: R,
        pr: 1,
        runs: [{ name: 'integration-tests', status: 'completed', conclusion: 'failure' }]
      })
      await sync()
      const digest = await client.get(`/api/forge/digest?membrane=${M}`)
      metrics.digestCount = digest.count
      check(digest.count >= 1, `digest has the CI failure (count ${digest.count})`)
      await waitForThreadIdle(client, owner.id, 20000).catch(() => false)

      // ── 2. Rethink now: thread, prompt, report ────────────────────────
      await script({
        pattern: `Forge rethink . ${M} . run`,
        once: true,
        needsTools: true,
        toolUse: {
          id: RELATE_ID,
          name: 'mcp__sovereign__forge_relate',
          input: { membrane: M, from: id(1), to: id(2), reason: 's47: both sprocket parts', confidence: 0.75 }
        }
      })
      const started = await client.timed('forge-rethink', () => client.post(`/api/forge/rethink?membrane=${M}`))
      metrics.started = started
      check(started.ran === true && typeof started.runId === 'string', `rethink started: ${JSON.stringify(started)}`)

      let list = await runs()
      const rethinkThread: string | null = list.threadId
      if (rethinkThread) threads.push(rethinkThread)
      const t = rethinkThread ? await client.getThread(rethinkThread).catch(() => null) : null
      check(
        t?.label === 'forge-rethink' && t?.membraneId === M,
        `forge-rethink thread ${JSON.stringify(t && { label: t.label, membraneId: t.membraneId })}`
      )

      let prompted = false
      for (let i = 0; i < 80 && !prompted; i++) {
        const log = JSON.stringify(await mockLog(mockLlmUrl))
        prompted = log.includes(`[Forge rethink · ${M} · run ${started.runId}]`) && log.includes(id(1))
        if (!prompted) await sleep(250)
      }
      check(prompted, 'the mock LLM received the digest prompt')

      const relateResult = await client.timed('forge-relate', () => toolResult(mockLlmUrl, RELATE_ID, 30000))
      metrics.relateResult = relateResult?.slice(0, 160) ?? null
      check(Boolean(relateResult?.includes('"added": true')), `forge_relate result: ${relateResult?.slice(0, 160)}`)

      list = await untilRunEnds(30000)
      const run = list.runs.find((r: any) => r.id === started.runId)
      metrics.run = run
      check(run?.status === 'done', `run ${started.runId} status ${run?.status}`)
      check(run?.actions?.relate === 1, `run counts one relate (${JSON.stringify(run?.actions)})`)
      const md = await fetch(`${ctx.sovereignUrl}/api/forge/rethink/runs/${started.runId}?membrane=${M}`).then((r) =>
        r.text()
      )
      check(md.includes(`# Forge rethink — ${M} — ${started.runId}`), 'run report heading')
      check(md.includes('### Related edges') && md.includes('s47: both sprocket parts'), 'run report lists the edge')

      let g = await graph()
      const edge = g.edges.find((e: any) => e.kind === 'related' && e.from === id(1) && e.to === id(2))
      check(edge?.source === 'rethink' && edge?.dashed === true, `related edge ${JSON.stringify(edge)}`)

      // ── 3. Nothing new: skipped ─────────────────────────────────────
      const again = await client.post(`/api/forge/rethink?membrane=${M}`)
      check(again.ran === false && again.count === 0, `empty digest skipped: ${JSON.stringify(again)}`)

      // ── 4. A forge_note from a chat turn in the rethink thread ─────────
      if (rethinkThread) {
        await script({
          pattern: 's47-note',
          once: true,
          needsTools: true,
          toolUse: {
            id: NOTE_ID,
            name: 'mcp__sovereign__forge_note',
            input: { membrane: M, nodeId: id(2), text: 's47: axle waits for teeth' }
          }
        })
        await client.sendMessage(rethinkThread, 's47-note: note the axle')
        const noteResult = await client.timed('forge-note', () => toolResult(mockLlmUrl, NOTE_ID, 30000))
        check(Boolean(noteResult?.includes('"noted": true')), `forge_note result: ${noteResult?.slice(0, 160)}`)
        await waitForThreadIdle(client, rethinkThread, 20000).catch(() => false)
        g = await graph()
        const notes = g.nodes.find((n: any) => n.id === id(2))?.rethink ?? []
        check(
          notes.some((n: any) => n.kind === 'note' && n.text === 's47: axle waits for teeth'),
          `note on #2: ${JSON.stringify(notes)}`
        )
        list = await untilRunEnds(20000)
        check(
          list.runs.some((r: any) => r.trigger === 'chat' && r.actions?.note === 1),
          'the note landed in a chat run'
        )
        metrics.runs = list.runs.map((r: any) => `${r.id}:${r.trigger}:${r.status}`)
      }
    } finally {
      for (const th of threads) await client.deleteThread(th).catch(() => undefined)
      await client.patch('/api/config', { forge: { repos: { [M]: [] } } }).catch(() => undefined)
      await client.del(`/api/membranes/${M}`).catch(() => undefined)
    }

    return {
      passed: problems.length === 0,
      summary: problems.length
        ? `${problems.length} problem(s): ${problems.slice(0, 4).join('; ')}`
        : 'rethink thread, digest prompt, run report, forge_relate edge, forge_note, empty-digest skip',
      metrics: { ...metrics, problems },
      samples: client.samples.filter((s) => s.name.startsWith('forge'))
    }
  }
}
