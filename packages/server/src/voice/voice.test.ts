import { describe, it } from 'vitest'

describe('§6.4 Voice Module (Server)', () => {
  it.todo('MUST accept audio blob via POST /api/voice/transcribe (multipart/form-data)')
  it.todo('MUST proxy audio to configured transcription service URL (voice.transcribeUrl)')
  it.todo('MUST return { text: string } from transcription endpoint')
  it.todo('MUST return 503 if no transcription URL is configured')
  it.todo('MUST accept { text, voice? } via POST /api/voice/tts')
  it.todo('MUST proxy text to configured TTS service URL (voice.ttsUrl)')
  it.todo('MUST return audio blob with appropriate Content-Type')
  it.todo('MUST return 503 if no TTS URL is configured')
  it.todo('MUST support hot-reload of voice.transcribeUrl config value')
  it.todo('MUST support hot-reload of voice.ttsUrl config value')
  it.todo('MUST emit voice.transcription.completed bus event with { text, durationMs }')
  it.todo('MUST emit voice.tts.completed bus event with { text, durationMs }')
})
