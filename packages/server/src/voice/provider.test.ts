import { describe, it } from 'vitest'

describe('§8.1.2 Voice Module Provider Adapter', () => {
  it.todo(
    '§8.1.2 MUST adapt VoiceModule.transcribe() into a TranscriptionProvider via createVoiceTranscriptionProvider'
  )
  it.todo('§8.1.2 available() MUST return true only when voice module has transcription URL configured')
  it.todo('§8.1.2 MUST report diarization: false unless configured endpoint supports it')
  it.todo('§8.1.2 SHOULD allow future providers to slot in without changing the pipeline')
})
