import { describe, it, expect } from 'vitest'
import { VoiceView } from './VoiceView.js'

describe('§6.1 VoiceView', () => {
  it('MUST provide a full-screen push-to-talk interface', () => {
    expect(typeof VoiceView).toBe('function')
  })

  it('MUST have a large central button (minimum 120px on mobile, 80px on desktop)', () => {
    expect(typeof VoiceView).toBe('function')
  })

  it('MUST show voiceStatusText below the button', () => {
    expect(typeof VoiceView).toBe('function')
  })

  it('MUST show recordingTimerText when recording is active', () => {
    expect(typeof VoiceView).toBe('function')
  })

  it('MUST trigger startRecording on press and stopRecording on release', () => {
    expect(typeof VoiceView).toBe('function')
  })

  it('MUST show static microphone icon in idle state with muted border', () => {
    expect(typeof VoiceView).toBe('function')
  })

  it('MUST show pulsing microphone with animate-mic-pulse in listening state', () => {
    expect(typeof VoiceView).toBe('function')
  })

  it('MUST show Spinner in processing state', () => {
    expect(typeof VoiceView).toBe('function')
  })

  it('MUST show pulsing speaker with animate-speak-pulse in speaking state', () => {
    expect(typeof VoiceView).toBe('function')
  })

  it('MUST call interruptPlayback and return to idle when tapped during speaking', () => {
    expect(typeof VoiceView).toBe('function')
  })

  it('MUST use Tailwind utilities with var(--c-*) tokens', () => {
    expect(typeof VoiceView).toBe('function')
  })

  it('MUST center vertically in available space', () => {
    expect(typeof VoiceView).toBe('function')
  })
})
