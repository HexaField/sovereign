// S10: AD4M Waker — the full ad4m closed loop, in Sovereign's own suite.
//
// Only runs when the ad4m lane is active (docker-compose.ad4m.yml + the provision
// step, or explicit AD4M_* env). Otherwise it self-skips as a pass, so the core
// s1–s9 run is unaffected.
//
// Given a provisioned user + channel perspective (the same identity Sovereign's
// native waker connects as), this:
//   1. scripts the mock to answer any "mentioned you" turn with a
//      presence_reply_ad4m tool call (once — so the follow-up turn ends);
//   2. pins the perspective for the waker (POST /api/ad4m/watch/perspectives);
//   3. injects a real @mention on the node (has_child + message_body);
//   4. asserts the waker woke an act-capable presence turn (the mock saw the
//      mention AND was offered presence_reply_ad4m), and
//   5. asserts the reply write-back landed as a fresh channel child.
//
// This is the same bar the AD4M wind tunnel's A4 (Sovereign) route asserts, run
// inside Sovereign's own regression suite so a waker regression is caught here too.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
// @ts-expect-error — plain .mjs helper shared with the docker provision step
import { McpClient } from '../../ad4m/mcp-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROVISION = path.resolve(HERE, '../../ad4m/.provision/provision.json')
const MARKER = 'SWT_AD4M_REPLY_OK'
const REPLY_TOOL = 'mcp__sovereign__presence_reply_ad4m'

interface Provision {
  jwt: string
  did: string
  uuid: string
  channel: string
}

function loadProvision(): Provision | null {
  const file = process.env.AD4M_PROVISION_FILE || DEFAULT_PROVISION
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const p = JSON.parse(raw)
    if (p?.jwt && p?.uuid && p?.channel) return p
  } catch {
    /* lane not active */
  }
  return null
}

const skip = (summary: string): ScenarioResult => ({ passed: true, summary, metrics: { skipped: true }, samples: [] })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const s10Ad4mWaker: Scenario = {
  id: 's10',
  name: 'AD4M Waker',
  description: 'Native ad4m waker wakes the presence agent on a mention and its reply lands back in the channel',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const prov = loadProvision()
    if (!prov) return skip('skipped — ad4m lane not active (no provision manifest)')

    const mcpUrl = process.env.AD4M_MCP_URL || 'http://localhost:14561'
    const metrics: Record<string, unknown> = { uuid: prov.uuid, channel: prov.channel, mcpUrl }
    const mcp = new McpClient(mcpUrl, prov.jwt)
    // A stale manifest from a torn-down lane must not fail a plain run — if the
    // node is unreachable, the lane is not active, so skip.
    try {
      await mcp.initialize('swt-s10')
    } catch {
      return skip(`skipped — ad4m node unreachable at ${mcpUrl}`)
    }

    // 1. Script the mock: any "mentioned you" turn replies via presence_reply_ad4m (once).
    await client.timed('mock-script', () =>
      fetch(`${mockLlmUrl}/mock/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: 'mentioned you',
          once: true,
          toolUse: { id: 'toolu_s10', name: REPLY_TOOL, input: { text: `${MARKER} acknowledged the mention` } }
        })
      }).then((r) => r.json())
    )

    // 2. Pin the perspective for Sovereign's native waker.
    const watch = await client.timed('watch-perspective', () =>
      client.post('/api/ad4m/watch/perspectives', { uuid: prov.uuid, label: 's10' })
    )
    metrics.watch = watch
    // Let the waker register its mention subscription + baseline the (empty)
    // perspective, and let any boot/auto-start turns settle to idle before we
    // inject — so the presence turn runs alone and the in-server
    // `activeSessionKey` (which presence_reply_ad4m's internal-gate reads) is not
    // stomped by a concurrent turn.
    await sleep(4000)
    await waitForIdle(client)

    // 3. Inject a real @mention on the node (has_child + message_body literal).
    const msgAddr = `${prov.channel}/msg/1`
    const body = 'Hey Hex, please acknowledge this'
    const literal = `literal://string:${encodeURIComponent(body)}`
    await client.timed('inject-mention', async () => {
      await mcp.callToolJson('add_link', {
        perspective_id: prov.uuid,
        source: prov.channel,
        predicate: 'ad4m://has_child',
        target: msgAddr
      })
      await mcp.callToolJson('add_link', {
        perspective_id: prov.uuid,
        source: msgAddr,
        predicate: 'ad4m://message_body',
        target: literal
      })
    })

    // 4. Poll the mock log for an act-capable wake, and 5. the node for the reply.
    let woke = false
    let replyLanded = false
    for (let i = 0; i < 45; i++) {
      if (!woke) {
        const log = await fetch(`${mockLlmUrl}/mock/log`)
          .then((r) => r.json())
          .catch(() => [])
        woke = (Array.isArray(log) ? log : []).some((e: any) => {
          const msgs = JSON.stringify(e?.messages ?? '')
          const tools = JSON.stringify(e?.tools ?? '')
          return msgs.includes('mentioned you') && tools.includes('presence_reply_ad4m')
        })
      }
      if (woke && !replyLanded) {
        replyLanded = await channelHasReply(mcp, prov.uuid, prov.channel, MARKER)
        if (replyLanded) break
      }
      await sleep(3000)
    }

    metrics.wokeActCapableTurn = woke
    metrics.replyLanded = replyLanded

    if (!woke) {
      return {
        passed: false,
        summary: 'native waker did not wake an act-capable presence turn on the ad4m mention',
        metrics,
        samples: client.samples
      }
    }
    if (!replyLanded) {
      return {
        passed: false,
        summary: 'presence agent woke but its ad4m reply write-back did not land in the channel',
        metrics,
        samples: client.samples
      }
    }
    return {
      passed: true,
      summary: 'native waker woke the presence agent AND its presence_reply_ad4m write-back landed back in the channel',
      metrics,
      samples: client.samples
    }
  }
}

/** Wait until no thread reports an in-flight turn (or a timeout), so the
 *  presence turn runs alone and its session owns `activeSessionKey`. */
async function waitForIdle(client: any, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const threads = await client.listThreads({ includeArchived: true })
      const busy = (Array.isArray(threads) ? threads : []).some((t: any) =>
        ['working', 'thinking'].includes(String(t?.agentStatus ?? '').toLowerCase())
      )
      if (!busy) return
    } catch {
      /* transient — retry */
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
}

/** True when a child of `channel` carries the marker in its body. */
async function channelHasReply(mcp: any, uuid: string, channel: string, marker: string): Promise<boolean> {
  const kids = await mcp.callToolJson('query_links', { perspective_id: uuid, source: channel })
  const targets = [...new Set([...JSON.stringify(kids).matchAll(/"target":"([^"]+)"/g)].map((m) => m[1]))]
  for (const t of targets) {
    const links = await mcp.callToolJson('query_links', { perspective_id: uuid, source: t })
    if (JSON.stringify(links).includes(marker)) return true
  }
  return false
}
