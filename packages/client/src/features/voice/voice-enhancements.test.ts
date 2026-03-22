import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('§P.7 Voice Enhancements', () => {
  it('§P.7 voice store exposes state transitions for transcription progress', async () => {
    const { voiceState, setVoiceState, voiceStatusText } = await import('./store.js')
    expect(voiceState()).toBe('idle')

    setVoiceState('processing')
    expect(voiceState()).toBe('processing')
    expect(voiceStatusText()).toBe('Processing…')

    setVoiceState('idle')
    expect(voiceStatusText()).toBe('Tap to speak')
  })

  it('§P.7 SHOULD implement speaker timeline visualization in recording view', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../meetings/SpeakerTimeline.tsx'),
      'utf-8'
    )
    expect(src).toContain('SpeakerTimeline')
  })
  it.todo('§P.7 SHOULD implement transcription progress polling')
})
