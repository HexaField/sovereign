// On-demand TTS — calls the server to summarise + synthesise text,
// then plays the returned audio through the Web Audio API.
// Used by the "Play aloud" context menu item on assistant messages.

import { playBase64Audio } from './tts-player.js'

export interface SpeakResult {
  spokenText: string
  durationMs: number
}

/** Summarise and speak the given text via the server TTS pipeline.
 *  Throws on network/server errors. */
export async function speakText(text: string): Promise<SpeakResult> {
  const res = await fetch('/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error || `TTS failed (${res.status})`)
  }

  const data = (await res.json()) as { audio: string; spokenText: string; durationMs: number }
  await playBase64Audio(data.audio)

  return { spokenText: data.spokenText, durationMs: data.durationMs }
}
