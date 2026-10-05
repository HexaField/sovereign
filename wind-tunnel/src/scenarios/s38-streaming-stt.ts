// S38: streaming speech-to-text — the path that fills the dictation draft
// bubble. A client opens a voice-stream session over WS, sends audio chunks
// and stops; the server transcribes (mock /transcribe) and sends
// voice-stream.transcript events back, the last one final. The client turns
// those into the outlined draft bubble in the thread (VoiceDraftBubble).

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const TEXT = 'please summarise the build status for me'

export const s38StreamingStt: Scenario = {
  id: 's38',
  name: 'Streaming STT',
  description: 'voice-stream chunks → interim and final transcripts over WS',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}
    await fetch(`${mockLlmUrl}/mock/transcribe-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: TEXT })
    })
    await client.connectWs(['voice-stream'])

    client.wsSend({ type: 'voice-stream.start' })
    // Enough bytes for an interim transcription (the server waits for 2000 new bytes).
    const chunk = Buffer.alloc(3000, 1).toString('base64')
    for (let i = 0; i < 3; i++) client.wsSend({ type: 'voice-stream.chunk', audio: chunk })

    const interim = await client
      .timed('interim', () => client.waitForWs('voice-stream.transcript', 15_000, (m) => m.final === false))
      .catch(() => null)
    client.wsSend({ type: 'voice-stream.stop' })
    const final = await client
      .timed('final', () => client.waitForWs('voice-stream.transcript', 15_000, (m) => m.final === true))
      .catch(() => null)
    const errors = client.drainWs('voice-stream.error')
    client.disconnectWs()

    metrics.interim = interim?.text ?? null
    metrics.final = final?.text ?? null
    metrics.errors = errors.map((e: any) => e.message)

    const passed = interim?.text === TEXT && final?.text === TEXT && errors.length === 0
    return {
      passed,
      summary: passed
        ? `interim and final transcripts arrived: "${TEXT}"`
        : `interim=${JSON.stringify(interim?.text)} final=${JSON.stringify(final?.text)} errors=${JSON.stringify(metrics.errors)}`,
      metrics,
      samples: client.samples
    }
  }
}
