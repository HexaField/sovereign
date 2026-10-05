// S40: push-to-talk streaming from a voice node. The node (no screen)
// streams raw PCM over voice-stream with deliver: 'presence'. A browser tab
// sharing the node's device name must see the live text as a draft for the
// presence thread; on stop the server sends the final text to the presence
// thread itself and clears the draft.

import WebSocket from 'ws'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const NAME = 'WT-PTT'
const TEXT = 'turn the workshop lights on please'

function open(baseUrl: string, userAgent: string, onMessage: (msg: any) => void): Promise<WebSocket> {
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws', { headers: { 'User-Agent': userAgent } })
  ws.on('message', (raw) => onMessage(JSON.parse(raw.toString())))
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'ws.device-name', deviceName: NAME }))
      resolve(ws)
    })
    ws.on('error', reject)
  })
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const s40PttStream: Scenario = {
  id: 's40',
  name: 'Push-to-talk Stream',
  description: 'a voice node streams PCM; same-name tabs see a live draft; the final text lands in presence',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    await fetch(`${mockLlmUrl}/mock/transcribe-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: TEXT })
    })
    const presence = await client.presenceThreads()
    const gatewayId: string | undefined = presence?.gateway?.id
    if (!gatewayId)
      return { passed: false, summary: 'no presence gateway thread', metrics: {}, samples: client.samples }

    const drafts: Array<{ threadId: string; text: string; done: boolean }> = []
    const tab = await open(client.baseUrl, 'Mozilla/5.0 WindTunnel', (msg) => {
      if (msg.type === 'voice-stream.draft') drafts.push({ threadId: msg.threadId, text: msg.text, done: msg.done })
    })
    const finals: string[] = []
    const node = await open(client.baseUrl, 'Python/3.14 websockets/15.0', (msg) => {
      if (msg.type === 'voice-stream.transcript' && msg.final) finals.push(msg.text)
    })
    node.send(JSON.stringify({ type: 'subscribe', channels: ['voice-stream'] }))
    await settle(200)

    // 2 s of PCM in 80 ms frames, as the node sends while the keys stay held.
    node.send(JSON.stringify({ type: 'voice-stream.start', format: 'pcm16', sampleRate: 16000, deliver: 'presence' }))
    const frame = Buffer.alloc(1280 * 2, 3).toString('base64')
    for (let i = 0; i < 25; i++) {
      node.send(JSON.stringify({ type: 'voice-stream.chunk', audio: frame }))
      await settle(80)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !drafts.some((d) => d.text === TEXT)) await settle(200)
    const liveDraft = drafts.some((d) => !d.done && d.text === TEXT && d.threadId === gatewayId)

    node.send(JSON.stringify({ type: 'voice-stream.stop' }))
    const end = Date.now() + 15_000
    while (Date.now() < end && !drafts.some((d) => d.done)) await settle(200)
    const cleared = drafts[drafts.length - 1]?.done === true

    // The turn reaches the thread's history a moment after the send.
    let delivered = false
    for (const until = Date.now() + 10_000; !delivered && Date.now() < until; await settle(250)) {
      delivered = JSON.stringify(await client.threadHistory(gatewayId).catch(() => null)).includes(TEXT)
    }
    tab.close()
    node.close()

    const metrics = { drafts: drafts.length, liveDraft, cleared, delivered, finals }
    const passed = liveDraft && cleared && delivered && finals[0] === TEXT
    return {
      passed,
      summary: passed
        ? `${drafts.length} draft updates reached the tab for the presence thread; final text delivered there; draft cleared`
        : `liveDraft=${liveDraft} cleared=${cleared} delivered=${delivered} finals=${JSON.stringify(finals)}`,
      metrics,
      samples: client.samples
    }
  }
}
