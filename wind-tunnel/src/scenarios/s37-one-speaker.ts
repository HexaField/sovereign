// S37: one speaker per device name. Several connections announce the same
// device name (two browser tabs, later a voice node). A voice reply must
// play on exactly one of them; the others get the reply without audio.
//   1. Two tabs; tab A reports ws.active → only tab A gets audio.
//   2. A voice node joins under the name → only the voice node gets audio.
// Every audio message of one reply must land on the same connection.

import WebSocket from 'ws'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const NAME = 'WT-Mac'
const BROWSER_UA = 'Mozilla/5.0 (Macintosh) WindTunnel'
const NODE_UA = 'Python/3.14 websockets/15.0'

interface Conn {
  label: string
  ws: WebSocket
  /** The kind ('ack' | 'summary') of each audio message this connection got. */
  audio: string[]
  silent: number
}

function open(baseUrl: string, label: string, userAgent: string): Promise<Conn> {
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws', { headers: { 'User-Agent': userAgent } })
  const conn: Conn = { label, ws, audio: [], silent: 0 }
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.type !== 'voice.tts.audio') return
    if (msg.audio) conn.audio.push(msg.kind)
    else conn.silent++
  })
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', channels: ['chat'] }))
      ws.send(JSON.stringify({ type: 'ws.device-name', deviceName: NAME }))
      resolve(conn)
    })
    ws.on('error', reject)
  })
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Send a voice message and wait until the reply's summary audio has landed somewhere. */
async function voiceTurn(ctx: ScenarioContext, threadId: string, text: string, conns: Conn[]): Promise<boolean> {
  const before = conns.reduce((n, c) => n + c.audio.length + c.silent, 0)
  await ctx.client.sendMessage(threadId, text, { origin: { modality: 'voice', deviceName: NAME } })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const summaries = conns.flatMap((c) => c.audio).filter((kind) => kind === 'summary').length
    if (summaries > 0 && conns.reduce((n, c) => n + c.audio.length + c.silent, 0) > before) {
      await settle(2_000) // let the rest of the reply's chunks land
      return true
    }
    await settle(250)
  }
  return false
}

export const s37OneSpeaker: Scenario = {
  id: 's37',
  name: 'One Speaker Per Device',
  description: 'voice replies play on one connection per device name: the active tab, or a voice node',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's37 speaker',
        response: 'The speaker check passed. Only one device spoke this reply. All other tabs stayed quiet.'
      })
    })
    const thread = await client.createThread({ label: 'swt-s37-one-speaker' })
    const tabA = await open(client.baseUrl, 'tabA', BROWSER_UA)
    const tabB = await open(client.baseUrl, 'tabB', BROWSER_UA)
    const conns = [tabA, tabB]
    const finish = async (result: ScenarioResult) => {
      for (const c of conns) c.ws.close()
      await client.deleteThread(thread.id).catch(() => {})
      return result
    }
    await settle(200)
    tabA.ws.send(JSON.stringify({ type: 'ws.active' }))
    await settle(200)

    // Phase 1: two tabs, tab A active.
    const phase1 = await voiceTurn(ctx, thread.id, 'Please run the s37 speaker check one', conns)
    const p1 = conns.map((c) => ({ label: c.label, audio: c.audio.length, silent: c.silent }))
    metrics.phase1 = p1
    const phase1Ok = phase1 && tabA.audio.length > 0 && tabB.audio.length === 0 && tabB.silent > 0

    // Phase 2: a voice node joins under the same name.
    for (const c of conns) {
      c.audio.length = 0
      c.silent = 0
    }
    const node = await open(client.baseUrl, 'node', NODE_UA)
    conns.push(node)
    await settle(200)
    const phase2 = await voiceTurn(ctx, thread.id, 'Please run the s37 speaker check two', conns)
    metrics.phase2 = conns.map((c) => ({ label: c.label, audio: c.audio.length, silent: c.silent }))
    const phase2Ok = phase2 && node.audio.length > 0 && tabA.audio.length === 0 && tabB.audio.length === 0

    const passed = phase1Ok && phase2Ok
    return finish({
      passed,
      summary: passed
        ? `one speaker each time: active tab A (${p1[0].audio} clips; B text-only), then the voice node (${node.audio.length} clips)`
        : `phase1 ${phase1Ok ? 'ok' : 'FAIL'} ${JSON.stringify(metrics.phase1)}; phase2 ${phase2Ok ? 'ok' : 'FAIL'} ${JSON.stringify(metrics.phase2)}`,
      metrics,
      samples: client.samples
    })
  }
}
