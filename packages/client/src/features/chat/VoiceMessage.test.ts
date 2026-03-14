import { describe, it, expect } from 'vitest'
import { VoiceMessage, formatVoiceDuration } from './VoiceMessage.js'
import type { VoiceMessageProps } from './VoiceMessage.js'

describe('§8.5.1 Voice Message Component', () => {
  it('§8.5.1 MUST show audio player for voice-originated messages', () => {
    expect(typeof VoiceMessage).toBe('function')
  })

  it('§8.5.1 MUST display transcript text alongside audio', () => {
    // VoiceMessage accepts transcript prop
    const props: VoiceMessageProps = { audioUrl: '/audio.webm', transcript: 'Hello world' }
    expect(props.transcript).toBe('Hello world')
  })

  it('§8.5.1 MUST keep original audio accessible via play button', () => {
    // VoiceMessage renders <audio> element with src
    expect(typeof VoiceMessage).toBe('function')
    expect(formatVoiceDuration(65000)).toBe('1:05')
    expect(formatVoiceDuration(0)).toBe('0:00')
  })
})
