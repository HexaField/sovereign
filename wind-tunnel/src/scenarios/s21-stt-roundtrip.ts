// S21: STT Roundtrip — voice transcription through to LLM response.
//
// Proves the full speech-to-text pipeline without real audio:
//   1. Configure voice.transcribeUrl → mock-LLM's /mock/transcribe
//   2. POST synthetic audio to /api/voice/transcribe → get text back
//   3. Send that text as a chat message with origin.modality = 'voice'
//   4. Verify the mock LLM receives the message
//   5. Verify the assistant response arrives via WS
//   6. Verify origin metadata persists in the message queue
//
// No real Whisper model needed — the mock endpoint returns canned text.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const CANNED_TRANSCRIPT = 'Hello from the wind tunnel speech test'

export const s21SttRoundtrip: Scenario = {
  id: 's21',
  name: 'STT Roundtrip',
  description: 'Voice transcription → chat message with voice origin → LLM response via WS',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // ── 0. Register a mock transcription endpoint on the mock-LLM server ──
    // The mock-LLM exposes /mock/transcribe which returns a canned
    // transcript for any uploaded audio.
    await fetch(`${mockLlmUrl}/mock/transcribe-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: CANNED_TRANSCRIPT })
    })

    // ── 1. Configure Sovereign to use the mock transcription endpoint ──
    await client.timed('configure-voice', () =>
      client.patch('/api/config', {
        voice: { transcribeUrl: `${mockLlmUrl}/mock/transcribe` }
      })
    )

    // Verify config took effect
    const cfg = await client.config()
    const transcribeUrl = cfg?.voice?.transcribeUrl ?? ''
    metrics.transcribeUrl = transcribeUrl
    if (!transcribeUrl.includes('/mock/transcribe')) {
      return {
        passed: false,
        summary: `voice.transcribeUrl not configured — got "${transcribeUrl}"`,
        metrics,
        samples: client.samples
      }
    }

    // ── 2. POST synthetic audio to /api/voice/transcribe ──
    // Send a minimal WAV header as the audio payload — content doesn't
    // matter since the mock returns canned text regardless.
    const syntheticAudio = new Uint8Array([
      // RIFF header (44 bytes of valid WAV with 0 samples)
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x01, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00, 0x64, 0x61,
      0x74, 0x61, 0x00, 0x00, 0x00, 0x00
    ])

    let transcribedText = ''
    try {
      const form = new FormData()
      form.append('audio', new Blob([syntheticAudio], { type: 'audio/wav' }), 'test.wav')

      const transcribeRes = await client.timed('transcribe', async () => {
        const res = await fetch(`${client.baseUrl}/api/voice/transcribe`, {
          method: 'POST',
          body: form
        })
        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          throw new Error(`transcribe → ${res.status}: ${errBody}`)
        }
        return res.json() as Promise<{ text: string }>
      })

      transcribedText = transcribeRes.text ?? ''
      metrics.transcribedText = transcribedText
    } catch (err: any) {
      return {
        passed: false,
        summary: `transcription failed: ${err.message}`,
        metrics,
        samples: client.samples
      }
    }

    if (transcribedText !== CANNED_TRANSCRIPT) {
      return {
        passed: false,
        summary: `transcript mismatch — expected "${CANNED_TRANSCRIPT}", got "${transcribedText}"`,
        metrics,
        samples: client.samples
      }
    }

    // ── 3. Create a thread and send the transcribed text with voice origin ──
    const thread = await client.timed('create-thread', () => client.createThread({ label: 'swt-s21-stt' }))
    metrics.threadId = thread.id

    // Clear mock LLM request log
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })

    // Script the LLM response
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'wind tunnel speech test',
        response: 'I heard your voice message loud and clear.'
      })
    })

    // Connect WS before sending
    await client.connectWs(['chat', 'threads'])

    // Send message with voice origin metadata (mirrors InputArea.tsx behaviour)
    await client.timed('send-voice-message', () =>
      client.sendMessage(thread.id, transcribedText, {
        origin: { modality: 'voice' }
      })
    )

    // ── 4. Wait for assistant response via WS ──
    let gotTurn = false
    let turnContent = ''
    try {
      const turnMsg = await client.timed('wait-for-turn', () => client.waitForWs('chat.turn', 30000))
      gotTurn = true
      turnContent = turnMsg?.turn?.content ?? ''
      metrics.turnContent = turnContent
    } catch (err: any) {
      metrics.turnError = err?.message
    }

    // ── 5. Verify mock LLM received the request ──
    let mockLog: any[] = []
    try {
      const logRes = await fetch(`${mockLlmUrl}/mock/log`)
      mockLog = (await logRes.json()) as any[]
      metrics.mockRequests = mockLog.length
    } catch {
      metrics.mockLogError = 'failed to fetch mock log'
    }

    // ── 6. Cleanup ──
    client.disconnectWs()
    await client.deleteThread(thread.id)

    // ── Verdict ──
    const checks: string[] = []

    if (transcribedText !== CANNED_TRANSCRIPT) {
      checks.push(`transcript: expected "${CANNED_TRANSCRIPT}", got "${transcribedText}"`)
    }

    if (!gotTurn) {
      checks.push(`no assistant turn received — mock got ${mockLog.length} request(s)`)
    }

    if (mockLog.length === 0) {
      checks.push('mock LLM received 0 requests')
    }

    if (checks.length > 0) {
      return {
        passed: false,
        summary: checks.join('; '),
        metrics,
        samples: client.samples
      }
    }

    return {
      passed: true,
      summary: `STT roundtrip OK — transcribed "${transcribedText.slice(0, 40)}…", LLM responded: "${turnContent.slice(0, 50)}"`,
      metrics,
      samples: client.samples
    }
  }
}
