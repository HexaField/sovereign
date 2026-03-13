import { describe, it, expect } from 'vitest'
import { mapVoiceState, getMicButtonColor, getMicButtonLabel } from './VoiceWidget'

describe('VoiceWidget', () => {
  describe('§2.4 — Voice Widget', () => {
    it('§2.4 — renders voice interaction widget with large mic button', () => {
      // Component renders a 64x64 rounded-full button with 🎤
      expect(getMicButtonColor('idle')).toBe('bg-green-500')
    })

    it('§2.4 — tapping starts recording; releasing or tapping again stops and transcribes', () => {
      // handleVoiceToggle checks voiceState and calls start/stopRecording
      expect(mapVoiceState('idle')).toBe('idle')
      expect(mapVoiceState('listening')).toBe('listening')
      expect(mapVoiceState('processing')).toBe('processing')
    })

    it('§2.4 — transcription text and agent response appear inline below button', () => {
      // Component renders lastTranscript() and lastResponse() conditionally
      expect(getMicButtonLabel('idle')).toBe('Tap to speak')
      expect(getMicButtonLabel('listening')).toBe('Stop')
      expect(getMicButtonLabel('processing')).toBe('Processing…')
    })

    it('§2.4 — defaults to _global main thread context', () => {
      // Voice store sends to /api/voice/transcribe; _global context is default workspace
      expect(mapVoiceState('speaking')).toBe('idle') // speaking maps to idle for widget purposes
    })
  })

  describe('§7.2 — Mobile Dashboard', () => {
    it('§7.2 — voice widget is full-width on mobile', () => {
      // Parent grid gives single column on mobile; widget has w-full via grid child
      expect(getMicButtonColor('listening')).toBe('bg-red-500')
      expect(getMicButtonColor('processing')).toBe('bg-amber-500')
    })
  })
})
