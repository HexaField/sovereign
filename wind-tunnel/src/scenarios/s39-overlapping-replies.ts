// S39: overlapping voice replies. Two threads answer voice messages at the
// same time, to the same device. Players queue whole replies by utterance id,
// so the server must tag every audio message with one:
//   - every audio message carries an utterance id;
//   - one utterance belongs to one thread and one kind (ack or summary);
//   - an utterance's chunks run 0..n in order and end with done.
// The reply streams may interleave on the wire — players untangle them.

import WebSocket from 'ws'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const NAME = 'WT-Overlap'
const NODE_UA = 'Python/3.14 websockets/15.0'

interface Audio {
  utterance?: string
  threadId: string
  kind: string
  chunk?: { index: number; done: boolean }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const s39OverlappingReplies: Scenario = {
  id: 's39',
  name: 'Overlapping Voice Replies',
  description: 'two replies at once reach one speaker tagged by utterance id, so players play each whole',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const script = (pattern: string, response: string) =>
      fetch(`${mockLlmUrl}/mock/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern, response })
      })
    await script('s39 overlap one', 'First reply speaking now. It has three sentences. This one ends it.')
    await script('s39 overlap two', 'Second reply here. It also runs long enough to stream. Done.')

    const threads = await Promise.all([
      client.createThread({ label: 'swt-s39-one' }),
      client.createThread({ label: 'swt-s39-two' })
    ])
    const ws = new WebSocket(client.baseUrl.replace(/^http/, 'ws') + '/ws', { headers: { 'User-Agent': NODE_UA } })
    const audio: Audio[] = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'voice.tts.audio' && msg.audio)
        audio.push({ utterance: msg.utterance, threadId: msg.threadId, kind: msg.kind, chunk: msg.chunk })
    })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'ws.device-name', deviceName: NAME, client: 'voice-node' }))
        resolve()
      })
      ws.on('error', reject)
    })
    await settle(200)

    const origin = { origin: { modality: 'voice', deviceName: NAME } }
    await Promise.all([
      client.sendMessage(threads[0].id, 'Please run the s39 overlap one', origin),
      client.sendMessage(threads[1].id, 'Please run the s39 overlap two', origin)
    ])

    // Wait until both threads' summaries finish (the last chunk, or an unchunked clip).
    const ended = (threadId: string) =>
      audio.some((a) => a.threadId === threadId && a.kind === 'summary' && (!a.chunk || a.chunk.done))
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline && !threads.every((t) => ended(t.id))) await settle(250)
    await settle(1_000)
    ws.close()
    for (const t of threads) await client.deleteThread(t.id).catch(() => {})

    const problems: string[] = []
    if (!threads.every((t) => ended(t.id))) problems.push('a summary never finished')
    const byUtterance = new Map<string, Audio[]>()
    for (const a of audio) {
      if (!a.utterance) {
        problems.push(`audio without utterance id (${a.threadId} ${a.kind})`)
        continue
      }
      byUtterance.set(a.utterance, [...(byUtterance.get(a.utterance) ?? []), a])
    }
    for (const [id, clips] of byUtterance) {
      const owners = new Set(clips.map((c) => `${c.threadId}:${c.kind}`))
      if (owners.size !== 1) problems.push(`utterance ${id.slice(0, 8)} spans ${[...owners].join(', ')}`)
      const chunked = clips.filter((c) => c.chunk)
      if (chunked.length) {
        const indices = chunked.map((c) => c.chunk!.index)
        if (indices.some((n, i) => n !== i))
          problems.push(`utterance ${id.slice(0, 8)} chunks out of order: ${indices}`)
        if (!chunked[chunked.length - 1].chunk!.done) problems.push(`utterance ${id.slice(0, 8)} never ends`)
      }
    }
    const summaries = new Set(audio.filter((a) => a.kind === 'summary').map((a) => a.utterance))
    if (summaries.size < 2) problems.push(`expected 2 summary utterances, got ${summaries.size}`)
    // Did the two streams interleave on the wire? Informational: it varies with timing.
    const order = audio.map((a) => a.utterance)
    const interleaved = order.some((u, i) => i > 0 && u !== order[i - 1] && order.slice(i + 1).includes(order[i - 1]))

    const metrics = { clips: audio.length, utterances: byUtterance.size, interleaved }
    const passed = problems.length === 0
    return {
      passed,
      summary: passed
        ? `${audio.length} clips in ${byUtterance.size} utterances, each owned by one reply and in order (interleaved on the wire: ${interleaved})`
        : problems.join('; '),
      metrics,
      samples: client.samples
    }
  }
}
